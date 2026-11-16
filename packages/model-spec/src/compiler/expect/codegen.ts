import { getCanonicalDialect, quoteIdentifier, quoteLiteral } from '../dialect.js';

import type { ParsedModelExpectations } from './parser.js';
import type { SupportedDialect } from '../dialect.js';
import type { ExpectSpec } from '../schemas.js';

export interface ExpectSqlInput extends ParsedModelExpectations {
  dialect: SupportedDialect;
}

export interface ExpectSqlStatement {
  modelName: string;
  kind: ExpectSpec['kind'];
  target: string;
  severity: 'warn' | 'error';
  sql: string;
}

function q(column: string, dialect: SupportedDialect): string {
  return quoteIdentifier(column, dialect);
}

function sqlString(value: string, dialect: SupportedDialect): string {
  return quoteLiteral(value, dialect);
}

function sqlValue(value: string | number | boolean, dialect: SupportedDialect): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return quoteLiteral(value, dialect);
}

function quoteTableRef(tableName: string, dialect: SupportedDialect): string {
  if (tableName.includes('"') || tableName.includes('`')) {
    return tableName;
  }
  return tableName
    .split('.')
    .map((part) => quoteIdentifier(part, dialect))
    .join('.');
}

function stringCast(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
    case 'bigquery':
    case 'databricks':
      return `CAST(${expr} AS STRING)`;
    case 'postgres':
    case 'duckdb':
      return `CAST(${expr} AS VARCHAR)`;
    case 'clickhouse':
      // ClickHouse type names are case-sensitive, and a cast of NULL to a
      // non-Nullable type raises instead of yielding NULL, so the target type
      // has to say Nullable for this to behave like every other dialect here.
      return `CAST(${expr} AS Nullable(String))`;
    case 'mysql':
      return `CAST(${expr} AS CHAR)`;
  }
}

function regexPredicate(column: string, pattern: string, dialect: SupportedDialect): string {
  const col = q(column, dialect);
  const literal = sqlString(pattern, dialect);
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `REGEXP_LIKE(${stringCast(col, dialect)}, ${literal})`;
    case 'bigquery':
      return `REGEXP_CONTAINS(${stringCast(col, dialect)}, ${literal})`;
    case 'postgres':
      return `${stringCast(col, dialect)} ~ ${literal}`;
    case 'duckdb':
      return `regexp_matches(${stringCast(col, dialect)}, ${literal})`;
    case 'databricks':
      return `${stringCast(col, dialect)} RLIKE ${literal}`;
    case 'clickhouse':
      // `match` is the RE2 partial match, matching REGEXP_CONTAINS and
      // regexp_matches above; it returns UInt8, which NOT negates correctly.
      return `match(${stringCast(col, dialect)}, ${literal})`;
    case 'mysql':
      return `${stringCast(col, dialect)} REGEXP ${literal}`;
  }
}

function expectationTarget(expectation: ExpectSpec): string {
  if ('columns' in expectation) return expectation.columns.join(', ');
  if ('column' in expectation) return expectation.column;
  if ('expression' in expectation) return expectation.expression;
  if (expectation.kind === 'custom') return expectation.description ?? 'custom';
  return 'row_count';
}

function expectationSeverity(expectation: ExpectSpec): 'warn' | 'error' {
  return expectation.severity ?? 'error';
}

function countViolations(
  expectation: ExpectSpec,
  selectSql: string,
  dialect: SupportedDialect
): string {
  return [
    `SELECT`,
    `  ${sqlString(expectation.kind, dialect)} AS kind,`,
    `  ${sqlString(expectationTarget(expectation), dialect)} AS target,`,
    `  COUNT(*) AS violation_count`,
    `FROM (`,
    `  ${selectSql.replace(/\n/g, '\n  ')}`,
    `) AS ${q('__bobsled_expect_violations', dialect)}`,
  ].join('\n');
}

function compileViolationRows(
  expectation: ExpectSpec,
  tableName: string,
  dialect: SupportedDialect
): string {
  const table = quoteTableRef(tableName, dialect);
  switch (expectation.kind) {
    case 'primary_key': {
      const nullPredicates = expectation.columns.map((column) => `${q(column, dialect)} IS NULL`);
      const duplicateColumns = expectation.columns.map((column) => q(column, dialect)).join(', ');
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE ${nullPredicates.join(' OR ')}`,
        `UNION ALL`,
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `GROUP BY ${duplicateColumns}`,
        `HAVING COUNT(*) > 1`,
      ].join('\n');
    }
    case 'non_null':
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE ${q(expectation.column, dialect)} IS NULL`,
      ].join('\n');
    case 'unique': {
      const duplicateColumns = expectation.columns.map((column) => q(column, dialect)).join(', ');
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `GROUP BY ${duplicateColumns}`,
        `HAVING COUNT(*) > 1`,
      ].join('\n');
    }
    case 'in_range': {
      const predicates: string[] = [];
      if (expectation.min !== undefined) {
        predicates.push(`${q(expectation.column, dialect)} < ${expectation.min}`);
      }
      if (expectation.max !== undefined) {
        predicates.push(`${q(expectation.column, dialect)} > ${expectation.max}`);
      }
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE ${predicates.join(' OR ')}`,
      ].join('\n');
    }
    case 'regex':
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE ${q(expectation.column, dialect)} IS NOT NULL`,
        `  AND NOT (${regexPredicate(expectation.column, expectation.pattern, dialect)})`,
      ].join('\n');
    case 'accepted_values': {
      const valuesList = expectation.values.map((value) => sqlValue(value, dialect)).join(', ');
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE ${q(expectation.column, dialect)} IS NOT NULL`,
        `  AND ${q(expectation.column, dialect)} NOT IN (${valuesList})`,
      ].join('\n');
    }
    case 'expression':
      return [
        `SELECT 1 AS ${q('violation', dialect)}`,
        `FROM ${table}`,
        `WHERE NOT (${expectation.expression})`,
      ].join('\n');
    case 'schema_contains':
    case 'row_count_between':
    case 'custom':
      return '';
  }
}

function compileExpectationSql(
  expectation: ExpectSpec,
  tableName: string,
  outputColumns: readonly string[],
  dialect: SupportedDialect
): string {
  if (expectation.kind === 'custom') {
    const userSql = expectation.sql.replace(/\{model\}/g, quoteTableRef(tableName, dialect));
    return [
      `SELECT violation_count`,
      `FROM (`,
      `  ${userSql.replace(/\n/g, '\n  ')}`,
      `) AS ${q('__bobsled_custom', dialect)}`,
    ].join('\n');
  }

  if (expectation.kind === 'schema_contains') {
    const known = new Set(outputColumns.map((column) => column.toLowerCase()));
    const missing = expectation.columns.filter((column) => !known.has(column.toLowerCase()));
    return [
      `SELECT`,
      `  ${sqlString(expectation.kind, dialect)} AS kind,`,
      `  ${sqlString(expectationTarget(expectation), dialect)} AS target,`,
      `  ${missing.length} AS violation_count`,
    ].join('\n');
  }

  if (expectation.kind === 'row_count_between') {
    const predicates: string[] = [];
    if (expectation.min !== undefined) predicates.push(`COUNT(*) < ${expectation.min}`);
    if (expectation.max !== undefined) predicates.push(`COUNT(*) > ${expectation.max}`);
    if (predicates.length === 0) {
      throw new Error('row_count_between expectation requires at least one of min or max');
    }
    return [
      `SELECT`,
      `  ${sqlString(expectation.kind, dialect)} AS kind,`,
      `  ${sqlString(expectationTarget(expectation), dialect)} AS target,`,
      `  CASE WHEN ${predicates.join(' OR ')} THEN 1 ELSE 0 END AS violation_count`,
      `FROM ${quoteTableRef(tableName, dialect)}`,
    ].join('\n');
  }

  return countViolations(
    expectation,
    compileViolationRows(expectation, tableName, dialect),
    dialect
  );
}

export function generateExpectationSql(input: ExpectSqlInput): ExpectSqlStatement[] {
  return input.expectations.map((expectation) => ({
    modelName: input.modelName,
    kind: expectation.kind,
    target: expectationTarget(expectation),
    severity: expectationSeverity(expectation),
    sql: compileExpectationSql(expectation, input.tableName, input.outputColumns, input.dialect),
  }));
}
