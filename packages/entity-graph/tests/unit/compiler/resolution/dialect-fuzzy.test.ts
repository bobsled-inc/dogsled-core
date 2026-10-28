import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';

import {
  BIGQUERY_JARO_WINKLER_UDF,
  BIGQUERY_TOKEN_COSINE_UDF,
  fuzzyScoreExpr,
  generateFuzzyPreamble,
  getFuzzyAlgorithmNotes,
  getFuzzyFunctions,
  getSupportedFuzzyAlgorithms,
  inlineFuzzyUdf,
  prependFuzzyUdfIfNeeded,
} from '../../../../src/compiler/core/dialect-similarity.js';

import type { SupportedDialect } from '@bobsled-inc/model-spec';

const DIALECTS: SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'postgres',
  'pgvector',
  'redshift',
  'duckdb',
  'databricks',
  'mysql',
  'clickhouse',
];

describe('getFuzzyFunctions', () => {
  for (const dialect of DIALECTS) {
    it(`returns valid functions for ${dialect}`, () => {
      const fns = getFuzzyFunctions(dialect);
      expect(fns.jaroWinkler).toBeTypeOf('function');
      expect(fns.editDistanceSimilarity).toBeTypeOf('function');
      expect(fns.soundexMatch).toBeTypeOf('function');
      expect(fns.exact).toBeTypeOf('function');
      expect(fns.tokenCosine).toBeTypeOf('function');
    });
  }
});

describe('getSupportedFuzzyAlgorithms', () => {
  it('lists only validate-time supported algorithms for restricted dialects', () => {
    expect(getSupportedFuzzyAlgorithms('mysql')).toEqual([
      'exact',
      'soundex',
      'numeric_distance',
      'date_proximity',
    ]);
    expect(getSupportedFuzzyAlgorithms('redshift')).toEqual([
      'exact',
      'soundex',
      'numeric_distance',
      'date_proximity',
      'token_cosine',
    ]);
  });

  it('includes jaro_winkler and edit_distance for fully supported dialects', () => {
    expect(getSupportedFuzzyAlgorithms('duckdb')).toContain('jaro_winkler');
    expect(getSupportedFuzzyAlgorithms('duckdb')).toContain('edit_distance');
    expect(getSupportedFuzzyAlgorithms('duckdb')).toContain('token_cosine');
  });
});

describe('fuzzyScoreExpr', () => {
  it('returns valid SQL for jaro_winkler on snowflake', () => {
    const expr = fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'snowflake');
    expect(expr).toContain('JAROWINKLER_SIMILARITY');
  });

  it('returns UDF call for jaro_winkler on bigquery', () => {
    const expr = fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'bigquery');
    expect(expr).toContain('bms_jaro_winkler');
  });

  it('defines the bigquery UDF as native SQL, never LANGUAGE js', () => {
    // A `LANGUAGE js` UDF routes every row through a sandboxed V8 process and
    // made scoring jobs run for minutes on small data. The SQL UDF body is
    // inlined by the optimizer and runs at native speed.
    expect(BIGQUERY_JARO_WINKLER_UDF).not.toContain('LANGUAGE js');
    expect(BIGQUERY_JARO_WINKLER_UDF).toContain('EDIT_DISTANCE(');
    expect(BIGQUERY_JARO_WINKLER_UDF.trim().endsWith(';')).toBe(true);
  });

  it('defines token_cosine as a native BigQuery SQL UDF over UNNESTed token sets', () => {
    expect(BIGQUERY_TOKEN_COSINE_UDF).not.toContain('LANGUAGE js');
    expect(BIGQUERY_TOKEN_COSINE_UDF).toContain('bms_token_cosine');
    expect(BIGQUERY_TOKEN_COSINE_UDF).toContain('UNNEST');
    expect(BIGQUERY_TOKEN_COSINE_UDF).toContain('INNER JOIN right_tokens USING (token)');
    expect(BIGQUERY_TOKEN_COSINE_UDF.trim().endsWith(';')).toBe(true);
  });

  it('uses jaro_winkler_similarity for duckdb', () => {
    const expr = fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'duckdb');
    expect(expr).toContain('jaro_winkler_similarity');
  });

  it('returns CASE expression for exact match', () => {
    for (const dialect of DIALECTS) {
      const expr = fuzzyScoreExpr('exact', 'a.domain', 'b.domain', dialect);
      expect(expr).toContain('CASE WHEN');
      expect(expr).toContain('1.0');
    }
  });

  it('returns soundex comparison for all dialects', () => {
    for (const dialect of DIALECTS) {
      const expr = fuzzyScoreExpr('soundex', 'a.name', 'b.name', dialect);
      expect(expr.toLowerCase()).toContain('soundex');
    }
  });

  it('returns token_cosine SQL for every supported dialect and fails fast for mysql', () => {
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'snowflake')).toContain(
      'ARRAY_INTERSECTION'
    );
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'bigquery')).toContain(
      'bms_token_cosine'
    );
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'postgres')).toContain('INTERSECT');
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'duckdb')).toContain('string_split');
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'databricks')).toContain(
      'ARRAY_INTERSECT'
    );
    expect(fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'redshift')).toContain(
      'SPLIT_TO_ARRAY'
    );
    expect(() => fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'mysql')).toThrow(
      /unsupported_feature:fuzzy:token_cosine/i
    );
  });

  it('evaluates token_cosine reference values on DuckDB', async () => {
    const openInstance = await DuckDBInstance.create(':memory:');
    const connection = await openInstance.connect();
    try {
      const expr = fuzzyScoreExpr('token_cosine', "'red blue blue'", "'blue red green'", 'duckdb');
      const rows = (await connection.runAndReadAll(`SELECT ${expr} AS score`)).getRowObjectsJS();
      const score = Number(rows[0]?.score);
      expect(score).toBeCloseTo(2 / Math.sqrt(2 * 3), 8);

      const emptyExpr = fuzzyScoreExpr('token_cosine', "'   '", "'blue red'", 'duckdb');
      const emptyRows = (
        await connection.runAndReadAll(`SELECT ${emptyExpr} AS score`)
      ).getRowObjectsJS();
      expect(Number(emptyRows[0]?.score)).toBe(0);

      const messyExpr = fuzzyScoreExpr(
        'token_cosine',
        "'red\tblue  blue'",
        "'blue red green'",
        'duckdb'
      );
      const messyRows = (
        await connection.runAndReadAll(`SELECT ${messyExpr} AS score`)
      ).getRowObjectsJS();
      expect(Number(messyRows[0]?.score)).toBeCloseTo(2 / Math.sqrt(2 * 3), 8);
    } finally {
      connection.disconnectSync();
      openInstance.closeSync();
    }
  });

  it('fails fast for unsupported mysql fuzzy algorithms', () => {
    expect(() => fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'mysql')).toThrow(
      /unsupported_feature:fuzzy:jaro_winkler/i
    );
    expect(() => fuzzyScoreExpr('edit_distance', 'a.name', 'b.name', 'mysql')).toThrow(
      /unsupported_feature:fuzzy:edit_distance/i
    );
  });

  it('fails fast for unsupported clickhouse fuzzy algorithms', () => {
    expect(() => fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'clickhouse')).toThrow(
      /unsupported_feature:fuzzy:jaro_winkler/i
    );
    expect(() => fuzzyScoreExpr('token_cosine', 'a.name', 'b.name', 'clickhouse')).toThrow(
      /unsupported_feature:fuzzy:token_cosine/i
    );
    expect(fuzzyScoreExpr('edit_distance', 'a.name', 'b.name', 'clickhouse')).toContain(
      'editDistance'
    );
  });

  it('fails fast for unsupported redshift fuzzy algorithms', () => {
    expect(() => fuzzyScoreExpr('jaro_winkler', 'a.name', 'b.name', 'redshift')).toThrow(
      /unsupported_feature:fuzzy:jaro_winkler/i
    );
    expect(() => fuzzyScoreExpr('edit_distance', 'a.name', 'b.name', 'redshift')).toThrow(
      /unsupported_feature:fuzzy:edit_distance/i
    );
  });
});

describe('generateFuzzyPreamble', () => {
  it('generates extension preamble for postgres', () => {
    const preamble = generateFuzzyPreamble('postgres');
    expect(preamble).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(preamble).toContain('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch');
  });

  it('generates the postgres extension preamble for pgvector', () => {
    const preamble = generateFuzzyPreamble('pgvector');
    expect(preamble).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(preamble).toContain('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch');
  });

  it('returns empty string for bigquery (UDF is inlined into consuming statements, not a standalone preamble)', () => {
    // BigQuery temp functions are job-scoped: a standalone temp-function preamble
    // is both unexecutable (job with only DDL and no query) and invisible to a
    // separate scoring job. The UDF is inlined per-statement instead.
    expect(generateFuzzyPreamble('bigquery')).toBe('');
  });

  it('returns empty string for dialects without preambles', () => {
    for (const dialect of DIALECTS.filter(
      (d) => d !== 'bigquery' && d !== 'postgres' && d !== 'pgvector'
    )) {
      expect(generateFuzzyPreamble(dialect)).toBe('');
    }
  });
});

describe('getFuzzyAlgorithmNotes', () => {
  it('describes approximate and limited fuzzy behavior for verbose validation output', () => {
    expect(getFuzzyAlgorithmNotes('bigquery').join('\n')).toContain('bms_token_cosine');
    expect(getFuzzyAlgorithmNotes('mysql').join('\n')).toContain('token_cosine are unsupported');
    expect(getFuzzyAlgorithmNotes('redshift').join('\n')).toContain('SPLIT_TO_ARRAY');
    expect(getFuzzyAlgorithmNotes('clickhouse').join('\n')).toContain('byte-based');
  });
});

describe('prependFuzzyUdfIfNeeded', () => {
  it('prefixes the UDF on bigquery when the SQL references bms_jaro_winkler', () => {
    const sql = 'CREATE TABLE t AS SELECT bms_jaro_winkler(a, b) FROM s';
    const result = prependFuzzyUdfIfNeeded(sql, 'bigquery');

    expect(result.startsWith('CREATE TEMP FUNCTION bms_jaro_winkler')).toBe(true);
    expect(result).toContain(BIGQUERY_JARO_WINKLER_UDF);
    expect(result).toContain(sql);
  });

  it('is a no-op on bigquery when the SQL does not reference the UDF', () => {
    const sql = 'CREATE TABLE t AS SELECT 1';
    expect(prependFuzzyUdfIfNeeded(sql, 'bigquery')).toBe(sql);
  });

  it('prefixes the token_cosine UDF on bigquery when the SQL references bms_token_cosine', () => {
    const sql = 'CREATE TABLE t AS SELECT bms_token_cosine(a, b) FROM s';
    const result = prependFuzzyUdfIfNeeded(sql, 'bigquery');

    expect(result.startsWith('CREATE TEMP FUNCTION bms_token_cosine')).toBe(true);
    expect(result).toContain(BIGQUERY_TOKEN_COSINE_UDF);
    expect(result).toContain(sql);
  });

  it('prefixes both BigQuery UDFs in deterministic order when both are referenced', () => {
    const sql = 'CREATE TABLE t AS SELECT bms_jaro_winkler(a, b), bms_token_cosine(a, b) FROM s';
    const result = prependFuzzyUdfIfNeeded(sql, 'bigquery');

    expect(result.indexOf('CREATE TEMP FUNCTION bms_jaro_winkler')).toBeLessThan(
      result.indexOf('CREATE TEMP FUNCTION bms_token_cosine')
    );
    expect(result).toContain(sql);
  });

  it('is a no-op for non-bigquery dialects even when the UDF is referenced', () => {
    const sql = 'CREATE TABLE t AS SELECT bms_jaro_winkler(a, b) FROM s';
    expect(prependFuzzyUdfIfNeeded(sql, 'duckdb')).toBe(sql);
    expect(prependFuzzyUdfIfNeeded(sql, 'snowflake')).toBe(sql);
    expect(prependFuzzyUdfIfNeeded(sql, 'postgres')).toBe(sql);
  });

  it('is idempotent — an already-prefixed statement is returned unchanged', () => {
    const sql = 'CREATE TABLE t AS SELECT bms_jaro_winkler(a, b) FROM s';
    const once = prependFuzzyUdfIfNeeded(sql, 'bigquery');
    const twice = prependFuzzyUdfIfNeeded(once, 'bigquery');

    expect(twice).toBe(once);
  });
});

describe('inlineFuzzyUdf', () => {
  it('prefixes only the bigquery statements that reference the UDF', () => {
    const statements = [
      { name: 'a', sql: 'CREATE TABLE a AS SELECT 1' },
      { name: 'b', sql: 'CREATE TABLE b AS SELECT bms_token_cosine(x, y) FROM s' },
    ];
    const result = inlineFuzzyUdf(statements, 'bigquery');

    expect(result[0]?.sql).toBe(statements[0]?.sql);
    expect(result[1]?.sql.startsWith('CREATE TEMP FUNCTION bms_token_cosine')).toBe(true);
    expect(result[1]?.name).toBe('b');
  });

  it('is a no-op for non-bigquery dialects', () => {
    const statements = [
      { name: 'b', sql: 'CREATE TABLE b AS SELECT bms_jaro_winkler(x, y) FROM s' },
    ];
    const result = inlineFuzzyUdf(statements, 'duckdb');

    expect(result[0]?.sql).toBe(statements[0]?.sql);
  });

  it('preserves additional statement fields', () => {
    const statements = [{ name: 'b', sql: 'SELECT bms_jaro_winkler(x, y)', tableCreated: 'b_tbl' }];
    const result = inlineFuzzyUdf(statements, 'bigquery');

    expect(result[0]?.tableCreated).toBe('b_tbl');
  });
});
