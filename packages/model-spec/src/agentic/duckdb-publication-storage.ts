import type { JsonValue } from '@bobsled-inc/protocol';
import type { SqlRunnerModule, SqlParams } from '@bobsled-inc/connections';
import { type AgenticColumn } from './model.js';
import { digestAgenticState } from './state.js';
import {
  AgenticPublicationReceiptSchema,
  type AgenticPublicationIntent,
  type AgenticPublicationReceipt,
  type AgenticPublicationContext,
} from './publication.js';
import { PUBLICATION_SCHEMA, q, stageRef } from './duckdb-checks.js';
import { LEGACY_DUCKDB_PUBLICATION_SCHEMAS } from './legacy-names.js';
import { renameLegacyMetadataColumns } from './metadata-columns.js';

export const control = stageRef('targets');
export const manifests = stageRef('stages');
export const receipts = stageRef('receipts');
const types: Record<AgenticColumn['type'], string> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
  object: 'JSON',
  array: 'JSON',
};
export function targetParts(value: string): {
  schema: string;
  table: string;
  sql: string;
  controlKey: string;
} {
  const parts: string[] = [];
  let remaining = value;
  while (remaining) {
    const match = /^(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\.|$)/.exec(remaining);
    if (!match) throw new Error('DuckDB publication requires a table or schema.table target');
    parts.push(match[1]?.replace(/""/g, '"') ?? match[2]!);
    remaining = remaining.slice(match[0].length);
  }
  if (parts.length < 1 || parts.length > 2) {
    throw new Error('DuckDB publication supports one database only');
  }
  const schema = parts.length === 2 ? parts[0]! : 'main';
  const table = parts.at(-1)!;
  if ([PUBLICATION_SCHEMA, ...LEGACY_DUCKDB_PUBLICATION_SCHEMAS].includes(schema.toLowerCase())) {
    throw new Error('Publication metadata schema is reserved');
  }
  return {
    schema,
    table,
    sql: `${q(schema)}.${q(table)}`,
    controlKey: `${q(schema.toLowerCase())}.${q(table.toLowerCase())}`,
  };
}
export function ddl(columns: readonly AgenticColumn[]): string {
  return columns
    .map((column) => `${q(column.name)} ${types[column.type]}${column.nullable ? '' : ' NOT NULL'}`)
    .join(', ');
}
export function boundValue(value: JsonValue | undefined, column: AgenticColumn): unknown {
  if (value === undefined || value === null) return null;
  return column.type === 'array' || column.type === 'object' ? JSON.stringify(value) : value;
}
export interface Db {
  run(sql: string): Promise<unknown>;
  query(sql: string, params?: SqlParams): Promise<Record<string, unknown>[]>;
}
export function dbFor(runner: SqlRunnerModule, signal?: AbortSignal): Db {
  return {
    run: (sql) => (signal ? runner.run(sql, { signal }) : runner.run(sql)),
    query: (sql, params) =>
      signal
        ? runner.query!(sql, params, { signal })
        : params === undefined
          ? runner.query!(sql)
          : runner.query!(sql, params),
  };
}
async function schemaExists(db: Db, schema: string): Promise<boolean> {
  const rows = await db.query(
    'SELECT 1 AS found FROM information_schema.schemata WHERE catalog_name = current_database() AND schema_name = ? LIMIT 1',
    [schema]
  );
  return rows.length > 0;
}

/**
 * DuckDB cannot rename a schema, so an earlier Core generation's publication schema is copied
 * into the current one: targets keep their revision and fence, and receipts keep publication
 * idempotent. Only into empty tables, all of them in one transaction, so a crash leaves either
 * nothing or everything copied and the next run decides again. The earlier schema stays.
 */
async function copyLegacyPublicationSchema(db: Db): Promise<void> {
  const legacies = LEGACY_DUCKDB_PUBLICATION_SCHEMAS.filter((name) => name !== PUBLICATION_SCHEMA);
  if (!legacies.length) return;
  const [count] = await db.query(
    `SELECT (SELECT count(*) FROM ${control}) + (SELECT count(*) FROM ${manifests}) + (SELECT count(*) FROM ${receipts}) AS n`
  );
  if (Number(count?.n ?? 0) > 0) return;
  for (const legacy of legacies) {
    if (!(await schemaExists(db, legacy))) continue;
    await db.run('BEGIN TRANSACTION');
    try {
      for (const table of ['targets', 'stages', 'receipts']) {
        const found = await db.query(
          'SELECT 1 AS found FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = ? AND table_name = ? LIMIT 1',
          [legacy, table]
        );
        if (found.length) {
          await db.run(`INSERT INTO ${stageRef(table)} SELECT * FROM ${q(legacy)}.${q(table)}`);
        }
      }
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK').catch(() => undefined);
      throw error;
    }
    return;
  }
}

export async function init(db: Db): Promise<void> {
  await db.run(`CREATE SCHEMA IF NOT EXISTS ${q(PUBLICATION_SCHEMA)}`);
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${control} (target VARCHAR PRIMARY KEY, revision BIGINT NOT NULL, fence VARCHAR NOT NULL)`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${manifests} (operation_id VARCHAR PRIMARY KEY, intent VARCHAR NOT NULL, columns_json VARCHAR NOT NULL, no_op BOOLEAN NOT NULL, validated BOOLEAN NOT NULL)`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${receipts} (operation_id VARCHAR PRIMARY KEY, receipt VARCHAR NOT NULL)`
  );
  await copyLegacyPublicationSchema(db);
}
export async function readReceipt(
  db: Db,
  intent: AgenticPublicationIntent
): Promise<AgenticPublicationReceipt | null> {
  const rows = await db.query(`SELECT receipt FROM ${receipts} WHERE operation_id = ? LIMIT 2`, [
    intent.identity.operation_id,
  ]);
  if (!rows.length) return null;
  if (
    rows.length !== 1 ||
    typeof rows[0]!.receipt !== 'string' ||
    rows[0]!.receipt.length > 32768
  ) {
    throw new Error('Invalid warehouse receipt');
  }
  const receipt = AgenticPublicationReceiptSchema.parse(JSON.parse(rows[0]!.receipt));
  if (digestAgenticState(receipt.intent) !== digestAgenticState(intent)) {
    throw new Error('Warehouse receipt identity conflict');
  }
  return receipt;
}
export async function assertSchema(db: Db, context: AgenticPublicationContext): Promise<boolean> {
  const target = targetParts(context.target);
  const schemas = await db.query(
    'SELECT schema_name FROM information_schema.schemata WHERE catalog_name = current_database() AND lower(schema_name) = lower(?) LIMIT 2',
    [target.schema]
  );
  if (schemas.length !== 1) throw new Error('DuckDB publication target schema must already exist');
  const found = await db.query(
    'SELECT table_type FROM information_schema.tables WHERE table_catalog = current_database() AND lower(table_schema) = lower(?) AND lower(table_name) = lower(?) LIMIT 2',
    [target.schema, target.table]
  );
  if (!found.length) return false;
  if (found.length !== 1 || found[0]!.table_type !== 'BASE TABLE') {
    throw new Error('DuckDB publication requires a base table');
  }
  const columns = await db.query(
    'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_catalog = current_database() AND lower(table_schema) = lower(?) AND lower(table_name) = lower(?) ORDER BY ordinal_position LIMIT 258',
    [target.schema, target.table]
  );
  const expected = context.resolved.output_columns;
  await renameLegacyMetadataColumns(
    columns,
    expected,
    (name) => name,
    (from, to) => db.run(`ALTER TABLE ${target.sql} RENAME COLUMN ${q(from)} TO ${q(to)}`),
    target.sql
  );
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index]!;
      return (
        column.column_name !== wanted.name ||
        column.data_type !== types[wanted.type] ||
        column.is_nullable !== (wanted.nullable ? 'YES' : 'NO')
      );
    })
  ) {
    throw new Error(
      'Existing agentic target schema differs; explicitly rebuild the target before publishing'
    );
  }
  return true;
}
