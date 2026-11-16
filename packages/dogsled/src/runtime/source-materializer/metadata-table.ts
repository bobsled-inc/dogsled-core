import type { SqlRunnerModule } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';

import { quoteIdentifier, tableRef, type SqlDialect } from './sql-utils.js';

const METADATA_TABLE = '_dogsled_source_metadata';

function metaTableRef(schema: string, dialect: SqlDialect): string {
  return tableRef(schema, METADATA_TABLE, dialect);
}

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

// BigQuery allows only about five table metadata updates per table every ten
// seconds, and a no-op `CREATE TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT
// EXISTS` still counts as one. Read the current columns first, then create the
// table whole or add only the missing columns in a single ALTER, and skip DDL
// entirely when the table is already complete.
async function ensureBigQueryMetadataTable(args: {
  runner: SqlRunnerModule;
  schema: string;
}): Promise<void> {
  const ref = metaTableRef(args.schema, 'bigquery');
  const types = metadataColumnTypes('bigquery');
  const columns: Array<[string, string]> = [
    ['source_name', types.stringType],
    ['filter_hash', types.stringType],
    ['loaded_at', types.timestampType],
    ['record_count', types.integerType],
    ['etag', types.stringType],
    ...additiveMetadataColumns('bigquery'),
  ];
  if (!args.runner.query) {
    throw new CommandError('SQL runner does not support query execution', 1);
  }
  const existingRows = await args.runner.query(
    `SELECT column_name FROM ${quoteIdentifier(args.schema, 'bigquery')}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${METADATA_TABLE}'`
  );
  const existing = new Set(existingRows.map((row) => String(row.column_name).toLowerCase()));
  if (existing.size === 0) {
    await args.runner.run(
      `CREATE TABLE IF NOT EXISTS ${ref} (${columns.map(([name, type]) => `${name} ${type}`).join(', ')})`
    );
    return;
  }
  const missing = columns.filter(([name]) => !existing.has(name));
  if (missing.length === 0) return;
  await args.runner.run(
    `ALTER TABLE ${ref} ${missing
      .map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`)
      .join(', ')}`
  );
}

export async function ensureMetadataTable(args: {
  runner: SqlRunnerModule;
  schema: string;
  dialect: SqlDialect;
}): Promise<void> {
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
