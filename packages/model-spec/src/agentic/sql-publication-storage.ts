import {
  throwIfCancelled,
  type SqlRunnerModule,
  type SqlParamValue,
} from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import { caseName, quoteIdentifier } from '../compiler/dialect.js';
import type { AgenticColumn } from './model.js';
import type { AgenticPublicationContext, AgenticPublicationIntent } from './publication.js';
import { AgenticPublicationReceiptSchema } from './publication.js';
import { digestAgenticState } from './state.js';
import {
  publicationNames,
  publicationType,
  publicationDdl,
  publicationTableSuffix,
  publicationTransactionSql,
  publicationLiteral,
  type PublicationDialect,
} from './sql-publication-dialect.js';

export function sqlPublicationDb(
  runner: SqlRunnerModule,
  dialect: PublicationDialect,
  signal?: AbortSignal
) {
  if (!runner.query || !runner.supportsBindings) {
    throw new Error('Publication requires a query runner with parameter bindings');
  }
  const run = (sql: string): Promise<unknown> =>
    signal ? runner.run(sql, { signal }) : runner.run(sql);
  async function query(sql: string, params?: readonly SqlParamValue[]) {
    throwIfCancelled(signal);
    const rows = signal
      ? await runner.query!(sql, params, { signal })
      : params === undefined
        ? await runner.query!(sql)
        : await runner.query!(sql, params);
    return rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
    );
  }
  const p = (index: number) => (dialect === 'postgres' ? `$${index}` : '?');
  return { run, query, p };
}
export type PublicationDb = ReturnType<typeof sqlPublicationDb>;
export type PublicationNames = ReturnType<typeof publicationNames>;
export async function initPublication(
  db: PublicationDb,
  names: PublicationNames,
  dialect: PublicationDialect
) {
  const text = publicationType('string', dialect);
  const integer = publicationType('integer', dialect);
  const q = (name: string) => quoteIdentifier(name, dialect);
  const suffix = publicationTableSuffix(dialect);
  await db.run(`CREATE SCHEMA IF NOT EXISTS ${names.storageNamespace}`);
  if (names.storageNamespace !== names.namespace) {
    await db.run(`CREATE SCHEMA IF NOT EXISTS ${names.namespace}`);
  }
  // Atomic CTAS creates exactly one control row; warehouse PKs are not always enforced.
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${names.control}${suffix} AS SELECT CAST(0 AS ${integer}) AS ${q('revision')}, CAST('' AS ${text}) AS ${q('fence')}, CAST('' AS ${text}) AS ${q('commit_token')}`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${names.manifests} (${q('operation_id')} ${text} NOT NULL, ${q('intent')} ${text} NOT NULL, ${q('columns_json')} ${text} NOT NULL, ${q('no_op')} BOOLEAN NOT NULL, ${q('receipt')} ${text} NOT NULL, ${q('validated')} BOOLEAN NOT NULL)${suffix}`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${names.receipts} (${q('operation_id')} ${text} NOT NULL, ${q('receipt')} ${text} NOT NULL)${suffix}`
  );
}
export async function readSqlReceipt(
  db: PublicationDb,
  names: PublicationNames,
  intent: AgenticPublicationIntent
) {
  const rows = await db.query(
    `SELECT receipt FROM ${names.receipts} WHERE operation_id = ${db.p(1)} LIMIT 2`,
    [intent.identity.operation_id]
  );
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
function compatibleType(
  actual: string,
  column: AgenticColumn,
  dialect: PublicationDialect
): boolean {
  const type = actual.toUpperCase();
  if (type === publicationType(column.type, dialect)) return true;
  const aliases: Record<AgenticColumn['type'], readonly string[]> = {
    string: ['TEXT', 'VARCHAR', 'STRING', 'CHARACTER VARYING'],
    integer: ['BIGINT', 'INT64', 'NUMBER'],
    number: ['DOUBLE', 'FLOAT', 'FLOAT64', 'DOUBLE PRECISION'],
    boolean: ['BOOLEAN', 'BOOL'],
    date: ['DATE'],
    timestamp: ['TIMESTAMP', 'TIMESTAMP_NTZ', 'TIMESTAMP WITHOUT TIME ZONE'],
    object: ['JSONB', 'JSON', 'VARIANT'],
    array: ['JSONB', 'JSON', 'VARIANT'],
  };
  return aliases[column.type].includes(type);
}
export async function assertSqlSchema(
  db: PublicationDb,
  names: PublicationNames,
  context: AgenticPublicationContext,
  dialect: PublicationDialect
) {
  const q = (name: string) => quoteIdentifier(name, dialect);
  const info =
    dialect === 'bigquery'
      ? `${names.namespace}.INFORMATION_SCHEMA`
      : names.catalog
        ? `${q(names.catalog)}.information_schema`
        : 'information_schema';
  const condition = `table_schema = ${db.p(1)} AND table_name = ${db.p(2)}`;
  const params = [names.schema, names.table];
  const tables = await db.query(
    `SELECT table_type FROM ${info}.TABLES WHERE ${condition} LIMIT 2`,
    params
  );
  if (!tables.length) return false;
  if (tables.length !== 1 || !['BASE TABLE', 'MANAGED'].includes(String(tables[0]!.table_type))) {
    throw new Error('Publication requires a base table');
  }
  const columns = await db.query(
    `SELECT column_name, data_type, is_nullable${dialect === 'snowflake' ? ', numeric_scale' : ''} FROM ${info}.COLUMNS WHERE ${condition} ORDER BY ordinal_position LIMIT 258`,
    params
  );
  const expected = context.resolved.output_columns;
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index]!;
      return (
        column.column_name !== caseName(wanted.name, dialect) ||
        !compatibleType(String(column.data_type), wanted, dialect) ||
        column.is_nullable !== (wanted.nullable ? 'YES' : 'NO') ||
        (wanted.type === 'integer' &&
          column.numeric_scale != null &&
          Number(column.numeric_scale) !== 0)
      );
    })
  ) {
    throw new Error(
      'Existing agentic target schema differs; explicitly rebuild the target before publishing'
    );
  }
  return true;
}
export async function insertPublicationRows(
  db: PublicationDb,
  relation: string,
  columns: readonly AgenticColumn[],
  rows: readonly JsonValue[],
  dialect: PublicationDialect,
  signal?: AbortSignal
) {
  const names = columns.map((column) => quoteIdentifier(column.name, dialect)).join(', ');
  // Each statement has bounded bindings. Nulls have explicit SQL types (BigQuery cannot infer them).
  for (let start = 0; start < rows.length; start += 25) {
    throwIfCancelled(signal);
    const params: SqlParamValue[] = [];
    const selects = rows.slice(start, start + 25).map(
      (row) =>
        `SELECT ${columns
          .map((column) => {
            const value = (row as Record<string, JsonValue>)[column.name];
            if (value == null) return `CAST(NULL AS ${publicationType(column.type, dialect)})`;
            params.push(typeof value === 'object' ? JSON.stringify(value) : value);
            const bind = db.p(params.length);
            return (column.type === 'object' || column.type === 'array') && dialect !== 'postgres'
              ? `PARSE_JSON(${bind})`
              : `CAST(${bind} AS ${publicationType(column.type, dialect)})`;
          })
          .join(', ')}`
    );
    await db.query(`INSERT INTO ${relation} (${names}) ${selects.join(' UNION ALL ')}`, params);
  }
}
export async function atomicPublication(
  db: PublicationDb,
  runner: SqlRunnerModule,
  dialect: PublicationDialect,
  statements: readonly string[],
  assertion: string,
  signal?: AbortSignal
) {
  if (dialect !== 'postgres') {
    const script = publicationTransactionSql(dialect, statements, assertion);
    await db.run(
      dialect === 'snowflake' ? `EXECUTE IMMEDIATE ${publicationLiteral(script, dialect)}` : script
    );
    return;
  }
  await db.run('BEGIN');
  try {
    for (const statement of statements) {
      throwIfCancelled(signal);
      await db.run(statement);
    }
    const rows = await db.query(`SELECT CASE WHEN (${assertion}) THEN 1 ELSE 0 END AS valid`);
    if (rows.length !== 1 || Number(rows[0]!.valid) !== 1) {
      throw new Error('Stale publication owner or target version');
    }
    throwIfCancelled(signal);
    await db.run('COMMIT');
  } catch (error) {
    await runner.run('ROLLBACK').catch(() => {});
    throw error;
  }
}
export async function createPublicationTable(
  db: PublicationDb,
  relation: string,
  columns: readonly AgenticColumn[],
  dialect: PublicationDialect,
  ifNotExists = false
) {
  await db.run(
    `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${relation} (${publicationDdl(columns, dialect)})${publicationTableSuffix(dialect)}`
  );
}
