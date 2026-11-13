import type { SqlRunnerModule } from '@bobsled-inc/connections';
import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import { LEGACY_METADATA_TABLES } from './legacy-names.js';
import {
  escapeLiteral,
  isMissingTableError,
  quoteIdentifier,
  safeInteger,
  tableRef,
  validateIdentifier,
  type SqlDialect,
} from './sql-utils.js';

export type CursorType = 'string' | 'number' | 'integer' | 'timestamp' | 'lsn';
export type SnapshotKind = 'canonical' | 'limited';

export interface MetadataRow {
  source_name: string;
  filter_hash: string;
  loaded_at: string;
  record_count: number;
  etag?: string;
  cursor_field?: string;
  cursor_type?: CursorType;
  cursor_value?: string;
  snapshot_kind?: SnapshotKind;
  snapshot_variant?: string | null;
  row_count?: number;
  in_progress_until?: string | null;
}

export type MetadataDialect = SqlDialect;

export const METADATA_TABLE = '_dogsled_source_metadata';
export const LEASE_PLACEHOLDER_LOADED_AT = '1970-01-01T00:00:00.000Z';

function metaTableRef(schema: string, dialect: MetadataDialect = 'duckdb'): string {
  return tableRef(schema, METADATA_TABLE, dialect);
}

function metadataColumnTypes(dialect: MetadataDialect): {
  stringType: string;
  timestampType: string;
  integerType: string;
} {
  if (dialect === 'bigquery') {
    return {
      stringType: 'STRING',
      timestampType: 'TIMESTAMP',
      integerType: 'INT64',
    };
  }
  return {
    stringType: 'VARCHAR',
    timestampType: 'TIMESTAMP',
    integerType: 'BIGINT',
  };
}

function timestampLiteral(value: string, dialect: MetadataDialect = 'duckdb'): string {
  const escaped = escapeLiteral(value);
  return dialect === 'bigquery' ? `TIMESTAMP('${escaped}')` : `TIMESTAMP '${escaped}'`;
}

function nullableStringLiteral(value: string | undefined | null): string {
  return value === undefined || value === null ? 'NULL' : `'${escapeLiteral(value)}'`;
}

function nullableTimestampLiteral(
  value: string | undefined | null,
  dialect: MetadataDialect = 'duckdb'
): string {
  return value === undefined || value === null ? 'NULL' : timestampLiteral(value, dialect);
}

function queryRows(runner: SqlRunnerModule, sql: string): Promise<Array<Record<string, unknown>>> {
  if (!runner.query) {
    throw new CommandError('SQL runner does not support query execution', 1);
  }
  return runner.query(sql);
}

function normalizeLoadedAt(value: unknown): string {
  // Dogsled always writes `loaded_at` as a UTC ISO-8601 string (see upsertRow in
  // materializer.ts, which passes `new Date().toISOString()`). Some dialects —
  // DuckDB, SQLite — strip the trailing `Z` when storing TIMESTAMP, so a
  // timezone-less round-trip means UTC by contract, not local time.
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  if (!match) {
    const parsedMs = Date.parse(text);
    if (Number.isNaN(parsedMs)) {
      throw new CommandError(`Unparseable loaded_at timestamp from metadata: ${text}`, 1);
    }
    return new Date(parsedMs).toISOString();
  }

  const millis = match[3] ? match[3].slice(1).padEnd(3, '0').slice(0, 3) : '000';
  return `${match[1]}T${match[2]}.${millis}Z`;
}

export function isLeasePlaceholderMetadataRow(row: MetadataRow): boolean {
  return (
    normalizeLoadedAt(row.loaded_at) === LEASE_PLACEHOLDER_LOADED_AT &&
    row.record_count === 0 &&
    (row.row_count ?? row.record_count) === 0 &&
    row.etag === undefined &&
    row.cursor_field === undefined &&
    row.cursor_type === undefined &&
    row.cursor_value === undefined
  );
}

async function tableExists(runner: SqlRunnerModule, ref: string): Promise<boolean> {
  try {
    const probe = `SELECT 1 FROM ${ref} WHERE 1 = 0`;
    await (runner.query ? runner.query(probe) : runner.run(probe));
    return true;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

/**
 * Take over an earlier metadata table (for example `_dogsled_source_metadata`
 * once Core writes `_bobsled_source_metadata`) by renaming it in place, so
 * cursors, ETags and snapshot leases survive. Never drops a table: when both
 * exist the current one wins and the earlier one is left alone.
 */
const settledByRunner = new WeakMap<SqlRunnerModule, Set<string>>();
/** Destinations settled in this process, so a query on a new connection adds no probe. */
const settledDestinations = new Set<string>();

export async function adoptLegacyMetadataTable(args: {
  runner: SqlRunnerModule;
  schema: string;
  dialect: MetadataDialect;
  /** Names the warehouse (never a credential). With it, a schema is settled once per process;
   * without it, once per connection. */
  destination?: string | undefined;
}): Promise<string | undefined> {
  if (args.dialect === 'duckdb' && args.schema === 'temp') return undefined;
  const legacy = LEGACY_METADATA_TABLES.filter((name) => name !== METADATA_TABLE);
  if (legacy.length === 0) return undefined;
  let settled = settledDestinations;
  if (args.destination === undefined) {
    settled = settledByRunner.get(args.runner) ?? new Set<string>();
    settledByRunner.set(args.runner, settled);
  }
  const key = JSON.stringify([args.dialect, args.destination ?? '', args.schema]);
  if (settled.has(key)) return undefined;
  settled.add(key);
  if (await tableExists(args.runner, metaTableRef(args.schema, args.dialect))) return undefined;
  for (const name of legacy) {
    const oldRef = tableRef(args.schema, name, args.dialect);
    if (!(await tableExists(args.runner, oldRef))) continue;
    const target =
      args.dialect === 'snowflake'
        ? metaTableRef(args.schema, args.dialect)
        : quoteIdentifier(METADATA_TABLE, args.dialect);
    try {
      await args.runner.run(`ALTER TABLE ${oldRef} RENAME TO ${target}`);
      return name;
    } catch (error) {
      if (await tableExists(args.runner, metaTableRef(args.schema, args.dialect))) return undefined;
      settled.delete(key);
      throw error;
    }
  }
  return undefined;
}

export async function ensureMetadataTable(args: {
  runner: SqlRunnerModule;
  schema: string;
  dialect: MetadataDialect;
  destination?: string | undefined;
}): Promise<void> {
  await adoptLegacyMetadataTable(args);
  const ref = metaTableRef(args.schema, args.dialect);
  const types = metadataColumnTypes(args.dialect);
  await args.runner.run(`CREATE TABLE IF NOT EXISTS ${ref} (
    source_name  ${types.stringType},
    filter_hash  ${types.stringType},
    loaded_at    ${types.timestampType},
    record_count ${types.integerType},
    etag         ${types.stringType}
  )`);
  await args.runner.run(`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS etag ${types.stringType}`);
  const additiveColumns: Array<[string, string]> = [
    ['cursor_field', types.stringType],
    ['cursor_type', types.stringType],
    ['cursor_value', types.stringType],
    ['snapshot_kind', types.stringType],
    ['snapshot_variant', types.stringType],
    ['row_count', types.integerType],
    ['in_progress_until', types.timestampType],
  ];
  for (const [name, type] of additiveColumns) {
    await args.runner.run(`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}

export async function readMetadataRow(args: {
  runner: SqlRunnerModule;
  schema: string;
  sourceName: string;
  filterHash?: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
  dialect?: MetadataDialect;
}): Promise<MetadataRow | undefined> {
  validateIdentifier(args.sourceName);
  const filterPredicate =
    args.filterHash === undefined ? '' : ` AND filter_hash = '${escapeLiteral(args.filterHash)}'`;
  const snapshotKind = args.snapshotKind ?? 'canonical';
  const snapshotPredicate =
    snapshotKind === 'canonical'
      ? ` AND COALESCE(snapshot_kind, 'canonical') = 'canonical'`
      : ` AND snapshot_kind = '${escapeLiteral(snapshotKind)}'`;
  const snapshotVariant = args.snapshotVariant;
  const variantPredicate =
    snapshotVariant === undefined || snapshotVariant === null
      ? ' AND snapshot_variant IS NULL'
      : ` AND snapshot_variant = '${escapeLiteral(snapshotVariant)}'`;

  try {
    const rows = await queryRows(
      args.runner,
      `SELECT source_name, filter_hash, loaded_at, record_count, etag, cursor_field, cursor_type, cursor_value, snapshot_kind, snapshot_variant, row_count, in_progress_until FROM ${metaTableRef(
        args.schema,
        args.dialect
      )} WHERE source_name = '${escapeLiteral(args.sourceName)}'${filterPredicate}${snapshotPredicate}${variantPredicate} ORDER BY loaded_at DESC LIMIT 1`
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      source_name: String(row.source_name),
      filter_hash: String(row.filter_hash),
      loaded_at: normalizeLoadedAt(row.loaded_at),
      record_count: Number(row.record_count),
      ...(row.etag !== undefined && row.etag !== null ? { etag: String(row.etag) } : {}),
      ...(row.cursor_field !== undefined && row.cursor_field !== null
        ? { cursor_field: String(row.cursor_field) }
        : {}),
      ...(row.cursor_type !== undefined && row.cursor_type !== null
        ? { cursor_type: String(row.cursor_type) as CursorType }
        : {}),
      ...(row.cursor_value !== undefined && row.cursor_value !== null
        ? { cursor_value: String(row.cursor_value) }
        : {}),
      ...(row.snapshot_kind !== undefined && row.snapshot_kind !== null
        ? { snapshot_kind: String(row.snapshot_kind) as SnapshotKind }
        : {}),
      ...(row.snapshot_variant !== undefined
        ? {
            snapshot_variant: row.snapshot_variant === null ? null : String(row.snapshot_variant),
          }
        : {}),
      ...(row.row_count !== undefined && row.row_count !== null
        ? { row_count: Number(row.row_count) }
        : {}),
      ...(row.in_progress_until !== undefined
        ? {
            in_progress_until:
              row.in_progress_until === null ? null : normalizeLoadedAt(row.in_progress_until),
          }
        : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not\s+(found|exist)|no\s+such\s+table|does\s+not\s+exist/i.test(message)) {
      return undefined;
    }
    throw err;
  }
}

const MAX_ETAG_LENGTH = 256;

export async function upsertMetadataRow(args: {
  runner: SqlRunnerModule;
  schema: string;
  row: MetadataRow;
  dialect?: MetadataDialect;
}): Promise<void> {
  validateIdentifier(args.row.source_name);
  if (args.row.etag !== undefined && args.row.etag.length > MAX_ETAG_LENGTH) {
    throw new CommandError(
      `etag exceeds ${MAX_ETAG_LENGTH} chars; upstream provider returned an oversized value.`,
      1
    );
  }
  const ref = metaTableRef(args.schema, args.dialect);
  const dialect = args.dialect ?? 'duckdb';
  const snapshotKind = args.row.snapshot_kind ?? 'canonical';
  const snapshotVariant = args.row.snapshot_variant ?? null;
  const rowCount = args.row.row_count ?? args.row.record_count;
  const inProgressUntil = args.row.in_progress_until ?? null;
  if (snapshotKind === 'limited' && snapshotVariant === null) {
    throw new CommandError(
      'snapshot_variant is required when snapshot_kind is limited',
      EXIT_VALIDATION
    );
  }
  if (snapshotKind === 'canonical' && snapshotVariant !== null) {
    throw new CommandError(
      'snapshot_variant must be null when snapshot_kind is canonical',
      EXIT_VALIDATION
    );
  }
  const mergeSnapshotKindPredicate =
    snapshotKind === 'canonical'
      ? `COALESCE(t.snapshot_kind, 'canonical') = 'canonical'`
      : `t.snapshot_kind = '${escapeLiteral(snapshotKind)}'`;
  const mergeSnapshotVariantPredicate =
    snapshotVariant === null
      ? 't.snapshot_variant IS NULL'
      : `t.snapshot_variant = '${escapeLiteral(snapshotVariant)}'`;
  const deleteSnapshotKindPredicate =
    snapshotKind === 'canonical'
      ? `COALESCE(snapshot_kind, 'canonical') = 'canonical'`
      : `snapshot_kind = '${escapeLiteral(snapshotKind)}'`;
  const deleteSnapshotVariantPredicate =
    snapshotVariant === null
      ? 'snapshot_variant IS NULL'
      : `snapshot_variant = '${escapeLiteral(snapshotVariant)}'`;

  if (dialect === 'bigquery') {
    await args.runner.run(
      `MERGE ${ref} AS t USING (SELECT '${escapeLiteral(
        args.row.source_name
      )}' AS source_name, '${escapeLiteral(args.row.filter_hash)}' AS filter_hash) AS s ` +
        `ON t.source_name = s.source_name AND t.filter_hash = s.filter_hash AND ${mergeSnapshotKindPredicate} AND ${mergeSnapshotVariantPredicate} ` +
        `WHEN MATCHED THEN UPDATE SET ` +
        `loaded_at = ${timestampLiteral(args.row.loaded_at, dialect)}, ` +
        `record_count = ${safeInteger(args.row.record_count)}, ` +
        `etag = ${nullableStringLiteral(args.row.etag)}, ` +
        `cursor_field = ${nullableStringLiteral(args.row.cursor_field)}, ` +
        `cursor_type = ${nullableStringLiteral(args.row.cursor_type)}, ` +
        `cursor_value = ${nullableStringLiteral(args.row.cursor_value)}, ` +
        `snapshot_kind = ${nullableStringLiteral(snapshotKind)}, ` +
        `snapshot_variant = ${nullableStringLiteral(snapshotVariant)}, ` +
        `row_count = ${safeInteger(rowCount)}, ` +
        `in_progress_until = ${nullableTimestampLiteral(inProgressUntil, dialect)} ` +
        `WHEN NOT MATCHED THEN INSERT (source_name, filter_hash, loaded_at, record_count, etag, cursor_field, cursor_type, cursor_value, snapshot_kind, snapshot_variant, row_count, in_progress_until) VALUES (` +
        `'${escapeLiteral(args.row.source_name)}', ` +
        `'${escapeLiteral(args.row.filter_hash)}', ` +
        `${timestampLiteral(args.row.loaded_at, dialect)}, ` +
        `${safeInteger(args.row.record_count)}, ` +
        `${nullableStringLiteral(args.row.etag)}, ` +
        `${nullableStringLiteral(args.row.cursor_field)}, ` +
        `${nullableStringLiteral(args.row.cursor_type)}, ` +
        `${nullableStringLiteral(args.row.cursor_value)}, ` +
        `${nullableStringLiteral(snapshotKind)}, ` +
        `${nullableStringLiteral(snapshotVariant)}, ` +
        `${safeInteger(rowCount)}, ` +
        `${nullableTimestampLiteral(inProgressUntil, dialect)})`
    );
    return;
  }

  if (dialect === 'snowflake') {
    await args.runner.run(
      `MERGE INTO ${ref} AS t USING (SELECT '${escapeLiteral(
        args.row.source_name
      )}' AS source_name, '${escapeLiteral(args.row.filter_hash)}' AS filter_hash) AS s ` +
        `ON t.source_name = s.source_name AND t.filter_hash = s.filter_hash AND ${mergeSnapshotKindPredicate} AND ${mergeSnapshotVariantPredicate} ` +
        `WHEN MATCHED THEN UPDATE SET ` +
        `loaded_at = ${timestampLiteral(args.row.loaded_at, dialect)}, ` +
        `record_count = ${safeInteger(args.row.record_count)}, ` +
        `etag = ${nullableStringLiteral(args.row.etag)}, ` +
        `cursor_field = ${nullableStringLiteral(args.row.cursor_field)}, ` +
        `cursor_type = ${nullableStringLiteral(args.row.cursor_type)}, ` +
        `cursor_value = ${nullableStringLiteral(args.row.cursor_value)}, ` +
        `snapshot_kind = ${nullableStringLiteral(snapshotKind)}, ` +
        `snapshot_variant = ${nullableStringLiteral(snapshotVariant)}, ` +
        `row_count = ${safeInteger(rowCount)}, ` +
        `in_progress_until = ${nullableTimestampLiteral(inProgressUntil, dialect)} ` +
        `WHEN NOT MATCHED THEN INSERT (source_name, filter_hash, loaded_at, record_count, etag, cursor_field, cursor_type, cursor_value, snapshot_kind, snapshot_variant, row_count, in_progress_until) VALUES (` +
        `'${escapeLiteral(args.row.source_name)}', ` +
        `'${escapeLiteral(args.row.filter_hash)}', ` +
        `${timestampLiteral(args.row.loaded_at, dialect)}, ` +
        `${safeInteger(args.row.record_count)}, ` +
        `${nullableStringLiteral(args.row.etag)}, ` +
        `${nullableStringLiteral(args.row.cursor_field)}, ` +
        `${nullableStringLiteral(args.row.cursor_type)}, ` +
        `${nullableStringLiteral(args.row.cursor_value)}, ` +
        `${nullableStringLiteral(snapshotKind)}, ` +
        `${nullableStringLiteral(snapshotVariant)}, ` +
        `${safeInteger(rowCount)}, ` +
        `${nullableTimestampLiteral(inProgressUntil, dialect)})`
    );
    return;
  }

  await args.runner.run(
    `DELETE FROM ${ref} WHERE source_name = '${escapeLiteral(
      args.row.source_name
    )}' AND filter_hash = '${escapeLiteral(args.row.filter_hash)}' AND ${deleteSnapshotKindPredicate} AND ${deleteSnapshotVariantPredicate}`
  );
  await args.runner.run(
    `INSERT INTO ${ref} (source_name, filter_hash, loaded_at, record_count, etag, cursor_field, cursor_type, cursor_value, snapshot_kind, snapshot_variant, row_count, in_progress_until) VALUES (` +
      `'${escapeLiteral(args.row.source_name)}', ` +
      `'${escapeLiteral(args.row.filter_hash)}', ` +
      `${timestampLiteral(args.row.loaded_at, dialect)}, ` +
      `${safeInteger(args.row.record_count)}, ` +
      `${nullableStringLiteral(args.row.etag)}, ` +
      `${nullableStringLiteral(args.row.cursor_field)}, ` +
      `${nullableStringLiteral(args.row.cursor_type)}, ` +
      `${nullableStringLiteral(args.row.cursor_value)}, ` +
      `${nullableStringLiteral(snapshotKind)}, ` +
      `${nullableStringLiteral(snapshotVariant)}, ` +
      `${safeInteger(rowCount)}, ` +
      `${nullableTimestampLiteral(inProgressUntil, dialect)})`
  );
}
