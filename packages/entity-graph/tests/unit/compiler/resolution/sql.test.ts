import { describe, expect, it } from 'vitest';

import { generateExportQuery } from '../../../../src/compiler/identity/review-export.js';
import {
  buildJsonObjectExpr,
  buildSourcePkJsonExpr,
  jsonExtractString,
  nullOfType,
  nullString,
  nullTimestamp,
  qualifyBlockingExpression,
  timestampMinusDays,
} from '../../../../src/compiler/identity/sql.js';

describe('qualifyBlockingExpression', () => {
  it('qualifies column references without rewriting string literals', () => {
    const expression = qualifyBlockingExpression(
      "LEFT(standardized_company_name, 6) || '|' || standardized_billing_country",
      'a_std',
      'snowflake'
    );

    expect(expression).toContain(`LEFT(a_std."STANDARDIZED_COMPANY_NAME", 6)`);
    expect(expression).toContain(`|| '|' || a_std."STANDARDIZED_BILLING_COUNTRY"`);
    expect(expression).not.toContain(`a_std.'|'`);
  });

  it('uses dialect-specific quoting for BigQuery', () => {
    const expression = qualifyBlockingExpression('company_name', 'a_std', 'bigquery');
    expect(expression).toBe('a_std.`company_name`');
  });
});

describe('generateExportQuery', () => {
  it('includes blank decision columns for template exports', () => {
    const sql = generateExportQuery('company', 'ENTITY_GRAPH', 0.7, 'snowflake', {
      pendingOnly: true,
      includeDecisionColumns: true,
    });

    expect(sql).toContain(`ld."DECISION"`);
    expect(sql).toContain(`AS "CONFIDENCE_GAP"`);
    expect(sql).toContain(
      `WHERE ((ld."PAIR_ID" IS NULL OR COALESCE(ld."STATUS", 'applied') IN ('proposed', 'deferred', 'escalated') OR (ld."STATUS" IS NULL AND ld."DECISION" IN ('defer', 'escalate'))))`
    );
  });
});

describe('buildSourcePkJsonExpr', () => {
  it('builds balanced nested REPLACE calls for JSON escaping', () => {
    const sql = buildSourcePkJsonExpr(['record_id'], 'snowflake');
    expect(sql.match(/REPLACE\(/g) ?? []).toHaveLength(7);
  });
});

describe('typed NULL literals', () => {
  it.each([
    'snowflake',
    'bigquery',
    'postgres',
    'duckdb',
    'databricks',
    'mysql',
    'redshift',
  ] as const)('leaves the type name unwrapped for %s', (dialect) => {
    expect(nullOfType('VARCHAR', dialect)).toBe('CAST(NULL AS VARCHAR)');
  });

  it('wraps clickhouse typed NULLs in Nullable, since its types reject NULL', () => {
    expect(nullOfType('String', 'clickhouse')).toBe('CAST(NULL AS Nullable(String))');
    expect(nullString('clickhouse')).toBe('CAST(NULL AS Nullable(String))');
    expect(nullTimestamp('clickhouse')).toBe('CAST(NULL AS Nullable(TIMESTAMP))');
  });

  it('does not wrap clickhouse types that forbid Nullable', () => {
    // ClickHouse rejects Nullable() over these containers outright.
    expect(nullOfType('JSON', 'clickhouse')).toBe('CAST(NULL AS JSON)');
    expect(nullOfType('Array(String)', 'clickhouse')).toBe('CAST(NULL AS Array(String))');
    expect(nullOfType('Nullable(String)', 'clickhouse')).toBe('CAST(NULL AS Nullable(String))');
  });
});

describe('JSON helpers', () => {
  it.each([
    ['snowflake', 'OBJECT_CONSTRUCT', ':domain::VARCHAR', 'DATEADD(day, -7, CURRENT_TIMESTAMP)'],
    [
      'bigquery',
      'JSON_OBJECT',
      "JSON_VALUE(profile_attrs, '$.domain')",
      'TIMESTAMP_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)',
    ],
    [
      'postgres',
      'json_build_object',
      "profile_attrs ->> 'domain'",
      "CURRENT_TIMESTAMP - INTERVAL '7 day'",
    ],
    [
      'duckdb',
      'json_object',
      "json_extract_string(profile_attrs, '$.domain')",
      "CURRENT_TIMESTAMP - INTERVAL '7 day'",
    ],
    [
      'databricks',
      'TO_JSON(NAMED_STRUCT',
      "get_json_object(profile_attrs, '$.domain')",
      'CURRENT_TIMESTAMP - INTERVAL 7 DAYS',
    ],
    [
      'mysql',
      'JSON_OBJECT',
      "JSON_UNQUOTE(JSON_EXTRACT(profile_attrs, '$.domain'))",
      'DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)',
    ],
    [
      'redshift',
      'json_parse(json_serialize(json_build_object',
      "json_extract_path_text(profile_attrs, 'domain')",
      "CURRENT_TIMESTAMP - INTERVAL '7 day'",
    ],
  ] as const)(
    'emits dialect-aware JSON/timestamp SQL for %s',
    (dialect, jsonObjectFragment, jsonExtractFragment, timestampFragment) => {
      expect(
        buildJsonObjectExpr(
          [
            ['domain', 'profile_attrs'],
            ['industry', 'industry_expr'],
          ],
          dialect
        )
      ).toContain(jsonObjectFragment);
      expect(jsonExtractString('profile_attrs', 'domain', dialect)).toContain(jsonExtractFragment);
      expect(timestampMinusDays(7, dialect)).toContain(timestampFragment);
    }
  );

  // ClickHouse cannot join the table above: it has no JSON-object constructor,
  // so buildJsonObjectExpr throws rather than returning a fragment.
  it('emits dialect-aware JSON/timestamp SQL for clickhouse', () => {
    expect(jsonExtractString('profile_attrs', 'domain', 'clickhouse')).toContain(
      "JSONExtractString(profile_attrs, 'domain')"
    );
    expect(timestampMinusDays(7, 'clickhouse')).toContain('CURRENT_TIMESTAMP - INTERVAL 7 DAY');
    expect(() =>
      buildJsonObjectExpr(
        [
          ['domain', 'profile_attrs'],
          ['industry', 'industry_expr'],
        ],
        'clickhouse'
      )
    ).toThrow();
  });

  it('explains the clickhouse JSON-object limitation instead of failing generically', () => {
    const build = () => buildJsonObjectExpr([['domain', 'profile_attrs']], 'clickhouse');

    // A bare "Unsupported dialect" would not tell a user what to change, so the
    // message must name the dialect, the construct, and that it is unsupported.
    expect(build).toThrow(/clickhouse/i);
    expect(build).toThrow(/JSON object/i);
    expect(build).toThrow(/does not support/i);
  });
});
