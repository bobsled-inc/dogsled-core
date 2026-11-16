import { assertBacktickIdentifier, assertBigQueryQuotedIdentifier } from '@bobsled-inc/protocol';
import type { SqlParamValue } from '@bobsled-inc/connections';
import type { SyncSpec } from './spec.js';

export const SYNC_SQL_DIALECTS = [
  'duckdb',
  'postgres',
  'bigquery',
  'snowflake',
  'databricks',
] as const;

export type SyncSqlDialect = (typeof SYNC_SQL_DIALECTS)[number];

/**
 * Sync builds its cursor predicate with positional placeholders, so a warehouse
 * is only usable here once it has one. ClickHouse binds by name and by declared
 * type (`{p1:String}`), which would compare a numeric or timestamp cursor as
 * text, so it is deliberately absent rather than approximated.
 */
export function isSyncSqlDialect(value: string): value is SyncSqlDialect {
  return (SYNC_SQL_DIALECTS as readonly string[]).includes(value);
}

export interface CursorQueryInput {
  spec: SyncSpec;
  dialect: SyncSqlDialect;
  cursorValue: SqlParamValue;
  tieBreakerValues?: readonly SqlParamValue[];
  limit: number;
}

export interface CursorQuery {
  sql: string;
  params: readonly SqlParamValue[] | Record<string, SqlParamValue>;
}

function quoteIdentifierPart(part: string, dialect: SyncSqlDialect): string {
  if (dialect === 'bigquery') {
    return `\`${assertBigQueryQuotedIdentifier(part)}\``;
  }
  if (dialect === 'databricks') {
    return `\`${assertBacktickIdentifier(part).replaceAll('`', '``')}\``;
  }
  return `"${part.replaceAll('"', '""')}"`;
}

function quoteIdentifier(identifier: string, dialect: SyncSqlDialect): string {
  return identifier
    .split('.')
    .map((part) => quoteIdentifierPart(part, dialect))
    .join('.');
}

export function buildCursorQuery(input: CursorQueryInput): CursorQuery {
  const { spec, dialect } = input;
  const cursorFields = [spec.source.cursor.field, ...spec.source.cursor.tie_breaker_fields];
  const params: SqlParamValue[] = [input.cursorValue];
  const tieValues = input.tieBreakerValues ?? [];

  for (let i = 0; i < spec.source.cursor.tie_breaker_fields.length; i++) {
    params.push(tieValues[i] ?? null);
  }

  // Postgres ($n) and BigQuery (@pn) can reference one value several times. DuckDB,
  // Snowflake and Databricks bind `?` by position, so each occurrence needs its
  // own value, in the order the placeholders appear in the SQL.
  const positional: SqlParamValue[] = [];
  const placeholder = (index: number): string => {
    if (dialect === 'postgres') return `$${index + 1}`;
    if (dialect === 'bigquery') return `@p${index}`;
    positional.push(params[index] ?? null);
    return '?';
  };

  const comparisons: string[] = [];
  for (let level = 0; level < cursorFields.length; level++) {
    const equals = cursorFields
      .slice(0, level)
      .map((field, i) => `${quoteIdentifier(field, dialect)} = ${placeholder(i)}`);
    const gt = `${quoteIdentifier(cursorFields[level]!, dialect)} > ${placeholder(level)}`;
    comparisons.push([...equals, gt].join(' AND '));
  }

  const filterEntries = Object.entries(spec.source.filters);
  const filterStart = params.length;
  for (const [, value] of filterEntries) {
    params.push(value);
  }
  const filterClauses = filterEntries.map(
    ([field], i) => `${quoteIdentifier(field, dialect)} = ${placeholder(filterStart + i)}`
  );
  params.push(input.limit);
  const limitPlaceholder = placeholder(params.length - 1);

  const where = [`(${comparisons.map((part) => `(${part})`).join(' OR ')})`, ...filterClauses];
  const sql = [
    `SELECT * FROM ${quoteIdentifier(spec.source.projection_ref, dialect)}`,
    `WHERE ${where.join(' AND ')}`,
    `ORDER BY ${cursorFields.map((field) => quoteIdentifier(field, dialect)).join(', ')}`,
    `LIMIT ${limitPlaceholder}`,
  ].join('\n');

  if (dialect === 'bigquery') {
    return {
      sql,
      params: Object.fromEntries(params.map((value, i) => [`p${i}`, value])),
    };
  }

  return { sql, params: dialect === 'postgres' ? params : positional };
}
