import type { SqlRunnerModule } from '@bobsled-inc/connections';
import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import {
  ensureMetadataTable,
  isLeasePlaceholderMetadataRow,
  LEASE_PLACEHOLDER_LOADED_AT,
  readMetadataRow,
  upsertMetadataRow,
  type MetadataDialect,
  type MetadataRow,
  type SnapshotKind,
} from './metadata.js';
import { METADATA_TABLE } from './metadata-table.js';
import { escapeLiteral, isMissingTableError, tableRef, validateIdentifier } from './sql-utils.js';

const DEFAULT_LEASE_SECONDS = 60;
const MAX_ETAG_LENGTH = 256;

export interface MetadataReadArgs {
  schema: string;
  sourceName: string;
  filterHash?: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
}

export interface MetadataWriteArgs {
  schema: string;
  row: MetadataRow;
}

export interface MetadataTableExistsArgs {
  schema: string;
  table: string;
}

export interface MetadataLeaseArgs {
  schema: string;
  sourceName: string;
  filterHash: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
  leaseSeconds?: number;
}

export interface MetadataLeaseResult {
  acquired: boolean;
  inProgressUntil?: string;
  row?: MetadataRow;
}

export interface MetadataFinishRefreshArgs {
  schema: string;
  sourceName?: string;
  filterHash?: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
  inProgressUntil?: string;
  row?: MetadataRow;
}

export interface MetadataStore {
  read(args: MetadataReadArgs): Promise<MetadataRow | undefined>;
  write(args: MetadataWriteArgs): Promise<void>;
  tableExists(args: MetadataTableExistsArgs): Promise<boolean>;
  beginRefresh(args: MetadataLeaseArgs): Promise<MetadataLeaseResult>;
  finishRefresh(args: MetadataFinishRefreshArgs): Promise<void>;
}

function snapshotKindOf(kind: SnapshotKind | undefined): SnapshotKind {
  return kind ?? 'canonical';
}

function snapshotVariantOf(variant: string | null | undefined): string | null {
  return variant ?? null;
}

function parseTimestampMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CommandError(`${label} must be a parseable timestamp: ${value}`, EXIT_VALIDATION);
  }
  return parsed;
}

function addSeconds(value: string, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CommandError('leaseSeconds must be a positive number', EXIT_VALIDATION);
  }
  return new Date(parseTimestampMs(value, 'nowIso') + seconds * 1000).toISOString();
}

function timestampLiteral(value: string, dialect: MetadataDialect): string {
  const escaped = escapeLiteral(value);
  return dialect === 'bigquery' ? `TIMESTAMP('${escaped}')` : `TIMESTAMP '${escaped}'`;
}

function activeLeaseUntil(row: MetadataRow | undefined, nowIso: string): string | undefined {
  if (!row?.in_progress_until) return undefined;
  return parseTimestampMs(row.in_progress_until, 'in_progress_until') >
    parseTimestampMs(nowIso, 'nowIso')
    ? row.in_progress_until
    : undefined;
}

function leaseRow(
  args: MetadataLeaseArgs,
  inProgressUntil: string,
  current?: MetadataRow
): MetadataRow {
  const snapshotKind = snapshotKindOf(args.snapshotKind);
  const snapshotVariant = snapshotVariantOf(args.snapshotVariant);
  return {
    ...(current ?? {
      source_name: args.sourceName,
      filter_hash: args.filterHash,
      loaded_at: LEASE_PLACEHOLDER_LOADED_AT,
      record_count: 0,
      row_count: 0,
    }),
    source_name: args.sourceName,
    filter_hash: args.filterHash,
    snapshot_kind: snapshotKind,
    snapshot_variant: snapshotVariant,
    in_progress_until: inProgressUntil,
  };
}

function validateWriteRow(row: MetadataRow): void {
  validateIdentifier(row.source_name);
  if (row.etag !== undefined && row.etag.length > MAX_ETAG_LENGTH) {
    throw new CommandError(
      `etag exceeds ${MAX_ETAG_LENGTH} chars; upstream provider returned an oversized value.`,
      1
    );
  }
  const snapshotKind = snapshotKindOf(row.snapshot_kind);
  const snapshotVariant = snapshotVariantOf(row.snapshot_variant);
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
}

function normalizedWriteRow(row: MetadataRow): MetadataRow {
  validateWriteRow(row);
  return {
    ...row,
    snapshot_kind: snapshotKindOf(row.snapshot_kind),
    snapshot_variant: snapshotVariantOf(row.snapshot_variant),
    row_count: row.row_count ?? row.record_count,
    in_progress_until: row.in_progress_until ?? null,
  };
}

function keyFor(args: {
  schema: string;
  sourceName: string;
  filterHash: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
}): string {
  return [
    args.schema,
    args.sourceName,
    args.filterHash,
    snapshotKindOf(args.snapshotKind),
    snapshotVariantOf(args.snapshotVariant) ?? '',
  ].join('\0');
}

function tableKey(schema: string, table: string): string {
  return `${schema}\0${table}`;
}

function clearLeasePredicate(args: {
  sourceName: string;
  filterHash: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
}): string {
  validateIdentifier(args.sourceName);
  const snapshotKind = snapshotKindOf(args.snapshotKind);
  const snapshotVariant = snapshotVariantOf(args.snapshotVariant);
  const snapshotKindPredicate =
    snapshotKind === 'canonical'
      ? `COALESCE(snapshot_kind, 'canonical') = 'canonical'`
      : `snapshot_kind = '${escapeLiteral(snapshotKind)}'`;
  const snapshotVariantPredicate =
    snapshotVariant === null
      ? 'snapshot_variant IS NULL'
      : `snapshot_variant = '${escapeLiteral(snapshotVariant)}'`;
  return (
    `source_name = '${escapeLiteral(args.sourceName)}' ` +
    `AND filter_hash = '${escapeLiteral(args.filterHash)}' ` +
    `AND ${snapshotKindPredicate} AND ${snapshotVariantPredicate}`
  );
}

function leaseTokenPredicate(
  inProgressUntil: string | undefined,
  dialect: MetadataDialect
): string {
  return inProgressUntil === undefined
    ? ''
    : ` AND in_progress_until = ${timestampLiteral(inProgressUntil, dialect)}`;
}

export interface DuckDBMetadataStoreOptions {
  runner: SqlRunnerModule;
  dialect?: MetadataDialect;
  defaultLeaseSeconds?: number;
  /** Schemas whose metadata table the caller has already ensured. */
  ensuredSchemas?: Iterable<string>;
}

export class DuckDBMetadataStore implements MetadataStore {
  private readonly ensuredSchemas: Set<string>;
  private readonly runner: SqlRunnerModule;
  private readonly dialect: MetadataDialect;
  private readonly defaultLeaseSeconds: number;

  constructor(options: DuckDBMetadataStoreOptions) {
    this.ensuredSchemas = new Set(options.ensuredSchemas);
    this.runner = options.runner;
    this.dialect = options.dialect ?? 'duckdb';
    this.defaultLeaseSeconds = options.defaultLeaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async read(args: MetadataReadArgs): Promise<MetadataRow | undefined> {
    await this.ensure(args.schema);
    return readMetadataRow({
      runner: this.runner,
      schema: args.schema,
      sourceName: args.sourceName,
      ...(args.filterHash !== undefined ? { filterHash: args.filterHash } : {}),
      ...(args.snapshotKind !== undefined ? { snapshotKind: args.snapshotKind } : {}),
      ...(args.snapshotVariant !== undefined ? { snapshotVariant: args.snapshotVariant } : {}),
      dialect: this.dialect,
    });
  }

  async write(args: MetadataWriteArgs): Promise<void> {
    await this.ensure(args.schema);
    await upsertMetadataRow({
      runner: this.runner,
      schema: args.schema,
      row: normalizedWriteRow(args.row),
      dialect: this.dialect,
    });
  }

  async tableExists(args: MetadataTableExistsArgs): Promise<boolean> {
    if (!this.runner.query) {
      throw new CommandError('SQL runner does not support query execution', 1);
    }
    try {
      await this.runner.query(
        `SELECT 1 FROM ${tableRef(args.schema, args.table, this.dialect)} LIMIT 0`
      );
      return true;
    } catch (error) {
      if (isMissingTableError(error)) return false;
      throw error;
    }
  }

  async beginRefresh(args: MetadataLeaseArgs): Promise<MetadataLeaseResult> {
    await this.ensure(args.schema);
    const nowIso = new Date().toISOString();
    const leaseUntil = addSeconds(nowIso, args.leaseSeconds ?? this.defaultLeaseSeconds);

    await this.beginImmediate();
    try {
      const current = await readMetadataRow({
        runner: this.runner,
        schema: args.schema,
        sourceName: args.sourceName,
        filterHash: args.filterHash,
        snapshotKind: snapshotKindOf(args.snapshotKind),
        snapshotVariant: snapshotVariantOf(args.snapshotVariant),
        dialect: this.dialect,
      });
      const heldUntil = activeLeaseUntil(current, nowIso);
      if (heldUntil) {
        await this.runner.run('COMMIT');
        return { acquired: false, inProgressUntil: heldUntil, row: current };
      }

      const row = leaseRow(args, leaseUntil, current);
      await upsertMetadataRow({
        runner: this.runner,
        schema: args.schema,
        row,
        dialect: this.dialect,
      });
      await this.runner.run('COMMIT');
      return { acquired: true, inProgressUntil: leaseUntil, row };
    } catch (error) {
      await this.rollbackQuietly();
      throw error;
    }
  }

  async finishRefresh(args: MetadataFinishRefreshArgs): Promise<void> {
    await this.ensure(args.schema);
    if (args.row) {
      if (args.inProgressUntil === undefined) {
        await this.write({ schema: args.schema, row: { ...args.row, in_progress_until: null } });
        return;
      }

      await this.beginImmediate();
      try {
        const current = await readMetadataRow({
          runner: this.runner,
          schema: args.schema,
          sourceName: args.row.source_name,
          filterHash: args.row.filter_hash,
          snapshotKind: args.row.snapshot_kind,
          snapshotVariant: args.row.snapshot_variant,
          dialect: this.dialect,
        });
        if (current?.in_progress_until === args.inProgressUntil) {
          await upsertMetadataRow({
            runner: this.runner,
            schema: args.schema,
            row: normalizedWriteRow({ ...args.row, in_progress_until: null }),
            dialect: this.dialect,
          });
        }
        await this.runner.run('COMMIT');
      } catch (error) {
        await this.rollbackQuietly();
        throw error;
      }
      return;
    }

    const sourceName = args.sourceName;
    const filterHash = args.filterHash;
    if (!sourceName || !filterHash) {
      throw new CommandError(
        'finishRefresh requires row or sourceName and filterHash',
        EXIT_VALIDATION
      );
    }
    const ref = tableRef(args.schema, METADATA_TABLE, this.dialect);
    const predicate = clearLeasePredicate({
      sourceName,
      filterHash,
      snapshotKind: args.snapshotKind,
      snapshotVariant: args.snapshotVariant,
    });
    const tokenPredicate = leaseTokenPredicate(args.inProgressUntil, this.dialect);
    await this.beginImmediate();
    try {
      await this.runner.run(
        `DELETE FROM ${ref} WHERE ${predicate}${tokenPredicate} ` +
          `AND loaded_at = ${timestampLiteral(LEASE_PLACEHOLDER_LOADED_AT, this.dialect)} ` +
          `AND record_count = 0 AND COALESCE(row_count, record_count) = 0`
      );
      await this.runner.run(
        `UPDATE ${ref} SET in_progress_until = NULL WHERE ${predicate}${tokenPredicate}`
      );
      await this.runner.run('COMMIT');
    } catch (error) {
      await this.rollbackQuietly();
      throw error;
    }
  }

  private async ensure(schema: string): Promise<void> {
    if (this.ensuredSchemas.has(schema)) return;
    await ensureMetadataTable({ runner: this.runner, schema, dialect: this.dialect });
    this.ensuredSchemas.add(schema);
  }

  private async beginImmediate(): Promise<void> {
    try {
      await this.runner.run('BEGIN IMMEDIATE');
    } catch (error) {
      if (
        !/syntax|parser|unsupported|not implemented/i.test(
          error instanceof Error ? error.message : String(error)
        )
      ) {
        throw error;
      }
      await this.runner.run('BEGIN TRANSACTION');
    }
  }

  private async rollbackQuietly(): Promise<void> {
    try {
      await this.runner.run('ROLLBACK');
    } catch {
      // Best-effort rollback only.
    }
  }
}

export interface InMemoryMetadataStoreOptions {
  rows?: Array<{ schema: string; row: MetadataRow }>;
  tables?: Array<{ schema: string; table: string }>;
}

export class InMemoryMetadataStore implements MetadataStore {
  private readonly rows = new Map<string, MetadataRow>();
  private readonly tables = new Set<string>();

  constructor(options: InMemoryMetadataStoreOptions = {}) {
    for (const seed of options.rows ?? []) {
      const row = normalizedWriteRow(seed.row);
      this.rows.set(
        keyFor({
          schema: seed.schema,
          sourceName: row.source_name,
          filterHash: row.filter_hash,
          snapshotKind: row.snapshot_kind,
          snapshotVariant: row.snapshot_variant,
        }),
        { ...row }
      );
    }
    for (const table of options.tables ?? []) {
      this.tables.add(tableKey(table.schema, table.table));
    }
  }

  async read(args: MetadataReadArgs): Promise<MetadataRow | undefined> {
    validateIdentifier(args.sourceName);
    const snapshotKind = snapshotKindOf(args.snapshotKind);
    const snapshotVariant = snapshotVariantOf(args.snapshotVariant);
    const candidates = [...this.rows.entries()]
      .filter(([key, row]) => {
        const [schema] = key.split('\0');
        return (
          schema === args.schema &&
          row.source_name === args.sourceName &&
          (args.filterHash === undefined || row.filter_hash === args.filterHash) &&
          snapshotKindOf(row.snapshot_kind) === snapshotKind &&
          snapshotVariantOf(row.snapshot_variant) === snapshotVariant
        );
      })
      .map(([, row]) => row)
      .sort(
        (left, right) =>
          parseTimestampMs(right.loaded_at, 'loaded_at') -
          parseTimestampMs(left.loaded_at, 'loaded_at')
      );

    const row = candidates[0];
    return row ? { ...row } : undefined;
  }

  async write(args: MetadataWriteArgs): Promise<void> {
    const row = normalizedWriteRow(args.row);
    this.rows.set(
      keyFor({
        schema: args.schema,
        sourceName: row.source_name,
        filterHash: row.filter_hash,
        snapshotKind: row.snapshot_kind,
        snapshotVariant: row.snapshot_variant,
      }),
      { ...row }
    );
  }

  async tableExists(args: MetadataTableExistsArgs): Promise<boolean> {
    return this.tables.has(tableKey(args.schema, args.table));
  }

  async beginRefresh(args: MetadataLeaseArgs): Promise<MetadataLeaseResult> {
    const nowIso = new Date().toISOString();
    const leaseUntil = addSeconds(nowIso, args.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
    const current = await this.read({
      schema: args.schema,
      sourceName: args.sourceName,
      filterHash: args.filterHash,
      snapshotKind: snapshotKindOf(args.snapshotKind),
      snapshotVariant: snapshotVariantOf(args.snapshotVariant),
    });
    const heldUntil = activeLeaseUntil(current, nowIso);
    if (heldUntil) {
      return { acquired: false, inProgressUntil: heldUntil, row: current };
    }

    const row = leaseRow(args, leaseUntil, current);
    await this.write({ schema: args.schema, row });
    return { acquired: true, inProgressUntil: leaseUntil, row };
  }

  async finishRefresh(args: MetadataFinishRefreshArgs): Promise<void> {
    if (args.row) {
      if (args.inProgressUntil !== undefined) {
        const current = await this.read({
          schema: args.schema,
          sourceName: args.row.source_name,
          filterHash: args.row.filter_hash,
          snapshotKind: args.row.snapshot_kind,
          snapshotVariant: args.row.snapshot_variant,
        });
        if (current?.in_progress_until !== args.inProgressUntil) return;
      }
      await this.write({ schema: args.schema, row: { ...args.row, in_progress_until: null } });
      return;
    }

    const sourceName = args.sourceName;
    const filterHash = args.filterHash;
    if (!sourceName || !filterHash) {
      throw new CommandError(
        'finishRefresh requires row or sourceName and filterHash',
        EXIT_VALIDATION
      );
    }
    const current = await this.read({
      schema: args.schema,
      sourceName,
      filterHash,
      snapshotKind: args.snapshotKind,
      snapshotVariant: args.snapshotVariant,
    });
    if (args.inProgressUntil !== undefined && current?.in_progress_until !== args.inProgressUntil) {
      return;
    }
    if (current && isLeasePlaceholderMetadataRow(current)) {
      this.rows.delete(
        keyFor({
          schema: args.schema,
          sourceName: current.source_name,
          filterHash: current.filter_hash,
          snapshotKind: current.snapshot_kind,
          snapshotVariant: current.snapshot_variant,
        })
      );
    } else if (current) {
      await this.write({ schema: args.schema, row: { ...current, in_progress_until: null } });
    }
  }
}
