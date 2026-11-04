/**
 * Tier 2 — Extended function definitions for the cross-dialect SQL catalog.
 *
 * Split from functions.ts to stay within the repo's file-size budget.
 * See functions.ts for the catalog types, helpers, and Tier 1 definitions.
 */

import { unsupportedDialectFeatureError } from '../dialect.js';
import type { FunctionDef, FunctionCategory } from './functions.js';

// ---------------------------------------------------------------------------
// Helpers (re-used locally)
// ---------------------------------------------------------------------------

/** Strip surrounding single-quotes from a SQL string literal (e.g. `'day'` → `day`). */
function stripQuotes(s: string): string {
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

/** Emitter that renders `EXTRACT(UNIT FROM arg)`. */
function extractEmitter(unit: string): (args: string[]) => string {
  return (args) => `EXTRACT(${unit} FROM ${args[0]})`;
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
 * ClickHouse's LAG/LEAD/NTH_VALUE return the argument type's default value — `0`
 * for a numeric column — where every other dialect returns NULL for a row that
 * falls outside the frame. Widening the argument restores the standard result;
 * an explicit user-supplied default still wins over the NULL.
 */
function clickhouseNullableWindow(fn: string): (args: string[]) => string {
  return (args) => {
    const rest = args.slice(1).map((arg) => `, ${arg}`);
    return `${fn}(toNullable(${args[0]})${rest.join('')})`;
  };
}

/**
 * ClickHouse has no geography type and no NEXT_DAY, and neither has a faithful
 * substitute. Failing during compilation names the target, where the verbatim
 * fallback would emit SQL that only fails later against the server.
 */
function clickhouseUnsupported(functionName: string, detail: string): () => never {
  return () => {
    throw unsupportedDialectFeatureError(
      'clickhouse',
      `catalogFunction:${functionName}`,
      `${functionName} is not supported for compiler target "clickhouse": ${detail}`
    );
  };
}

// ---------------------------------------------------------------------------
// Window functions (11)
// ---------------------------------------------------------------------------

const WINDOW_FUNCTIONS: FunctionDef[] = [
  verbatim('row_number', 0, 0, 'window'),
  verbatim('rank', 0, 0, 'window'),
  verbatim('dense_rank', 0, 0, 'window'),
  verbatim('ntile', 1, 1, 'window'),
  {
    name: 'lag',
    minArgs: 1,
    maxArgs: 3,
    category: 'window',
    emit: { clickhouse: clickhouseNullableWindow('LAG') },
  },
  {
    name: 'lead',
    minArgs: 1,
    maxArgs: 3,
    category: 'window',
    emit: { clickhouse: clickhouseNullableWindow('LEAD') },
  },
  // CH resolves FIRST_VALUE/LAST_VALUE to any/anyLast; both always see the
  // current row, so neither can fall off the frame the way LAG/LEAD can.
  verbatim('first_value', 1, 1, 'window'),
  verbatim('last_value', 1, 1, 'window'),
  {
    name: 'nth_value',
    minArgs: 2,
    maxArgs: 2,
    category: 'window',
    emit: { clickhouse: clickhouseNullableWindow('NTH_VALUE') },
  },
  {
    name: 'cume_dist',
    minArgs: 0,
    maxArgs: 0,
    category: 'window',
    // CH registers cume_dist case-sensitively: CUME_DIST does not resolve.
    emit: { clickhouse: () => 'cume_dist()' },
  },
  verbatim('percent_rank', 0, 0, 'window'),
  {
    name: 'ratio_to_report',
    minArgs: 1,
    maxArgs: 1,
    category: 'window',
    emit: {
      snowflake: (args) => `RATIO_TO_REPORT(${args[0]})`,
      bigquery: (args) => `RATIO_TO_REPORT(${args[0]})`,
      postgres: (args) => `CAST(${args[0]} AS DOUBLE PRECISION) / SUM(${args[0]})`,
      databricks: (args) => `(${args[0]}) * 1.0 / SUM(${args[0]})`,
      mysql: (args) => `(${args[0]}) * 1.0 / SUM(${args[0]})`,
      duckdb: (args) => `(${args[0]}) * 1.0 / SUM(${args[0]})`,
      clickhouse: (args) => `(${args[0]}) * 1.0 / SUM(${args[0]})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Aggregate functions — Tier 2 (12)
// ---------------------------------------------------------------------------

const AGGREGATE_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'median',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      bigquery: (args) => `PERCENTILE_CONT(${args[0]}, 0.5) OVER()`,
      postgres: (args) => `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${args[0]})`,
      // CH registers median case-sensitively: MEDIAN does not resolve.
      clickhouse: 'median',
    },
  },
  {
    name: 'percentile_cont',
    minArgs: 2,
    maxArgs: 2,
    category: 'aggregate',
    emit: {
      snowflake: (args) => `PERCENTILE_CONT(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      bigquery: (args) => `PERCENTILE_CONT(${args[1]}, ${args[0]}) OVER()`,
      postgres: (args) => `PERCENTILE_CONT(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      databricks: (args) => `PERCENTILE_CONT(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      // CH quantiles are parametric; `quantile` interpolates between points,
      // which is the continuous variant.
      clickhouse: (args) => `quantile(${args[0]})(${args[1]})`,
    },
  },
  {
    name: 'percentile_disc',
    minArgs: 2,
    maxArgs: 2,
    category: 'aggregate',
    emit: {
      snowflake: (args) => `PERCENTILE_DISC(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      bigquery: (args) => `PERCENTILE_DISC(${args[1]}, ${args[0]}) OVER()`,
      postgres: (args) => `PERCENTILE_DISC(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      databricks: (args) => `PERCENTILE_DISC(${args[0]}) WITHIN GROUP (ORDER BY ${args[1]})`,
      // `quantileExact` returns an actual data point rather than interpolating,
      // which is the discrete variant.
      clickhouse: (args) => `quantileExact(${args[0]})(${args[1]})`,
    },
  },
  // CH resolves STDDEV case-insensitively to stddevSamp, matching SQL's
  // sample-variance default.
  verbatim('stddev', 1, 1, 'aggregate'),
  {
    name: 'variance',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    // CH has no VARIANCE alias, only varPop/varSamp; SQL VARIANCE is VAR_SAMP.
    emit: { clickhouse: 'varSamp' },
  },
  verbatim('any_value', 1, 1, 'aggregate'),
  verbatim('corr', 2, 2, 'aggregate'),
  verbatim('covar_pop', 2, 2, 'aggregate'),
  verbatim('covar_samp', 2, 2, 'aggregate'),
  {
    name: 'mode',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      bigquery: (args) => `APPROX_TOP_COUNT(${args[0]}, 1)[OFFSET(0)].value`,
      postgres: (args) => `MODE() WITHIN GROUP (ORDER BY ${args[0]})`,
      // CH has no MODE; topK(1) is its most-frequent-value aggregate, matching
      // the approximate shape BigQuery already uses here.
      clickhouse: (args) => `topK(1)(${args[0]})[1]`,
    },
  },
  {
    name: 'bit_and',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: 'BITAND_AGG',
    },
  },
  {
    name: 'bit_or',
    minArgs: 1,
    maxArgs: 1,
    category: 'aggregate',
    emit: {
      snowflake: 'BITOR_AGG',
    },
  },
];

// ---------------------------------------------------------------------------
// Date/Time functions — Tier 2 (9)
// ---------------------------------------------------------------------------

const DATETIME_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'add_months',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      bigquery: (args) => `DATE_ADD(${args[0]}, INTERVAL ${args[1]} MONTH)`,
      postgres: (args) => `(${args[0]} + INTERVAL '1 month' * ${args[1]})`,
      clickhouse: (args) => `addMonths(${args[0]}, ${args[1]})`,
    },
  },
  {
    name: 'months_between',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      bigquery: (args) => `DATE_DIFF(${args[0]}, ${args[1]}, MONTH)`,
      postgres: (args) =>
        `(EXTRACT(YEAR FROM AGE(${args[0]}, ${args[1]})) * 12 + EXTRACT(MONTH FROM AGE(${args[0]}, ${args[1]})))`,
      // CH dateDiff is (unit, start, end); canonical months_between is end-start.
      clickhouse: (args) => `dateDiff('month', ${args[1]}, ${args[0]})`,
    },
  },
  {
    name: 'convert_timezone',
    minArgs: 3,
    maxArgs: 3,
    category: 'datetime',
    emit: {
      bigquery: (args) => `DATETIME(${args[2]}, ${args[1]})`,
      postgres: (args) => `(${args[2]} AT TIME ZONE ${args[1]})`,
      // CH carries the zone on the value, so like BigQuery it reads only the
      // target zone and ignores the declared source zone.
      clickhouse: (args) => `toTimezone(${args[2]}, ${args[1]})`,
    },
  },
  {
    name: 'quarter',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('QUARTER'),
      postgres: extractEmitter('QUARTER'),
    },
  },
  {
    name: 'dayofweek',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('DAYOFWEEK'),
      postgres: (args) => `EXTRACT(DOW FROM ${args[0]})`,
    },
  },
  {
    name: 'dayofyear',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: extractEmitter('DAYOFYEAR'),
      postgres: (args) => `EXTRACT(DOY FROM ${args[0]})`,
    },
  },
  {
    name: 'weekofyear',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      bigquery: (args) => `EXTRACT(ISOWEEK FROM ${args[0]})`,
      postgres: (args) => `EXTRACT(WEEK FROM ${args[0]})`,
      clickhouse: (args) => `toISOWeek(${args[0]})`,
    },
  },
  {
    name: 'timestamp_from_parts',
    minArgs: 6,
    maxArgs: 6,
    category: 'datetime',
    emit: {
      bigquery: (args) => `DATETIME(${args.join(', ')})`,
      postgres: (args) => `MAKE_TIMESTAMP(${args.join(', ')})`,
      databricks: (args) => `MAKE_TIMESTAMP(${args.join(', ')})`,
      clickhouse: (args) => `makeDateTime(${args.join(', ')})`,
    },
  },
  {
    name: 'next_day',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      clickhouse: clickhouseUnsupported(
        'next_day',
        'it has no NEXT_DAY, and deriving the next named weekday would mean inventing weekday-name parsing this catalog cannot verify.'
      ),
    },
  },
  {
    name: 'format_date',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    emit: {
      // Canonical: format_date(format, date) — BQ native
      // SF: TO_VARCHAR(date, format)
      snowflake: (args) => `TO_VARCHAR(${args[1]}, ${args[0]})`,
      bigquery: (args) => `FORMAT_DATE(${args[0]}, ${args[1]})`,
      postgres: (args) => `TO_CHAR(${args[1]}, ${args[0]})`,
      databricks: (args) => `DATE_FORMAT(${args[1]}, ${args[0]})`,
      // CH: formatDateTime(date, format), MySQL-style `%` specifiers
      clickhouse: (args) => `formatDateTime(${args[1]}, ${args[0]})`,
    },
  },
  {
    name: 'timestamp_seconds',
    minArgs: 1,
    maxArgs: 1,
    category: 'datetime',
    emit: {
      // Convert unix epoch seconds → timestamp
      snowflake: (args) => `TO_TIMESTAMP(${args[0]})`,
      bigquery: (args) => `TIMESTAMP_SECONDS(${args[0]})`,
      postgres: (args) => `TO_TIMESTAMP(${args[0]})`,
      databricks: (args) => `FROM_UNIXTIME(${args[0]})`,
      // Not toDateTime: that is UInt32-backed and covers only 1970-2106.
      clickhouse: (args) => `toDateTime64(${args[0]}, 3)`,
    },
  },
];

// ---------------------------------------------------------------------------
// String functions — Tier 2 (15)
// ---------------------------------------------------------------------------

const STRING_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'regexp_substr',
    minArgs: 2,
    maxArgs: 3,
    category: 'string',
    emit: {
      bigquery: 'REGEXP_EXTRACT',
      postgres: (args) => `(REGEXP_MATCHES(${args[0]}, ${args[1]}))[1]`,
      databricks: 'REGEXP_EXTRACT',
    },
  },
  {
    name: 'regexp_like',
    minArgs: 2,
    maxArgs: 3,
    category: 'string',
    emit: {
      bigquery: 'REGEXP_CONTAINS',
      postgres: (args) => `(${args[0]} ~ ${args[1]})`,
      // CH: `match` is the RE2 predicate; there is no REGEXP_LIKE.
      clickhouse: 'match',
    },
  },
  {
    name: 'regexp_count',
    minArgs: 2,
    maxArgs: 3,
    category: 'string',
    emit: {
      bigquery: (args) => `ARRAY_LENGTH(REGEXP_EXTRACT_ALL(${args[0]}, ${args[1]}))`,
      databricks: (args) => `SIZE(REGEXP_EXTRACT_ALL(${args[0]}, ${args[1]}))`,
      clickhouse: (args) => `countMatches(${args[0]}, ${args[1]})`,
    },
  },
  {
    name: 'contains',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      bigquery: 'CONTAINS_SUBSTR',
      postgres: (args) => `(POSITION(${args[1]} IN ${args[0]}) > 0)`,
      clickhouse: (args) => `(positionUTF8(${args[0]}, ${args[1]}) > 0)`,
    },
  },
  {
    name: 'startswith',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      bigquery: 'STARTS_WITH',
      postgres: (args) => `(${args[0]} LIKE ${args[1]} || '%')`,
      // CH registers startsWith/endsWith case-sensitively.
      clickhouse: 'startsWith',
    },
  },
  {
    name: 'endswith',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      bigquery: 'ENDS_WITH',
      postgres: (args) => `(${args[0]} LIKE '%' || ${args[1]})`,
      clickhouse: 'endsWith',
    },
  },
  {
    name: 'split',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      postgres: 'STRING_TO_ARRAY',
      // CH: splitByString takes the separator first.
      clickhouse: (args) => `splitByString(${args[1]}, ${args[0]})`,
    },
  },
  {
    name: 'translate',
    minArgs: 3,
    maxArgs: 3,
    category: 'string',
    // CH's byte-oriented `translate` rejects multi-byte arguments outright.
    emit: { clickhouse: 'translateUTF8' },
  },
  {
    name: 'editdistance',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      bigquery: 'EDIT_DISTANCE',
      postgres: 'LEVENSHTEIN',
      databricks: 'LEVENSHTEIN',
      // Byte-oriented, matching the editDistance choice in fuzzy.ts.
      clickhouse: 'editDistance',
    },
  },
  {
    name: 'position',
    minArgs: 2,
    maxArgs: 2,
    category: 'string',
    emit: {
      snowflake: (args) => `CHARINDEX(${args[0]}, ${args[1]})`,
      bigquery: (args) => `STRPOS(${args[1]}, ${args[0]})`,
      postgres: (args) => `POSITION(${args[0]} IN ${args[1]})`,
      duckdb: (args) => `POSITION(${args[0]} IN ${args[1]})`,
      databricks: (args) => `LOCATE(${args[0]}, ${args[1]})`,
      // CH: position(haystack, needle) — reversed from the canonical order, so
      // the verbatim name would silently search the wrong way round.
      clickhouse: (args) => `positionUTF8(${args[1]}, ${args[0]})`,
    },
  },
  {
    name: 'ascii',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    emit: {
      bigquery: (args) => `TO_CODE_POINTS(${args[0]})[OFFSET(0)]`,
    },
  },
  {
    name: 'chr',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    emit: {
      bigquery: (args) => `CODE_POINTS_TO_STRING([${args[0]}])`,
      clickhouse: 'char',
    },
  },
  verbatim('soundex', 1, 1, 'string'),
  {
    name: 'base64_encode',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    emit: {
      bigquery: 'TO_BASE64',
      postgres: (args) => `ENCODE(${args[0]}::bytea, 'base64')`,
      databricks: 'BASE64',
      clickhouse: 'base64Encode',
    },
  },
  {
    name: 'base64_decode',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    emit: {
      snowflake: 'BASE64_DECODE_STRING',
      bigquery: 'FROM_BASE64',
      postgres: (args) => `DECODE(${args[0]}, 'base64')`,
      databricks: 'UNBASE64',
      clickhouse: 'base64Decode',
    },
  },
];

// ---------------------------------------------------------------------------
// Numeric functions — Tier 2 (6)
// ---------------------------------------------------------------------------

const NUMERIC_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'sign',
    minArgs: 1,
    maxArgs: 1,
    category: 'numeric',
    emit: {
      databricks: 'SIGNUM',
    },
  },
  {
    name: 'random',
    minArgs: 0,
    maxArgs: 0,
    category: 'numeric',
    emit: {
      bigquery: () => 'RAND()',
      databricks: () => 'RAND()',
      // CH `rand()` returns a UInt32; randCanonical is the [0, 1) float that
      // BigQuery, Postgres, and DuckDB all produce here.
      clickhouse: () => 'randCanonical()',
    },
  },
  {
    name: 'div0null',
    minArgs: 2,
    maxArgs: 2,
    category: 'numeric',
    emit: {
      bigquery: 'SAFE_DIVIDE',
      postgres: (args) => `(${args[0]} / NULLIF(${args[1]}, 0))`,
      databricks: 'TRY_DIVIDE',
      duckdb: (args) => `(${args[0]} / NULLIF(${args[1]}, 0))`,
      clickhouse: (args) => `(${args[0]} / nullIf(${args[1]}, 0))`,
    },
  },
  verbatim('width_bucket', 4, 4, 'numeric'),
  {
    name: 'cbrt',
    minArgs: 1,
    maxArgs: 1,
    category: 'numeric',
    emit: {
      bigquery: (args) => `POW(${args[0]}, 1.0 / 3)`,
      // CH registers cbrt case-sensitively: CBRT does not resolve.
      clickhouse: 'cbrt',
    },
  },
  {
    name: 'pi',
    minArgs: 0,
    maxArgs: 0,
    category: 'numeric',
    emit: {
      bigquery: () => 'ACOS(-1)',
    },
  },
];

// ---------------------------------------------------------------------------
// JSON functions — Tier 2 (6)
// ---------------------------------------------------------------------------

const JSON_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'json_extract_path_text',
    minArgs: 2,
    maxArgs: -1,
    category: 'json',
    // CH: JSONExtractString takes the same (json, key...) variadic shape.
    emit: { clickhouse: 'JSONExtractString' },
  },
  {
    name: 'object_construct',
    minArgs: 0,
    maxArgs: -1,
    category: 'json',
    emit: {
      bigquery: (args) => `JSON_OBJECT(${args.join(', ')})`,
      postgres: (args) => `JSONB_BUILD_OBJECT(${args.join(', ')})`,
      // CH has no JSON object constructor; a map serialized to JSON is the
      // closest equivalent that stays a value rather than a column type.
      clickhouse: (args) => `toJSONString(map(${args.join(', ')}))`,
    },
  },
  {
    name: 'object_keys',
    minArgs: 1,
    maxArgs: 1,
    category: 'json',
    emit: {
      postgres: 'JSONB_OBJECT_KEYS',
      databricks: 'JSON_OBJECT_KEYS',
      clickhouse: 'JSONExtractKeys',
    },
  },
  {
    name: 'array_construct',
    minArgs: 0,
    maxArgs: -1,
    category: 'json',
    emit: {
      bigquery: (args) => `[${args.join(', ')}]`,
      postgres: (args) => `ARRAY[${args.join(', ')}]`,
      databricks: (args) => `ARRAY(${args.join(', ')})`,
      clickhouse: (args) => `[${args.join(', ')}]`,
    },
  },
  {
    name: 'array_size',
    minArgs: 1,
    maxArgs: 1,
    category: 'json',
    emit: {
      bigquery: 'ARRAY_LENGTH',
      postgres: 'CARDINALITY',
      databricks: 'SIZE',
      // CH `length` is overloaded for arrays as well as strings.
      clickhouse: 'length',
    },
  },
  {
    name: 'json_value_array',
    minArgs: 2,
    maxArgs: 2,
    category: 'json',
    emit: {
      // Extract a JSON array of scalar values as a SQL array
      snowflake: (args) => `PARSE_JSON(${args[0]}):${stripQuotes(args[1]!)}`,
      bigquery: (args) => `JSON_VALUE_ARRAY(${args[0]}, ${args[1]})`,
      postgres: (args) => `JSONB_ARRAY_ELEMENTS_TEXT(${args[0]}->${args[1]})`,
      databricks: (args) => `FROM_JSON(GET_JSON_OBJECT(${args[0]}, ${args[1]}), 'ARRAY<STRING>')`,
      clickhouse: (args) => `JSONExtract(${args[0]}, ${args[1]}, 'Array(String)')`,
    },
  },
  {
    name: 'array_contains',
    minArgs: 2,
    maxArgs: 2,
    category: 'json',
    emit: {
      // SF: ARRAY_CONTAINS(val, arr) — canonical
      bigquery: (args) => `${args[0]} IN UNNEST(${args[1]})`,
      postgres: (args) => `${args[0]} = ANY(${args[1]})`,
      // DB: ARRAY_CONTAINS(arr, val) — reversed
      databricks: (args) => `ARRAY_CONTAINS(${args[1]}, ${args[0]})`,
      // CH: has(arr, val) — also reversed
      clickhouse: (args) => `has(${args[1]}, ${args[0]})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Hash functions — Tier 2 (2)
// ---------------------------------------------------------------------------

const HASH_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'sha1',
    minArgs: 1,
    maxArgs: 1,
    category: 'hash',
    emit: {
      postgres: (args) => `ENCODE(DIGEST(${args[0]}, 'sha1'), 'hex')`,
      // CH SHA1 resolves but returns raw FixedString bytes, so hex it the way
      // md5 and sha2 already do.
      clickhouse: (args) => `lower(hex(SHA1(${args[0]})))`,
    },
  },
  {
    name: 'hash',
    minArgs: 1,
    maxArgs: -1,
    category: 'hash',
    emit: {
      bigquery: (args) => `FARM_FINGERPRINT(TO_JSON_STRING(STRUCT(${args.join(', ')})))`,
      postgres: (args) => `HASHTEXT(${args.join(' || ')})`,
      // CH: sipHash64 is variadic and returns a 64-bit integer, matching the
      // fingerprint shape Snowflake and BigQuery return here.
      clickhouse: (args) => `sipHash64(${args.join(', ')})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Geo functions (3)
// ---------------------------------------------------------------------------

const GEO_FUNCTIONS: FunctionDef[] = [
  {
    name: 'st_distance',
    minArgs: 2,
    maxArgs: 2,
    category: 'geo',
    emit: {
      clickhouse: clickhouseUnsupported(
        'st_distance',
        'its only ST_* functions parse WKB or build MVT tiles, and it has no geography type to measure between. Use haversine on plain coordinates instead.'
      ),
    },
  },
  {
    name: 'st_point',
    minArgs: 2,
    maxArgs: 2,
    category: 'geo',
    emit: {
      bigquery: 'ST_GEOGPOINT',
      postgres: 'ST_MakePoint',
      clickhouse: clickhouseUnsupported(
        'st_point',
        'it has no geography type, and emitting a bare tuple would invent a coordinate-order contract no other dialect shares.'
      ),
    },
  },
  {
    name: 'haversine',
    minArgs: 4,
    maxArgs: 4,
    category: 'geo',
    emit: {
      // haversine(lat1, lon1, lat2, lon2) → dialect-specific geo distance
      bigquery: (args) =>
        `ST_DISTANCE(ST_GEOGPOINT(${args[1]}, ${args[0]}), ST_GEOGPOINT(${args[3]}, ${args[2]}))`,
      postgres: (args) =>
        `ST_DistanceSphere(ST_MakePoint(${args[1]}, ${args[0]}), ST_MakePoint(${args[3]}, ${args[2]}))`,
      // CH: greatCircleDistance(lon1, lat1, lon2, lat2) returns metres.
      clickhouse: (args) => `greatCircleDistance(${args[1]}, ${args[0]}, ${args[3]}, ${args[2]})`,
    },
  },
];

// ---------------------------------------------------------------------------
// Conversion functions — Tier 2 (3)
// ---------------------------------------------------------------------------

const CONVERSION_T2_FUNCTIONS: FunctionDef[] = [
  {
    name: 'to_boolean',
    minArgs: 1,
    maxArgs: 1,
    category: 'conversion',
    emit: {
      snowflake: (args) => `CAST(${args[0]} AS BOOLEAN)`,
      bigquery: (args) => `CAST(${args[0]} AS BOOL)`,
      postgres: (args) => `CAST(${args[0]} AS BOOLEAN)`,
      databricks: (args) => `CAST(${args[0]} AS BOOLEAN)`,
      clickhouse: (args) => `CAST(${args[0]} AS Bool)`,
    },
  },
  {
    name: 'to_number',
    minArgs: 1,
    maxArgs: 2,
    category: 'conversion',
    emit: {
      bigquery: (args) => `CAST(${args[0]} AS NUMERIC)`,
      databricks: (args) => `CAST(${args[0]} AS DECIMAL)`,
      // CH has no unparameterized NUMERIC/DECIMAL, matching the width the
      // cleaning primitives already use.
      clickhouse: (args) => `CAST(${args[0]} AS Decimal(38, 9))`,
    },
  },
  {
    name: 'typeof',
    minArgs: 1,
    maxArgs: 1,
    category: 'conversion',
    emit: {
      postgres: 'PG_TYPEOF',
      clickhouse: 'toTypeName',
    },
  },
];

// ---------------------------------------------------------------------------
// Export all Tier 2 functions
// ---------------------------------------------------------------------------

export const TIER2_FUNCTIONS: FunctionDef[] = [
  ...WINDOW_FUNCTIONS,
  ...AGGREGATE_T2_FUNCTIONS,
  ...DATETIME_T2_FUNCTIONS,
  ...STRING_T2_FUNCTIONS,
  ...NUMERIC_T2_FUNCTIONS,
  ...JSON_T2_FUNCTIONS,
  ...HASH_T2_FUNCTIONS,
  ...GEO_FUNCTIONS,
  ...CONVERSION_T2_FUNCTIONS,
];
