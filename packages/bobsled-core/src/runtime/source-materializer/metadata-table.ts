import type { SqlRunnerModule } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';

import { LEGACY_METADATA_TABLES } from './legacy-names.js';
import { isMissingTableError, quoteIdentifier, tableRef, type SqlDialect } from './sql-utils.js';

export const METADATA_TABLE = '_bobsled_source_metadata';

export function metaTableRef(schema: string, dialect: SqlDialect = 'duckdb'): string {
  return tableRef(schema, METADATA_TABLE, dialect);
}

/** Wait before the one retry after BigQuery rejects metadata-table DDL for its update rate. */
export const BIGQUERY_UPDATE_RETRY_DELAY_MS = 2_000;

function metadataColumnTypes(dialect: SqlDialect): {
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

function additiveMetadataColumns(dialect: SqlDialect): Array<[string, string]> {
  const types = metadataColumnTypes(dialect);
  return [
    ['cursor_field', types.stringType],
    ['cursor_type', types.stringType],
    ['cursor_value', types.stringType],
    ['snapshot_kind', types.stringType],
    ['snapshot_variant', types.stringType],
    ['row_count', types.integerType],
    ['in_progress_until', types.timestampType],
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBigQueryUpdateLimitError(error: unknown): boolean {
  return /exceeded rate limits|exceeded quota for table update|concurrent update/i.test(
    errorMessage(error)
  );
}

function bigQueryMetadataColumns(): Array<[string, string]> {
  const types = metadataColumnTypes('bigquery');
  return [
    ['source_name', types.stringType],
    ['filter_hash', types.stringType],
    ['loaded_at', types.timestampType],
    ['record_count', types.integerType],
    ['etag', types.stringType],
    ...additiveMetadataColumns('bigquery'),
  ];
}

/** The metadata table's column names, or `undefined` when the dataset does not exist. */
async function readBigQueryMetadataColumns(
  runner: SqlRunnerModule,
  schema: string
): Promise<Set<string> | undefined> {
  if (!runner.query) {
    throw new CommandError('SQL runner does not support query execution', 1);
  }
  try {
    const rows = await runner.query(
      `SELECT column_name FROM ${quoteIdentifier(schema, 'bigquery')}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${METADATA_TABLE}'`
    );
    return new Set(rows.map((row) => String(row.column_name).toLowerCase()));
  } catch (error) {
    if (/not found: dataset/i.test(errorMessage(error))) return undefined;
    throw error;
  }
}

function bigQueryMetadataDdl(schema: string, existing: Set<string> | undefined): string[] {
  const ref = metaTableRef(schema, 'bigquery');
  const columns = bigQueryMetadataColumns();
  const create = `CREATE TABLE IF NOT EXISTS ${ref} (${columns.map(([name, type]) => `${name} ${type}`).join(', ')})`;
  if (existing === undefined) {
    return [`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, 'bigquery')}`, create];
  }
  if (existing.size === 0) return [create];
  const missing = columns.filter(([name]) => !existing.has(name));
  if (missing.length === 0) return [];
  return [
    `ALTER TABLE ${ref} ${missing
      .map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`)
      .join(', ')}`,
  ];
}

// BigQuery allows only about five table metadata updates per table every ten
// seconds, and a no-op `CREATE TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT
// EXISTS` still counts as one. Read the current columns first, then create the
// dataset and table only when missing, or add only the missing columns in a
// single ALTER, and skip DDL entirely when the table is already complete.
async function ensureBigQueryMetadataTable(args: {
  runner: SqlRunnerModule;
  schema: string;
}): Promise<void> {
  const statements = bigQueryMetadataDdl(
    args.schema,
    await readBigQueryMetadataColumns(args.runner, args.schema)
  );
  try {
    for (const sql of statements) await args.runner.run(sql);
  } catch (error) {
    if (!isBigQueryUpdateLimitError(error)) throw error;
    // Other processes may be setting up the same table at the same moment.
    // Re-read: if they finished it, there is nothing left to do; otherwise
    // wait out part of the rate window and try once more.
    const remaining = bigQueryMetadataDdl(
      args.schema,
      await readBigQueryMetadataColumns(args.runner, args.schema)
    );
    if (remaining.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, BIGQUERY_UPDATE_RETRY_DELAY_MS));
    for (const sql of remaining) await args.runner.run(sql);
  }
}

async function tableExists(runner: SqlRunnerModule, ref: string): Promise<boolean> {
  try {
    const probe = `SELECT 1 FROM ${ref} WHERE 1 = 0`;
    await (runner.query ? runner.query(probe) : runner.run(probe));
    return true;
  } catch (error) {
    // On BigQuery the dataset may not exist yet: Core creates it only when missing.
    if (isMissingTableError(error) || /not found: dataset/i.test(errorMessage(error))) return false;
    throw error;
  }
}

/**
 * Take over an earlier metadata table (for example `_bobsled_source_metadata`
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
  dialect: SqlDialect;
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
  dialect: SqlDialect;
  destination?: string | undefined;
}): Promise<void> {
  await adoptLegacyMetadataTable(args);
  if (args.dialect === 'bigquery') {
    await ensureBigQueryMetadataTable({ runner: args.runner, schema: args.schema });
    return;
  }
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
  for (const [name, type] of additiveMetadataColumns(args.dialect)) {
    await args.runner.run(`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}
