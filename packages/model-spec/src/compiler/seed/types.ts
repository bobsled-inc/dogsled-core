/**
 * Seed column types: classification, per-dialect SQL types and typed literals.
 *
 * Seed specs accept a type name per column. Each name is classified into a
 * family (text, integer, float, exact, boolean, date, timestamp, time). The
 * family decides how a CSV value is written as a literal and compared in
 * `seed diff`; the dialect decides the column's SQL type. A name outside the
 * known list is rejected instead of being written as quoted text.
 */

import { getCanonicalDialect, quoteLiteral } from '../dialect.js';

import type { SupportedDialect } from '../dialect.js';

export type SeedTypeFamily =
  'text' | 'integer' | 'float' | 'exact' | 'boolean' | 'date' | 'timestamp' | 'time';

export interface SeedColumnType {
  family: SeedTypeFamily;
  /** Upper-case base name with single spaces, e.g. `NUMERIC` or `DOUBLE PRECISION`. */
  base: string;
  /** Digits inside the parentheses, normalized to `p` or `p, s`. */
  params?: string;
}

const FAMILIES: Record<string, SeedTypeFamily> = {
  STRING: 'text',
  VARCHAR: 'text',
  TEXT: 'text',
  CHAR: 'text',
  CHARACTER: 'text',
  'CHARACTER VARYING': 'text',
  NVARCHAR: 'text',
  NCHAR: 'text',
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SMALLINT: 'integer',
  TINYINT: 'integer',
  BYTEINT: 'integer',
  MEDIUMINT: 'integer',
  INT2: 'integer',
  INT4: 'integer',
  INT8: 'integer',
  INT64: 'integer',
  FLOAT: 'float',
  DOUBLE: 'float',
  'DOUBLE PRECISION': 'float',
  REAL: 'float',
  FLOAT4: 'float',
  FLOAT8: 'float',
  FLOAT64: 'float',
  NUMBER: 'float',
  DECIMAL: 'exact',
  NUMERIC: 'exact',
  BIGNUMERIC: 'exact',
  BIGDECIMAL: 'exact',
  BOOLEAN: 'boolean',
  BOOL: 'boolean',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
  DATETIME: 'timestamp',
  TIMESTAMP_NTZ: 'timestamp',
  TIMESTAMP_LTZ: 'timestamp',
  TIMESTAMP_TZ: 'timestamp',
  TIMESTAMPTZ: 'timestamp',
  TIME: 'time',
};

/** Families whose type may carry `(p)` or `(p, s)`. */
const PARAMETERIZED: ReadonlySet<SeedTypeFamily> = new Set(['text', 'exact', 'timestamp', 'time']);

/** The type names accepted in seed specs, for error messages and docs. */
export const SEED_TYPE_NAMES: readonly string[] = Object.keys(FAMILIES);

const TYPE_PATTERN =
  /^([A-Za-z][A-Za-z0-9_]*(?: [A-Za-z][A-Za-z0-9_]*)?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/;

/**
 * Classify a seed column type, or return `undefined` when it is not a
 * supported seed type. `NUMBER` alone is a float (as in seed validation);
 * `NUMBER(p, s)` is exact.
 */
export function classifySeedType(type: string): SeedColumnType | undefined {
  const match = TYPE_PATTERN.exec(type.trim().replace(/\s+/g, ' '));
  if (!match) return undefined;
  const base = match[1]!.toUpperCase();
  const params = match[2] ? (match[3] ? `${match[2]}, ${match[3]}` : match[2]) : undefined;
  let family = FAMILIES[base];
  if (!family) return undefined;
  if (params && base === 'NUMBER') family = 'exact';
  if (params && !PARAMETERIZED.has(family)) return undefined;
  return params ? { family, base, params } : { family, base };
}

/** A clear error for a seed column whose type is not supported. */
export function unsupportedSeedTypeMessage(seed: string, column: string, type: string): string {
  return (
    `Seed ${seed} column "${column}" has unsupported type "${type}". ` +
    'Use a type from the seed type table in the Model Spec README, for example STRING, ' +
    'INTEGER, BIGINT, DOUBLE, DECIMAL, NUMERIC(10, 2), BOOLEAN, DATE or TIMESTAMP.'
  );
}

const BUILT_IN = new Set([
  'STRING',
  'VARCHAR',
  'TEXT',
  'INTEGER',
  'INT',
  'NUMBER',
  'FLOAT',
  'DOUBLE',
  'DECIMAL',
  'BOOLEAN',
  'BOOL',
  'TIMESTAMP',
  'DATE',
]);

/**
 * The column's SQL type in `dialect`. Throws for an unsupported type; callers
 * validate first with {@link classifySeedType}.
 */
export function seedColumnSqlType(type: string, dialect: SupportedDialect): string {
  const classified = classifySeedType(type);
  if (!classified) throw new Error(`Unsupported seed column type "${type}".`);
  const canonicalDialect = getCanonicalDialect(dialect);
  if (canonicalDialect === 'clickhouse') return clickHouseType(classified);
  if (canonicalDialect === 'bigquery') return bigQueryType(classified);
  if (!classified.params && BUILT_IN.has(classified.base)) {
    return builtInType(classified.base, canonicalDialect);
  }
  if (classified.family === 'exact' && !classified.params && canonicalDialect !== 'postgres') {
    // An exact type without a scale rounds fractions; see DECIMAL below.
    const base = classified.base === 'NUMERIC' ? 'NUMERIC' : 'DECIMAL';
    return `${base}(38, 9)`;
  }
  // Other aliases and parameterized types are kept as written: they are valid
  // in the dialect that names them, and the warehouse reports any that are not.
  return classified.params ? `${classified.base}(${classified.params})` : classified.base;
}

function builtInType(base: string, dialect: ReturnType<typeof getCanonicalDialect>): string {
  switch (base) {
    case 'STRING':
      return dialect === 'databricks'
        ? 'STRING'
        : dialect === 'mysql' || dialect === 'postgres'
          ? 'VARCHAR(4096)'
          : 'VARCHAR';
    case 'VARCHAR':
    case 'TEXT':
      if (dialect === 'databricks') return 'STRING';
      if (dialect === 'mysql' && base === 'VARCHAR') return 'VARCHAR(4096)';
      return base;
    case 'INTEGER':
    case 'INT':
      return 'INTEGER';
    case 'NUMBER':
    case 'FLOAT':
    case 'DOUBLE':
      // NUMBER is a float in the seed vocabulary. Snowflake's bare NUMBER has
      // scale 0 and would round fractions, so it becomes FLOAT there too.
      return dialect === 'mysql' || dialect === 'databricks'
        ? 'DOUBLE'
        : dialect === 'snowflake'
          ? 'FLOAT'
          : 'DOUBLE PRECISION';
    case 'DECIMAL':
      // A bare DECIMAL defaults to scale 0 (Snowflake, MySQL, Databricks) or 3
      // (DuckDB), so give it the same precision as BigQuery NUMERIC. Postgres
      // DECIMAL without a precision is already exact and unbounded.
      return dialect === 'postgres' ? 'DECIMAL' : 'DECIMAL(38, 9)';
    case 'BOOLEAN':
    case 'BOOL':
      return 'BOOLEAN';
    case 'TIMESTAMP':
      return dialect === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
    default:
      return base;
  }
}

function bigQueryType({ family, base, params }: SeedColumnType): string {
  switch (family) {
    case 'text':
      return params ? `STRING(${params})` : 'STRING';
    case 'integer':
      return 'INT64';
    case 'float':
      return 'FLOAT64';
    case 'exact': {
      const big = base === 'BIGNUMERIC' || base === 'BIGDECIMAL' || !fitsNumeric(params);
      const name = big ? 'BIGNUMERIC' : 'NUMERIC';
      return params ? `${name}(${params})` : name;
    }
    case 'boolean':
      return 'BOOL';
    case 'date':
      return 'DATE';
    case 'timestamp':
      return base === 'DATETIME' || base === 'TIMESTAMP_NTZ' ? 'DATETIME' : 'TIMESTAMP';
    case 'time':
      return 'TIME';
  }
}

/** BigQuery NUMERIC(p, s) allows scale ≤ 9 and p - s ≤ 29. */
function fitsNumeric(params: string | undefined): boolean {
  if (!params) return true;
  const [precision = 0, scale = 0] = params.split(',').map((part) => Number(part.trim()));
  return scale <= 9 && precision - scale <= 29;
}

/**
 * ClickHouse columns reject NULL unless the type is explicitly wrapped, and a
 * seed emits a bare NULL for an empty CSV cell, so every type is `Nullable`.
 */
function clickHouseType({ family, params }: SeedColumnType): string {
  switch (family) {
    case 'text':
    case 'time':
      return 'Nullable(String)';
    case 'integer':
      return 'Nullable(Int64)';
    case 'float':
      return 'Nullable(Float64)';
    case 'exact':
      return `Nullable(Decimal(${params && params.includes(',') ? params : '38, 9'}))`;
    case 'boolean':
      return 'Nullable(Bool)';
    case 'date':
      return 'Nullable(Date)';
    case 'timestamp':
      return 'Nullable(DateTime64(3))';
  }
}

const INTEGER_TEXT = /^[-+]?\d+$/;
const FLOAT_TEXT = /^([-+]?)(\d*)(?:\.(\d*))?([eE][-+]?\d+)?$/;

function normalizeFloatText(value: string): string | undefined {
  const match = FLOAT_TEXT.exec(value);
  if (!match) return undefined;
  const [, sign = '', whole = '', fraction = '', exponent = ''] = match;
  if (whole === '' && fraction === '') return undefined;
  const integerPart = whole.replace(/^0+(?=\d)/, '') || '0';
  return `${sign === '-' ? '-' : ''}${integerPart}${fraction ? `.${fraction}` : ''}${exponent}`;
}

/**
 * Render one CSV cell as a SQL literal of the column's type, so warehouses
 * with strict typing (BigQuery) accept it. Values that do not parse cleanly
 * fall back to an explicit CAST of the quoted text, which the warehouse
 * validates; nothing is ever spliced in unquoted.
 */
export function seedValueLiteral(
  value: string | undefined,
  type: string,
  dialect: SupportedDialect
): string {
  const classified = classifySeedType(type);
  if (!classified) throw new Error(`Unsupported seed column type "${type}".`);
  if (value === undefined || value === '') return 'NULL';
  const trimmed = value.trim();
  if (classified.family === 'text') return quoteLiteral(value, dialect);
  // Validation treats a whitespace-only cell as blank, so load it as NULL.
  if (trimmed === '') return 'NULL';
  const cast = (): string =>
    `CAST(${quoteLiteral(trimmed, dialect)} AS ${castType(classified, type, dialect)})`;
  switch (classified.family) {
    case 'integer':
      return INTEGER_TEXT.test(trimmed) ? BigInt(trimmed).toString() : cast();
    case 'float':
      return normalizeFloatText(trimmed) ?? cast();
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', '1', 'yes'].includes(lower)) return 'TRUE';
      if (['false', '0', 'no'].includes(lower)) return 'FALSE';
      return cast();
    }
    case 'exact':
    case 'date':
    case 'timestamp':
    case 'time':
      return cast();
  }
}

/**
 * The CAST target for a fallback literal. MySQL CAST only targets SIGNED,
 * DECIMAL, DOUBLE, CHAR, DATE, DATETIME and TIME. BigQuery rejects
 * parameterized types in CAST, so it casts to the base type and the column's
 * parameters apply on insert.
 */
function castType(classified: SeedColumnType, type: string, dialect: SupportedDialect): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  if (canonicalDialect === 'mysql' && classified.family === 'integer') return 'SIGNED';
  const sqlType = seedColumnSqlType(type, dialect);
  return canonicalDialect === 'bigquery' ? sqlType.replace(/\(.*\)$/, '') : sqlType;
}
