/**
 * Function catalog for cross-dialect SQL codegen.
 *
 * Each entry maps a canonical (lowercase) function name to its arity constraints,
 * category, and optional per-dialect emitters. Functions absent from the catalog
 * pass through verbatim — this provides forward compatibility for new SQL functions.
 *
 * Emitter values:
 *  - `string`  — simple rename (e.g. `'POW'` emits `POW(args)`)
 *  - `(args: string[], dialect) => string` — full control over output
 *  - omitted dialect key — use the canonical name as-is
 */

import { quoteLiteral } from '../dialect.js';
import type { SupportedDialect } from '../dialect.js';
import { MODEL_SPEC_ERROR_CODES, modelSpecHint } from '../error-hints.js';
import { emitJsonPathSteps, validateJsonPathStepName } from './emitter.js';
import { CLEANING_FUNCTIONS } from './functions-cleaning.js';
import { FUZZY_FUNCTIONS } from './fuzzy.js';
import { TIER2_FUNCTIONS } from './functions-tier2.js';
import type { JsonPathStep } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FunctionCategory =
  | 'aggregate'
  | 'numeric'
  | 'string'
  | 'datetime'
  | 'conditional'
  | 'conversion'
  | 'json'
  | 'window'
  | 'hash'
  | 'geo'
  | 'fuzzy';

export type ExpressionValueType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'date'
  | 'array'
  | 'object'
  | 'unknown';

export interface FunctionArgDef {
  readonly name: string;
  readonly type: ExpressionValueType;
  readonly optional?: boolean;
}

export interface FunctionSignature {
  readonly args: readonly FunctionArgDef[];
  readonly returns: ExpressionValueType;
}

/** Either a simple rename string or a full emitter function. */
export type DialectEmitter = string | ((args: string[], dialect: SupportedDialect) => string);

export interface FunctionDef {
  /** Canonical lowercase name used in the Dogsled expression layer. */
  readonly name: string;
  /** Minimum number of arguments (inclusive). */
  readonly minArgs: number;
  /** Maximum number of arguments (-1 = variadic). */
  readonly maxArgs: number;
  /** Logical grouping for documentation / validation. */
  readonly category: FunctionCategory;
  /** Optional type signature for agents, UIs, and semantic validation. */
  readonly signature?: FunctionSignature;
  /** Short human-readable description surfaced in the expression manifest. */
  readonly description?: string;
  /** Example expressions using the canonical function name. */
  readonly examples?: readonly string[];
  /** Per-dialect emitters. Omitted dialects use the canonical name verbatim. */
  readonly emit: Partial<Record<SupportedDialect, DialectEmitter>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip surrounding single-quotes from a SQL string literal (e.g. `'day'` → `day`). */
function stripQuotes(s: string): string {
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

/**
 * Convert a `json_value(col, 'dotted.path')` literal argument into the
 * structured `JsonPathStep[]` consumed by `emitJsonPathSteps`. Empty
 * segments (from leading/trailing/duplicate dots) are skipped.
 *
 * Rejects leading `$` / `$.` — Model Spec auto-roots paths from `$`, so a
 * caller-supplied JSONPath like `'$.workspace.id'` would emit `$.$.workspace.id`
 * on BigQuery (and `:"$":workspace:id` on Snowflake). See JSON_PATH_DOUBLE_ROOT.
 */
function jsonPathStepsFromLiteral(pathLiteral: string): JsonPathStep[] {
  const stripped = stripQuotes(pathLiteral).trim();
  if (stripped === '$' || stripped.startsWith('$.') || stripped.startsWith('$[')) {
    throw new Error(
      modelSpecHint(
        MODEL_SPEC_ERROR_CODES.JSON_PATH_DOUBLE_ROOT,
        `json_value/json_query paths are relative — drop the leading '$' from ${JSON.stringify(stripped)}. ` +
          `MODEL_SPEC auto-roots from $; passing '$.foo' would emit '$.$.foo' on BigQuery.`
      )
    );
  }
  return stripped
    .split('.')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((name) => ({ kind: 'key', name }) satisfies JsonPathStep);
}

/** Emitter that renders `EXTRACT(UNIT FROM arg)`. */
function extractEmitter(unit: string): (args: string[]) => string {
  return (args) => `EXTRACT(${unit} FROM ${args[0]})`;
}

function requireTruncExpression(functionName: string, args: string[]): string {
  const expr = args[1];
  if (expr === undefined) {
    throw new Error(`${functionName} requires an expression argument`);
  }
  return expr;
}

/** Reorders truncation arguments for BigQuery's `<expr>, <UNIT>` signature. */
function emitBigQueryTrunc(functionName: 'DATE_TRUNC' | 'TIMESTAMP_TRUNC', args: string[]): string {
  const expr = requireTruncExpression(functionName, args);
  const unitUpper = stripQuotes(args[0]!).toUpperCase();
  if (unitUpper === 'WEEK') {
    return `${functionName}(${expr}, WEEK(MONDAY))`;
  }
  return `${functionName}(${expr}, ${unitUpper})`;
}

/** Emulates date-style truncation in MySQL, which lacks native `*_TRUNC` helpers. */
function emitMysqlDateTrunc(args: string[]): string {
  const unit = stripQuotes(args[0]!).toLowerCase();
  const expr = args[1]!;

  switch (unit) {
    case 'day':
      return `DATE(${expr})`;
    case 'hour':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:00:00') AS DATETIME)`;
    case 'minute':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:00') AS DATETIME)`;
    case 'second':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:%s') AS DATETIME)`;
    case 'week':
      return `DATE(DATE_SUB(${expr}, INTERVAL WEEKDAY(${expr}) DAY))`;
    case 'month':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-01') AS DATE)`;
    case 'quarter':
      return `MAKEDATE(YEAR(${expr}), 1) + INTERVAL (QUARTER(${expr}) - 1) QUARTER`;
    case 'year':
      return `CAST(DATE_FORMAT(${expr}, '%Y-01-01') AS DATE)`;
    default:
      throw new Error(`Unsupported MySQL truncation unit "${unit}"`);
  }
}

/** Preserves timestamp semantics when emulating timestamp truncation in MySQL. */
function emitMysqlTimestampTrunc(args: string[]): string {
  const unit = stripQuotes(args[0]!).toLowerCase();
  const expr = args[1]!;

  switch (unit) {
    case 'day':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d 00:00:00') AS DATETIME)`;
    case 'hour':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:00:00') AS DATETIME)`;
    case 'minute':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:00') AS DATETIME)`;
    case 'second':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:%s') AS DATETIME)`;
    case 'week':
      return `CAST(CONCAT(DATE_FORMAT(DATE_SUB(${expr}, INTERVAL WEEKDAY(${expr}) DAY), '%Y-%m-%d'), ' 00:00:00') AS DATETIME)`;
    case 'month':
      return `CAST(DATE_FORMAT(${expr}, '%Y-%m-01 00:00:00') AS DATETIME)`;
    case 'quarter':
      return `CAST(DATE_FORMAT(MAKEDATE(YEAR(${expr}), 1) + INTERVAL (QUARTER(${expr}) - 1) QUARTER, '%Y-%m-%d 00:00:00') AS DATETIME)`;
    case 'year':
      return `CAST(DATE_FORMAT(${expr}, '%Y-01-01 00:00:00') AS DATETIME)`;
    default:
      throw new Error(`Unsupported MySQL timestamp truncation unit "${unit}"`);
  }
}

/** Emits `DATE_TRUNC` variants that take `(unit, expr)` with quoted units. */
function emitQuotedDateTrunc(
  functionName: string,
  args: string[],
  dialect: SupportedDialect
): string {
  const unit = stripQuotes(args[0]!);
  const expr = requireTruncExpression(functionName, args);
  return `${functionName}(${quoteLiteral(unit, dialect)}, ${expr})`;
}

/** Snowflake prefers uppercased date-part literals in truncation calls. */
function emitSnowflakeTrunc(args: string[], dialect: SupportedDialect): string {
  const expr = requireTruncExpression('DATE_TRUNC', args);
  const unit = stripQuotes(args[0]!).toUpperCase();
  return `DATE_TRUNC(${quoteLiteral(unit, dialect)}, ${expr})`;
}

/**
 * ClickHouse's `date_add` takes the unit as an unquoted keyword. A quoted unit
 * parses as the binary `plus` function instead, which then fails on three
 * arguments rather than adding an interval.
 */
function emitClickhouseDateAdd(args: string[]): string {
  const unit = stripQuotes(args[0]!).toUpperCase();
  return `date_add(${unit}, ${args[1]}, ${args[2]})`;
}

/**
 * ClickHouse hash builtins return raw `FixedString` bytes, while Snowflake,
 * Postgres, DuckDB, and MySQL all return lowercase hex text. Hex keeps one
 * model's hash comparable and displayable across targets.
 */
function emitClickhouseHexHash(fn: string, expr: string): string {
  return `lower(hex(${fn}(${expr})))`;
}

/** Shortcut to define a fully-verbatim function (same name on all dialects). */
function verbatim(
  name: string,
  minArgs: number,
  maxArgs: number,
  category: FunctionCategory
): FunctionDef {
  return { name, minArgs, maxArgs, category, emit: {} };
}

/**
 * Shortcut for a string function whose default ClickHouse builtin counts bytes.
 *
 * `UPPER('café')` returns `CAFé`, `LENGTH('café')` returns 5, `RIGHT('café', 3)`
 * returns two characters, and `REVERSE('café')` returns invalid UTF-8. Every
 * other dialect in this catalog counts codepoints, so textual functions route to
 * the ClickHouse `*UTF8` variant.
 */
function utf8String(
  name: string,
  minArgs: number,
  maxArgs: number,
  clickhouseName: string
): FunctionDef {
  return { name, minArgs, maxArgs, category: 'string', emit: { clickhouse: clickhouseName } };
}

// ---------------------------------------------------------------------------
// Aggregate functions (12)
// ---------------------------------------------------------------------------

const AGGREGATE_FUNCTIONS: FunctionDef[] = [
  verbatim('count', 0, 1, 'aggregate'),
  {
    name: 'count_distinct',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: (args) => `COUNT(DISTINCT ${args[0]})`,
      bigquery: (args) => `COUNT(DISTINCT ${args[0]})`,
      postgres: (args) => `COUNT(DISTINCT ${args[0]})`,
      databricks: (args) => `COUNT(DISTINCT ${args[0]})`,
      mysql: (args) => `COUNT(DISTINCT ${args[0]})`,
      duckdb: (args) => `COUNT(DISTINCT ${args[0]})`,
      clickhouse: (args) => `COUNT(DISTINCT ${args[0]})`,
    },
  },
  verbatim('sum', 1, 1, 'aggregate'),
  verbatim('avg', 1, 1, 'aggregate'),
  verbatim('min', 1, 1, 'aggregate'),
  verbatim('max', 1, 1, 'aggregate'),
  {
    name: 'listagg',
    minArgs: 1,
    maxArgs: 2,
    category: 'aggregate',
    emit: {
      snowflake: (args) => `LISTAGG(${args.join(', ')})`,
      bigquery: 'STRING_AGG',
      postgres: 'STRING_AGG',
      databricks: 'STRING_AGG',
      mysql: 'GROUP_CONCAT',
      duckdb: 'STRING_AGG',
      // CH: groupConcat only landed in 24.10 and takes its delimiter as a
      // parameter rather than an argument, so build the string from the array.
      clickhouse: (args) =>
        args.length >= 2
          ? `arrayStringConcat(groupArray(${args[0]}), ${args[1]})`
          : `arrayStringConcat(groupArray(${args[0]}))`,
    },
  },
  {
    name: 'approx_count_distinct',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      clickhouse: 'uniq',
    },
  },
  // CH resolves ARRAY_AGG case-insensitively to groupArray.
  verbatim('array_agg', 1, 1, 'aggregate'),
  {
    name: 'bool_and',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: 'BOOLAND_AGG',
      bigquery: 'LOGICAL_AND',
      // CH has no boolean aggregate; MIN over false < true is the conjunction
      // and skips NULLs exactly like Postgres BOOL_AND.
      clickhouse: 'min',
    },
  },
  {
    name: 'bool_or',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: 'BOOLOR_AGG',
      bigquery: 'LOGICAL_OR',
      clickhouse: 'max',
    },
  },
  {
    name: 'countif',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: 'COUNT_IF',
      bigquery: 'COUNTIF',
      postgres: (args) => `COUNT(*) FILTER (WHERE ${args[0]})`,
      databricks: 'COUNT_IF',
      duckdb: 'COUNT_IF',
      // CH combinator names are case-sensitive: COUNTIF does not resolve.
      clickhouse: 'countIf',
    },
  },
];

// ---------------------------------------------------------------------------
// Date/Time functions (16)
// ---------------------------------------------------------------------------

const DATETIME_FUNCTIONS: FunctionDef[] = [
  {
    name: 'date_trunc',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      // SF: DATE_TRUNC('unit', expr) — canonical form
      // CH: resolves DATE_TRUNC case-insensitively to dateTrunc, which takes the
      //     canonical ('unit', expr) order with a case-insensitive quoted unit
      // BQ: DATE_TRUNC(expr, UNIT) — reversed args, unquoted unit
      bigquery: (args) => emitBigQueryTrunc('DATE_TRUNC', args),
      // MySQL has no DATE_TRUNC; emulate with DATE_FORMAT + CAST
      mysql: emitMysqlDateTrunc,
    },
  },
  {
    name: 'timestamp_trunc',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      bigquery: (args) => emitBigQueryTrunc('TIMESTAMP_TRUNC', args),
      snowflake: (args, dialect) => emitSnowflakeTrunc(args, dialect),
      postgres: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
      databricks: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
      mysql: emitMysqlTimestampTrunc,
      duckdb: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
      pgvector: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
      redshift: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
      // CH has no TIMESTAMP_TRUNC at all; date_trunc keeps sub-day precision.
      clickhouse: (args, dialect) => emitQuotedDateTrunc('date_trunc', args, dialect),
    },
  },
  {
    name: 'datediff',
    minArgs: 3,
    maxArgs: 3,
    category: 'datetime',
    emit: {
      // SF/DB: DATEDIFF(unit, start, end)
      // BQ: DATE_DIFF(end, start, UNIT) — reversed + renamed + unquoted unit
      bigquery: (args) => {
        const unit = stripQuotes(args[0]!);
        return `DATE_DIFF(${args[2]}, ${args[1]}, ${unit.toUpperCase()})`;
      },
      // PG: (end::date - start::date) for day, or custom interval math
      postgres: (args) => {
        const unit = stripQuotes(args[0]!).toLowerCase();
        if (unit === 'day') {
          return `(${args[2]}::date - ${args[1]}::date)`;
        }
        return `EXTRACT(EPOCH FROM (${args[2]}::timestamp - ${args[1]}::timestamp)) / ${pgIntervalDivisor(unit)}`;
      },
    },
  },
  {
    name: 'timestamp_diff',
    minArgs: 3,
    maxArgs: 3,
    category: 'datetime',
    emit: {
      // Canonical: timestamp_diff('unit', start, end) — same arg order as datediff
      // SF: TIMESTAMPDIFF(UNIT, start, end) — unquoted unit
      snowflake: (args) => {
        const unit = stripQuotes(args[0]!);
        return `TIMESTAMPDIFF(${unit.toUpperCase()}, ${args[1]}, ${args[2]})`;
      },
      // BQ: TIMESTAMP_DIFF(end, start, UNIT) — reversed args, unquoted unit
      bigquery: (args) => {
        const unit = stripQuotes(args[0]!);
        return `TIMESTAMP_DIFF(${args[2]}, ${args[1]}, ${unit.toUpperCase()})`;
      },
      // PG: whole elapsed units, or calendar months from age(end, start).
      postgres: emitPostgresTimestampDiff,
      // Preserve Redshift's existing emulation; PostgreSQL age() is unsupported there.
      redshift: (args) => {
        const unit = stripQuotes(args[0]!).toLowerCase();
        const epoch = `EXTRACT(EPOCH FROM (${args[2]}::timestamp - ${args[1]}::timestamp))`;
        return unit === 'second' ? epoch : `${epoch} / ${pgIntervalDivisor(unit)}`;
      },
      // DB: TIMESTAMPDIFF(UNIT, start, end)
      databricks: (args) => {
        const unit = stripQuotes(args[0]!);
        return `TIMESTAMPDIFF(${unit.toUpperCase()}, ${args[1]}, ${args[2]})`;
      },
      // DuckDB counts unit boundaries, with a quoted lowercase unit.
      duckdb: (args, dialect) => {
        const unit = stripQuotes(args[0]!).toLowerCase();
        return `date_diff(${quoteLiteral(unit, dialect)}, ${args[1]}, ${args[2]})`;
      },
    },
  },
  {
    name: 'dateadd',
    minArgs: 3,
    maxArgs: 3,
    category: 'datetime',
    emit: {
      // SF/DB: DATEADD(unit, amount, date)
      // BQ: DATE_ADD(date, INTERVAL amount UNIT)
      bigquery: (args) => {
        const unit = stripQuotes(args[0]!);
        return `DATE_ADD(${args[2]}, INTERVAL ${args[1]} ${unit.toUpperCase()})`;
      },
      // PG: date + INTERVAL 'amount unit'
      postgres: (args) => {
        const unit = stripQuotes(args[0]!);
        return `(${args[2]} + INTERVAL '${args[1]} ${unit}')`;
      },
      // CH: date_add(UNIT, amount, date) — same order, but unquoted unit
      clickhouse: emitClickhouseDateAdd,
    },
  },
  {
    name: 'date_part',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      bigquery: (args) => `EXTRACT(${stripQuotes(args[0]!)} FROM ${args[1]})`,
      postgres: (args) => `EXTRACT(${stripQuotes(args[0]!)} FROM ${args[1]})`,
      databricks: (args) => `EXTRACT(${stripQuotes(args[0]!)} FROM ${args[1]})`,
    },
  },
  {
    name: 'year',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('YEAR'),
      postgres: extractEmitter('YEAR'),
    },
  },
  {
    name: 'month',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('MONTH'),
      postgres: extractEmitter('MONTH'),
    },
  },
  {
    name: 'day',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('DAY'),
      postgres: extractEmitter('DAY'),
    },
  },
  {
    name: 'hour',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('HOUR'),
      postgres: extractEmitter('HOUR'),
    },
  },
  {
    name: 'current_date',
    minArgs: 0,
    maxArgs: 0,
    category: 'datetime',
    emit: {
      bigquery: () => 'CURRENT_DATE()',
      databricks: () => 'CURRENT_DATE()',
    },
  },
  {
    name: 'current_timestamp',
    minArgs: 0,
    maxArgs: 0,
    category: 'datetime',
    emit: {
      bigquery: () => 'CURRENT_TIMESTAMP()',
      postgres: () => 'NOW()',
      databricks: () => 'CURRENT_TIMESTAMP()',
    },
  },
  {
    name: 'to_date',
    minArgs: 1,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      // BQ: PARSE_DATE(fmt, x) for 2-arg; DATE(x) for 1-arg
      bigquery: (args) =>
        args.length >= 2 ? `PARSE_DATE(${args[1]}, ${args[0]})` : `DATE(${args[0]})`,
      // CH has no TO_DATE. parseDateTime reads MySQL-style format specifiers,
      // the same family DuckDB's strptime takes.
      clickhouse: (args) =>
        args.length >= 2 ? `toDate(parseDateTime(${args[0]}, ${args[1]}))` : `toDate(${args[0]})`,
    },
  },
  {
    name: 'to_timestamp',
    minArgs: 1,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      // BQ: PARSE_TIMESTAMP(fmt, x) for 2-arg; TIMESTAMP(x) for 1-arg
      bigquery: (args) =>
        args.length >= 2 ? `PARSE_TIMESTAMP(${args[1]}, ${args[0]})` : `TIMESTAMP(${args[0]})`,
      // CH has no TO_TIMESTAMP. Not toDateTime: that is UInt32-backed and covers
      // only 1970-2106, so DateTime64 matches what parse_date already returns.
      clickhouse: (args) =>
        args.length >= 2 ? `parseDateTime(${args[0]}, ${args[1]})` : `toDateTime64(${args[0]}, 3)`,
    },
  },
  {
    name: 'last_day',
    minArgs: 1,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      // PG has no LAST_DAY; emulate with interval math
      postgres: (args) => {
        const expr = args[0];
        return `(DATE_TRUNC('month', ${expr}) + INTERVAL '1 month' - INTERVAL '1 day')::date`;
      },
    },
  },
  {
    name: 'date_from_parts',
    minArgs: 3,
    maxArgs: 3,
    category: 'datetime',
    emit: {
      bigquery: (args) => `DATE(${args.join(', ')})`,
      postgres: (args) => `MAKE_DATE(${args.join(', ')})`,
      databricks: (args) => `MAKE_DATE(${args.join(', ')})`,
      clickhouse: (args) => `makeDate(${args.join(', ')})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Conditional functions (8)
// ---------------------------------------------------------------------------

const CONDITIONAL_FUNCTIONS: FunctionDef[] = [
  verbatim('coalesce', 1, -1, 'conditional'),
  verbatim('nullif', 2, 2, 'conditional'),
  {
    name: 'ifnull',
    minArgs: 2,
    maxArgs: 2,
    category: 'conditional',
    emit: {
      postgres: 'COALESCE',
      databricks: 'COALESCE',
    },
  },
  {
    name: 'nvl',
    minArgs: 2,
    maxArgs: 2,
    category: 'conditional',
    emit: {
      bigquery: 'IFNULL',
      postgres: 'COALESCE',
      clickhouse: 'ifNull',
    },
  },
  {
    name: 'iff',
    minArgs: 3,
    maxArgs: 3,
    category: 'conditional',
    emit: {
      bigquery: 'IF',
      postgres: (args) => `CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END`,
      databricks: 'IF',
      duckdb: 'IF',
      clickhouse: 'if',
    },
  },
  {
    name: 'zeroifnull',
    minArgs: 1,
    maxArgs: 1,
    category: 'conditional',
    emit: {
      bigquery: (args) => `IFNULL(${args[0]}, 0)`,
      duckdb: (args) => `COALESCE(${args[0]}, 0)`,
      postgres: (args) => `COALESCE(${args[0]}, 0)`,
      databricks: (args) => `COALESCE(${args[0]}, 0)`,
      clickhouse: (args) => `ifNull(${args[0]}, 0)`,
    },
  },
  {
    name: 'try_cast',
    minArgs: 2,
    maxArgs: 2,
    category: 'conditional',
    emit: {
      bigquery: 'SAFE_CAST',
      // PG: no native TRY_CAST — approximate with CASE + regex guard
      postgres: (args) => {
        const expr = args[0];
        const targetType = args[1];
        return `CASE WHEN ${expr} IS NOT NULL THEN CAST(${expr} AS ${targetType}) END`;
      },
      // CH has no TRY_CAST; accurateCastOrNull is its NULL-on-failure form and
      // takes the target type as a string instead of after AS.
      clickhouse: (args, dialect) =>
        `accurateCastOrNull(${args[0]}, ${quoteLiteral(stripQuotes(args[1]!), dialect)})`,
    },
  },
  {
    name: 'decode',
    minArgs: 3,
    maxArgs: -1,
    category: 'conditional',
    emit: {
      // BQ/PG/DB/DuckDB/CH: emulate with CASE expression
      bigquery: decodeToCaseEmitter,
      postgres: decodeToCaseEmitter,
      databricks: decodeToCaseEmitter,
      duckdb: decodeToCaseEmitter,
      clickhouse: decodeToCaseEmitter,
    },
  },
];

// ---------------------------------------------------------------------------
// Numeric functions (14)
// ---------------------------------------------------------------------------

const NUMERIC_FUNCTIONS: FunctionDef[] = [
  verbatim('abs', 1, 1, 'numeric'),
  verbatim('ceil', 1, 1, 'numeric'),
  verbatim('floor', 1, 1, 'numeric'),
  verbatim('round', 1, 2, 'numeric'),
  verbatim('trunc', 1, 2, 'numeric'),
  verbatim('mod', 2, 2, 'numeric'),
  verbatim('sqrt', 1, 1, 'numeric'),
  verbatim('ln', 1, 1, 'numeric'),
  verbatim('exp', 1, 1, 'numeric'),
  verbatim('greatest', 2, -1, 'numeric'),
  verbatim('least', 2, -1, 'numeric'),
  {
    name: 'power',
    minArgs: 2,
    maxArgs: 2,
    category: 'numeric',
    emit: {
      bigquery: 'POW',
    },
  },
  {
    name: 'log',
    minArgs: 1,
    maxArgs: 2,
    category: 'numeric',
    emit: {
      // BQ: LOG(x, base) — reversed from SF LOG(base, x)
      bigquery: (args) => (args.length === 2 ? `LOG(${args[1]}, ${args[0]})` : `LOG(${args[0]})`),
      // CH: log takes exactly one argument, so change the base by division
      clickhouse: (args) =>
        args.length === 2 ? `(log(${args[1]}) / log(${args[0]}))` : `log(${args[0]})`,
    },
  },
  {
    name: 'div0',
    minArgs: 2,
    maxArgs: 2,
    category: 'numeric',
    emit: {
      bigquery: (args) => `IFNULL(SAFE_DIVIDE(${args[0]}, ${args[1]}), 0)`,
      postgres: (args) => `CASE WHEN ${args[1]} = 0 THEN 0 ELSE ${args[0]} / ${args[1]} END`,
      databricks: (args) => `CASE WHEN ${args[1]} = 0 THEN 0 ELSE ${args[0]} / ${args[1]} END`,
      duckdb: (args) => `CASE WHEN ${args[1]} = 0 THEN 0 ELSE ${args[0]} / ${args[1]} END`,
      // CH float division by zero yields inf rather than NULL, so guard first.
      clickhouse: (args) => `CASE WHEN ${args[1]} = 0 THEN 0 ELSE ${args[0]} / ${args[1]} END`,
    },
  },
];

// ---------------------------------------------------------------------------
// String functions (18)
// ---------------------------------------------------------------------------

const STRING_FUNCTIONS: FunctionDef[] = [
  verbatim('concat', 1, -1, 'string'),
  utf8String('upper', 1, 1, 'upperUTF8'),
  utf8String('lower', 1, 1, 'lowerUTF8'),
  // trim/ltrim/rtrim strip ASCII whitespace, which is byte-safe on UTF-8.
  verbatim('trim', 1, 1, 'string'),
  verbatim('ltrim', 1, 2, 'string'),
  verbatim('rtrim', 1, 2, 'string'),
  utf8String('length', 1, 1, 'lengthUTF8'),
  utf8String('left', 2, 2, 'leftUTF8'),
  utf8String('right', 2, 2, 'rightUTF8'),
  // CH resolves REPLACE case-insensitively to replaceAll, and substring search
  // over UTF-8 bytes is equivalent to searching codepoints.
  verbatim('replace', 2, 3, 'string'),
  verbatim('repeat', 2, 2, 'string'),
  utf8String('reverse', 1, 1, 'reverseUTF8'),
  utf8String('lpad', 2, 3, 'leftPadUTF8'),
  utf8String('rpad', 2, 3, 'rightPadUTF8'),
  utf8String('initcap', 1, 1, 'initcapUTF8'),
  // CH resolves REGEXP_REPLACE case-insensitively to replaceRegexpAll, which
  // matches the replace-every-occurrence default of the other dialects.
  verbatim('regexp_replace', 2, 4, 'string'),
  {
    name: 'substring',
    minArgs: 2,
    maxArgs: 3,
    category: 'string',
    emit: {
      snowflake: 'SUBSTR',
      bigquery: 'SUBSTR',
      clickhouse: 'substringUTF8',
    },
  },
  {
    name: 'split_part',
    minArgs: 3,
    maxArgs: 3,
    category: 'string',
    emit: {
      snowflake: (args) => `SPLIT_PART(${args[0]}, ${args[1]}, ${args[2]})`,
      bigquery: (args) => `SPLIT(${args[0]}, ${args[1]})[SAFE_OFFSET(${args[2]} - 1)]`,
      postgres: (args) => `split_part(${args[0]}, ${args[1]}, ${args[2]})`,
      pgvector: (args) => `split_part(${args[0]}, ${args[1]}, ${args[2]})`,
      redshift: (args) => `SPLIT_PART(${args[0]}, ${args[1]}, ${args[2]})`,
      duckdb: (args) => `split_part(${args[0]}, ${args[1]}, ${args[2]})`,
      databricks: (args) => `split_part(${args[0]}, ${args[1]}, ${args[2]})`,
      mysql: (args) =>
        `SUBSTRING_INDEX(SUBSTRING_INDEX(${args[0]}, ${args[1]}, ${args[2]}), ${args[1]}, -1)`,
      // CH: splitByString takes the separator first, and its 1-based array index
      // returns '' past the end, matching SPLIT_PART elsewhere.
      clickhouse: (args) => `splitByString(${args[1]}, ${args[0]})[${args[2]}]`,
    },
  },
];

// ---------------------------------------------------------------------------
// Conversion functions (1 — cast is handled by parser, not catalog)
// ---------------------------------------------------------------------------

const CONVERSION_FUNCTIONS: FunctionDef[] = [
  {
    name: 'to_varchar',
    minArgs: 1,
    maxArgs: 2,
    category: 'conversion',
    emit: {
      bigquery: (args) =>
        args.length >= 2 ? `FORMAT(${args[1]}, ${args[0]})` : `CAST(${args[0]} AS STRING)`,
      postgres: 'TO_CHAR',
      databricks: (args) => `CAST(${args[0]} AS STRING)`,
      duckdb: (args) => `CAST(${args[0]} AS VARCHAR)`,
      // CH has no TO_VARCHAR. Like Databricks and DuckDB, the optional format
      // model has no portable equivalent and is dropped.
      clickhouse: (args) => `toString(${args[0]})`,
    },
  },
];

// ---------------------------------------------------------------------------
// JSON functions (2)
// ---------------------------------------------------------------------------

const emitJsonValueViaSteps = (args: string[], dialect: SupportedDialect): string => {
  return emitJsonPathSteps(args[0]!, jsonPathStepsFromLiteral(args[1]!), dialect, true);
};

/**
 * Databricks uses GET_JSON_OBJECT (text extractor) rather than struct-style
 * dot access — different semantics from the AST emitter, but we still route
 * through jsonPathStepsFromLiteral so step validation stays consistent.
 */
const emitDatabricksJsonValue = (args: string[]): string => {
  const steps = jsonPathStepsFromLiteral(args[1]!);
  let path = '$';
  for (const step of steps) {
    if (step.kind !== 'key') continue;
    validateJsonPathStepName(step.name);
    path += `.${step.name}`;
  }
  return `GET_JSON_OBJECT(${args[0]}, '${path.replace(/'/g, "''")}')`;
};

const JSON_FUNCTIONS: FunctionDef[] = [
  {
    name: 'json_value',
    minArgs: 2,
    maxArgs: 2,
    category: 'json',
    emit: {
      snowflake: emitJsonValueViaSteps,
      bigquery: emitJsonValueViaSteps,
      postgres: emitJsonValueViaSteps,
      databricks: emitDatabricksJsonValue,
      duckdb: emitJsonValueViaSteps,
      // CH does have JSON_VALUE, but it demands a `$`-rooted JSONPath while Model Spec
      // paths are relative, so route through the JSONExtract* step emitter.
      clickhouse: emitJsonValueViaSteps,
    },
  },
  {
    name: 'parse_json',
    minArgs: 1,
    maxArgs: 1,
    category: 'json',
    emit: {
      postgres: (args) => `${args[0]}::jsonb`,
      databricks: (args) => `FROM_JSON(${args[0]})`,
      duckdb: (args) => `${args[0]}::JSON`,
      // CH JSON accessors read String directly, so normalize to String rather
      // than parsing into the (still-young) JSON column type.
      clickhouse: (args) => `toString(${args[0]})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Hash functions (2)
// ---------------------------------------------------------------------------

const HASH_FUNCTIONS: FunctionDef[] = [
  {
    name: 'md5',
    minArgs: 1,
    maxArgs: 1,
    category: 'hash',
    emit: {
      clickhouse: (args) => emitClickhouseHexHash('MD5', args[0]!),
    },
  },
  {
    name: 'sha2',
    minArgs: 1,
    maxArgs: 2,
    category: 'hash',
    emit: {
      bigquery: (args) => {
        const bits = args.length >= 2 ? args[1] : '256';
        if (bits === '512') return `SHA512(${args[0]})`;
        return `SHA256(${args[0]})`;
      },
      postgres: (args) => {
        const bits = args.length >= 2 ? args[1] : '256';
        if (bits === '512') return `ENCODE(DIGEST(${args[0]}, 'sha512'), 'hex')`;
        return `ENCODE(DIGEST(${args[0]}, 'sha256'), 'hex')`;
      },
      duckdb: (args) => {
        const bits = args.length >= 2 ? args[1] : '256';
        if (bits === '512') return `sha512(${args[0]})`;
        return `sha256(${args[0]})`;
      },
      // CH has no SHA2; SHA256/SHA512 exist but return raw bytes.
      clickhouse: (args) => {
        const bits = args.length >= 2 ? args[1] : '256';
        if (bits === '512') return emitClickhouseHexHash('SHA512', args[0]!);
        return emitClickhouseHexHash('SHA256', args[0]!);
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Shared emitter helpers (used by Tier 1 definitions above)
// ---------------------------------------------------------------------------

/**
 * Convert a DECODE(expr, search1, result1, ..., [default]) call into a
 * standard CASE WHEN ... END expression.
 */
function decodeToCaseEmitter(args: string[]): string {
  if (args.length < 3) {
    return `DECODE(${args.join(', ')})`; // fall back — shouldn't happen with arity check
  }

  const expr = args[0];
  const pairs: string[] = [];

  let i = 1;
  while (i + 1 < args.length) {
    pairs.push(`WHEN ${expr} = ${args[i]} THEN ${args[i + 1]}`);
    i += 2;
  }

  // Odd remaining arg is the default
  const hasDefault = i < args.length;
  const elsePart = hasDefault ? ` ELSE ${args[i]}` : '';

  return `CASE ${pairs.join(' ')}${elsePart} END`;
}

/** PostgreSQL has no TIMESTAMPDIFF; truncate before casting to avoid rounding. */
function emitPostgresTimestampDiff(args: string[]): string {
  const unit = stripQuotes(args[0]!).toLowerCase();
  const start = `CAST(${args[1]} AS TIMESTAMP)`;
  const end = `CAST(${args[2]} AS TIMESTAMP)`;
  const epoch = `EXTRACT(EPOCH FROM (${end} - ${start}))`;
  let difference: string;

  switch (unit) {
    case 'microsecond':
      difference = `${epoch} * 1000000`;
      break;
    case 'millisecond':
      difference = `${epoch} * 1000`;
      break;
    case 'second':
      difference = epoch;
      break;
    case 'minute':
      difference = `${epoch} / 60`;
      break;
    case 'hour':
      difference = `${epoch} / 3600`;
      break;
    case 'day':
      difference = `${epoch} / 86400`;
      break;
    case 'week':
      difference = `${epoch} / 604800`;
      break;
    case 'month':
    case 'quarter':
    case 'year': {
      const age = `age(${end}, ${start})`;
      const months = `(EXTRACT(YEAR FROM ${age}) * 12 + EXTRACT(MONTH FROM ${age}))`;
      difference = unit === 'month' ? months : `${months} / ${unit === 'quarter' ? 3 : 12}`;
      break;
    }
    default:
      throw new Error(
        `Unsupported PostgreSQL timestamp_diff unit "${unit}"; expected microsecond, millisecond, second, minute, hour, day, week, month, quarter, or year`
      );
  }

  return `CAST(TRUNC(${difference}) AS BIGINT)`;
}

/**
 * Return the number of seconds in one unit, used for PG DATEDIFF emulation.
 */
function pgIntervalDivisor(unit: string): number {
  switch (unit) {
    case 'second':
      return 1;
    case 'minute':
      return 60;
    case 'hour':
      return 3600;
    case 'day':
      return 86400;
    case 'week':
      return 604800;
    case 'month':
      return 2592000; // approximate 30 days
    case 'year':
      return 31536000; // approximate 365 days
    default:
      return 86400; // default to days
  }
}

// ---------------------------------------------------------------------------
// Build the catalog
// ---------------------------------------------------------------------------

const ALL_FUNCTIONS: FunctionDef[] = [
  // Tier 1
  ...AGGREGATE_FUNCTIONS,
  ...DATETIME_FUNCTIONS,
  ...CONDITIONAL_FUNCTIONS,
  ...NUMERIC_FUNCTIONS,
  ...STRING_FUNCTIONS,
  ...CONVERSION_FUNCTIONS,
  ...JSON_FUNCTIONS,
  ...HASH_FUNCTIONS,
  // Tier 2 (imported from functions-tier2.ts)
  ...TIER2_FUNCTIONS,
  // Cleaning primitives (collapse_whitespace, strip_legal_suffixes, strip_www, digits_only, strip_country_code, remove_punctuation, parse_date)
  ...CLEANING_FUNCTIONS,
  // Fuzzy functions intentionally come last so their typed metadata wins over
  // legacy verbatim aliases such as soundex.
  ...FUZZY_FUNCTIONS,
];

/**
 * Master function catalog keyed by canonical lowercase name.
 *
 * Functions not present in the catalog pass through verbatim — the emitter
 * uses the function name as-is, providing forward compatibility.
 */
export const FUNCTION_CATALOG: ReadonlyMap<string, FunctionDef> = new Map(
  ALL_FUNCTIONS.map((fn) => [fn.name, fn])
);
