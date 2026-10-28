import { describe, expect, it } from 'vitest';

import { emitExpr, parseExprField } from '../../../../src/compiler/expr/index.js';

/**
 * ClickHouse is its own canonical dialect, so any Tier 2 entry without a
 * `clickhouse` emitter falls through to the canonical Model Spec name verbatim. Every
 * case below was executed against ClickHouse 26.9 before being pinned here:
 * the left column is the Model Spec expression, the right column the SQL that ran.
 */
const TIER2_CLICKHOUSE_CASES: ReadonlyArray<readonly [string, string]> = [
  // Window — LAG/LEAD/NTH_VALUE return the type default, not NULL, unless the
  // argument is widened.
  ['LAG(amount) OVER (ORDER BY id)', 'LAG(toNullable(amount)) OVER (ORDER BY id)'],
  ['LAG(amount, 2, 0) OVER (ORDER BY id)', 'LAG(toNullable(amount), 2, 0) OVER (ORDER BY id)'],
  ['LEAD(amount) OVER (ORDER BY id)', 'LEAD(toNullable(amount)) OVER (ORDER BY id)'],
  [
    'NTH_VALUE(amount, 2) OVER (ORDER BY id)',
    'NTH_VALUE(toNullable(amount), 2) OVER (ORDER BY id)',
  ],
  ['CUME_DIST() OVER (ORDER BY id)', 'cume_dist() OVER (ORDER BY id)'],

  // Aggregate
  ['median(amount)', 'median(amount)'],
  ['percentile_cont(0.5, amount)', 'quantile(0.5)(amount)'],
  ['percentile_disc(0.5, amount)', 'quantileExact(0.5)(amount)'],
  ['variance(amount)', 'varSamp(amount)'],
  ['mode(amount)', 'topK(1)(amount)[1]'],

  // Date/time
  ['add_months(ts, 2)', 'addMonths(ts, 2)'],
  ['months_between(a, b)', "dateDiff('month', b, a)"],
  ["convert_timezone('UTC', 'CET', ts)", "toTimezone(ts, 'CET')"],
  ['weekofyear(ts)', 'toISOWeek(ts)'],
  ['timestamp_from_parts(2024, 1, 2, 3, 4, 5)', 'makeDateTime(2024, 1, 2, 3, 4, 5)'],
  ["format_date('%Y-%m-%d', ts)", "formatDateTime(ts, '%Y-%m-%d')"],
  ['timestamp_seconds(epoch)', 'toDateTime64(epoch, 3)'],

  // String
  ["regexp_like(name, 'a.')", "match(name, 'a.')"],
  ["regexp_count(name, 'a')", "countMatches(name, 'a')"],
  ["contains(name, 'af')", "(positionUTF8(name, 'af') > 0)"],
  ["startswith(name, 'ca')", "startsWith(name, 'ca')"],
  ["endswith(name, 'fe')", "endsWith(name, 'fe')"],
  ["split(name, ',')", "splitByString(',', name)"],
  ["translate(name, 'c', 'k')", "translateUTF8(name, 'c', 'k')"],
  ['editdistance(a, b)', 'editDistance(a, b)'],
  ['chr(65)', 'char(65)'],
  ['base64_encode(name)', 'base64Encode(name)'],
  ['base64_decode(name)', 'base64Decode(name)'],

  // Numeric
  ['random()', 'randCanonical()'],
  ['div0null(a, b)', '(a / nullIf(b, 0))'],
  ['cbrt(n)', 'cbrt(n)'],

  // JSON
  ["json_extract_path_text(payload, 'a', 'b')", "JSONExtractString(payload, 'a', 'b')"],
  ["object_construct('a', 1)", "toJSONString(map('a', 1))"],
  ['object_keys(payload)', 'JSONExtractKeys(payload)'],
  ['array_construct(1, 2)', '[1, 2]'],
  ['array_size(items)', 'length(items)'],
  ["json_value_array(payload, 'a')", "JSONExtract(payload, 'a', 'Array(String)')"],
  ['array_contains(1, items)', 'has(items, 1)'],

  // Hash
  ['sha1(name)', 'lower(hex(SHA1(name)))'],
  ['hash(a, b)', 'sipHash64(a, b)'],

  // Geo
  ['haversine(lat1, lon1, lat2, lon2)', 'greatCircleDistance(lon1, lat1, lon2, lat2)'],

  // Conversion
  ['to_boolean(flag)', 'CAST(flag AS Bool)'],
  ['to_number(amount)', 'CAST(amount AS Decimal(38, 9))'],
  ['typeof(amount)', 'toTypeName(amount)'],
];

/**
 * Entries whose verbatim name already resolves on ClickHouse. Pinned so a later
 * rename cannot quietly reintroduce a fallthrough that only fails at runtime.
 */
const TIER2_VERBATIM_CASES: ReadonlyArray<readonly [string, string]> = [
  ['ROW_NUMBER() OVER (ORDER BY id)', 'ROW_NUMBER() OVER (ORDER BY id)'],
  ['DENSE_RANK() OVER (ORDER BY id)', 'DENSE_RANK() OVER (ORDER BY id)'],
  ['stddev(amount)', 'STDDEV(amount)'],
  ['any_value(amount)', 'ANY_VALUE(amount)'],
  ['covar_pop(a, b)', 'COVAR_POP(a, b)'],
  ['bit_and(flags)', 'BIT_AND(flags)'],
  ['quarter(ts)', 'QUARTER(ts)'],
  ['dayofyear(ts)', 'DAYOFYEAR(ts)'],
  ["regexp_substr(name, 'a.')", "REGEXP_SUBSTR(name, 'a.')"],
  ['ascii(name)', 'ASCII(name)'],
  ['width_bucket(n, 0, 10, 4)', 'WIDTH_BUCKET(n, 0, 10, 4)'],
  ['pi()', 'PI()'],
];

describe('Tier 2 catalog — clickhouse', () => {
  it.each(TIER2_CLICKHOUSE_CASES)('emits %s as ClickHouse SQL', (source, expected) => {
    expect(emitExpr(parseExprField(source), 'clickhouse')).toBe(expected);
  });

  it.each(TIER2_VERBATIM_CASES)('keeps %s verbatim on ClickHouse', (source, expected) => {
    expect(emitExpr(parseExprField(source), 'clickhouse')).toBe(expected);
  });

  it('reverses position() arguments rather than searching the wrong way round', () => {
    expect(emitExpr(parseExprField("position('fe', name)"), 'clickhouse')).toBe(
      "positionUTF8(name, 'fe')"
    );
  });

  it.each(['st_distance(a, b)', 'st_point(x, y)', "next_day(ts, 'monday')"])(
    'rejects %s on ClickHouse instead of emitting SQL it cannot run',
    (source) => {
      const expr = parseExprField(source);
      expect(() => emitExpr(expr, 'clickhouse')).toThrow(
        /is not supported for compiler target "clickhouse"/
      );
    }
  );

  it('leaves the other dialects untouched', () => {
    expect(emitExpr(parseExprField('variance(amount)'), 'snowflake')).toBe('VARIANCE(AMOUNT)');
    expect(emitExpr(parseExprField('LAG(amount) OVER (ORDER BY id)'), 'postgres')).toBe(
      'LAG(amount) OVER (ORDER BY id)'
    );
    expect(emitExpr(parseExprField("position('fe', name)"), 'bigquery')).toBe("STRPOS(name, 'fe')");
    expect(emitExpr(parseExprField('st_point(x, y)'), 'postgres')).toBe('ST_MakePoint(x, y)');
  });
});
