import { randomBytes } from 'node:crypto';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { SchemaColumn } from '@bobsled-inc/protocol';

import { quoteIdentifier, tableRef, type SqlDialect } from './sql-utils.js';

export interface ScratchTableArgs {
  runner: Pick<SqlRunnerModule, 'run'>;
  dialect: SqlDialect;
  schema: string;
  baseName: string;
  ttlSeconds: number;
  columns: SchemaColumn[];
}

export interface ScratchTableHandle {
  qualifiedName: string;
  schemaName: string;
  tableName: string;
}

function mapColumnType(column: SchemaColumn, dialect: SqlDialect): string {
  switch (dialect) {
    case 'bigquery':
      switch (column.type) {
        case 'integer':
          return 'INT64';
        case 'number':
          return 'FLOAT64';
        case 'boolean':
          return 'BOOL';
        case 'timestamp':
          return 'TIMESTAMP';
        default:
          return 'STRING';
      }
    case 'snowflake':
      switch (column.type) {
        case 'integer':
          return 'NUMBER(38,0)';
        case 'number':
          return 'FLOAT';
        case 'boolean':
          return 'BOOLEAN';
        case 'timestamp':
          return 'TIMESTAMP_TZ';
        default:
          return 'VARCHAR';
      }
    case 'duckdb':
      switch (column.type) {
        case 'integer':
          return 'BIGINT';
        case 'number':
          return 'DOUBLE';
        case 'boolean':
          return 'BOOLEAN';
        case 'timestamp':
          return 'TIMESTAMP';
        case 'array':
        case 'object':
          return 'JSON';
        case 'string':
          return 'VARCHAR';
        case 'vector':
          return `FLOAT[${column.dimension}]`;
      }
  }
}

function buildColumnDefs(columns: SchemaColumn[], dialect: SqlDialect): string {
  return columns
    .map((column) => `${quoteIdentifier(column.name, dialect)} ${mapColumnType(column, dialect)}`)
    .join(', ');
}

function buildQualifiedName(dialect: SqlDialect, schemaName: string, tableName: string): string {
  if (dialect === 'duckdb' && schemaName === 'temp') {
    return `temp.main.${quoteIdentifier(tableName, dialect)}`;
  }
  return tableRef(schemaName, tableName, dialect);
}

function buildCreateSql(args: ScratchTableArgs, tableName: string): string {
  const columnDefs = buildColumnDefs(args.columns, args.dialect);
  const qualifiedName =
    args.dialect === 'duckdb'
      ? buildQualifiedName(args.dialect, 'temp', tableName)
      : buildQualifiedName(args.dialect, args.schema, tableName);

  if (args.dialect === 'duckdb') {
    return `CREATE TEMP TABLE ${qualifiedName} (${columnDefs})`;
  }
  if (args.dialect === 'bigquery') {
    return (
      `CREATE TABLE ${qualifiedName} (${columnDefs}) ` +
      `OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${args.ttlSeconds} SECOND))`
    );
  }
  return `CREATE TRANSIENT TABLE ${qualifiedName} (${columnDefs})`;
}

export async function withScratchTable<T>(
  args: ScratchTableArgs,
  body: (scratch: ScratchTableHandle) => Promise<T>
): Promise<T> {
  const suffix = randomBytes(6).toString('hex');
  const tableName = `${args.baseName}_scratch_${suffix}`;
  const scratch =
    args.dialect === 'duckdb'
      ? {
          qualifiedName: buildQualifiedName(args.dialect, 'temp', tableName),
          schemaName: 'temp',
          tableName,
        }
      : {
          qualifiedName: buildQualifiedName(args.dialect, args.schema, tableName),
          schemaName: args.schema,
          tableName,
        };

  await args.runner.run(buildCreateSql(args, tableName));
  try {
    return await body(scratch);
  } finally {
    try {
      await args.runner.run(`DROP TABLE IF EXISTS ${scratch.qualifiedName}`);
    } catch {
      // Best-effort cleanup only.
    }
  }
}
