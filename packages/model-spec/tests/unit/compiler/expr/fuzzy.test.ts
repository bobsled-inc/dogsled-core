import { describe, expect, it } from 'vitest';

import {
  getExpressionFunctionManifest,
  emitExpr,
  parseExprField,
} from '../../../../src/compiler/expr/index.js';

import type { SupportedDialect } from '../../../../src/compiler/dialect.js';

interface FuzzyEmitCase {
  call: string;
  dialect: SupportedDialect;
  expected: string;
}

interface FuzzyUnsupportedCase {
  call: string;
  dialect: SupportedDialect;
  feature: string;
}

describe('fuzzy expression functions', () => {
  it.each<FuzzyEmitCase>([
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'snowflake',
      expected: 'JAROWINKLER_SIMILARITY(LEFT_NAME, RIGHT_NAME) / 100.0',
    },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'bigquery',
      expected:
        'CASE WHEN left_name IS NULL OR right_name IS NULL OR LENGTH(left_name) = 0 OR LENGTH(right_name) = 0 THEN 0.0 ' +
        'WHEN left_name = right_name THEN 1.0 ' +
        'ELSE (1.0 - EDIT_DISTANCE(left_name, right_name) / GREATEST(LENGTH(left_name), LENGTH(right_name), 1)) ' +
        '+ CASE WHEN SUBSTR(left_name, 1, 4) = SUBSTR(right_name, 1, 4) THEN 4 ' +
        'WHEN SUBSTR(left_name, 1, 3) = SUBSTR(right_name, 1, 3) THEN 3 ' +
        'WHEN SUBSTR(left_name, 1, 2) = SUBSTR(right_name, 1, 2) THEN 2 ' +
        'WHEN SUBSTR(left_name, 1, 1) = SUBSTR(right_name, 1, 1) THEN 1 ' +
        'ELSE 0 END * 0.1 * (EDIT_DISTANCE(left_name, right_name) / GREATEST(LENGTH(left_name), LENGTH(right_name), 1)) END',
    },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'postgres',
      expected: 'similarity(left_name, right_name)',
    },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'pgvector',
      expected: 'similarity(left_name, right_name)',
    },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'duckdb',
      expected: 'jaro_winkler_similarity(left_name, right_name)',
    },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'databricks',
      expected:
        'CASE WHEN left_name IS NULL OR right_name IS NULL OR LENGTH(left_name) = 0 OR LENGTH(right_name) = 0 THEN 0.0 ' +
        'WHEN left_name = right_name THEN 1.0 ' +
        'ELSE (1.0 - levenshtein(left_name, right_name) / GREATEST(LENGTH(left_name), LENGTH(right_name), 1)) ' +
        '+ CASE WHEN SUBSTR(left_name, 1, 4) = SUBSTR(right_name, 1, 4) THEN 4 ' +
        'WHEN SUBSTR(left_name, 1, 3) = SUBSTR(right_name, 1, 3) THEN 3 ' +
        'WHEN SUBSTR(left_name, 1, 2) = SUBSTR(right_name, 1, 2) THEN 2 ' +
        'WHEN SUBSTR(left_name, 1, 1) = SUBSTR(right_name, 1, 1) THEN 1 ' +
        'ELSE 0 END * 0.1 * (levenshtein(left_name, right_name) / GREATEST(LENGTH(left_name), LENGTH(right_name), 1)) END',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'snowflake',
      expected: 'EDITDISTANCE(NAME, CANDIDATE)',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'bigquery',
      expected: 'EDIT_DISTANCE(name, candidate)',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'postgres',
      expected: 'levenshtein(name, candidate)',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'pgvector',
      expected: 'levenshtein(name, candidate)',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'duckdb',
      expected: 'levenshtein(name, candidate)',
    },
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'databricks',
      expected: 'levenshtein(name, candidate)',
    },
    { call: 'soundex(name)', dialect: 'snowflake', expected: 'SOUNDEX(NAME)' },
    { call: 'soundex(name)', dialect: 'bigquery', expected: 'SOUNDEX(name)' },
    { call: 'soundex(name)', dialect: 'postgres', expected: 'soundex(name)' },
    { call: 'soundex(name)', dialect: 'pgvector', expected: 'soundex(name)' },
    { call: 'soundex(name)', dialect: 'redshift', expected: 'SOUNDEX(name)' },
    { call: 'soundex(name)', dialect: 'duckdb', expected: 'soundex(name)' },
    { call: 'soundex(name)', dialect: 'databricks', expected: 'soundex(name)' },
    { call: 'soundex(name)', dialect: 'mysql', expected: 'SOUNDEX(name)' },
    { call: 'metaphone(name)', dialect: 'postgres', expected: 'metaphone(name, 4)' },
    { call: 'metaphone(name)', dialect: 'pgvector', expected: 'metaphone(name, 4)' },
    // ClickHouse preserves identifier case, so the column names pass through
    // unfolded rather than being upper- or lower-cased.
    {
      call: 'levenshtein(name, candidate)',
      dialect: 'clickhouse',
      expected: 'editDistance(name, candidate)',
    },
    { call: 'soundex(name)', dialect: 'clickhouse', expected: 'soundex(name)' },
  ])('emits $call for $dialect', ({ call, dialect, expected }) => {
    expect(emitExpr(parseExprField(call), dialect)).toBe(expected);
  });

  it.each<FuzzyUnsupportedCase>([
    { call: 'jaro_winkler(left_name, right_name)', dialect: 'redshift', feature: 'jaro_winkler' },
    { call: 'jaro_winkler(left_name, right_name)', dialect: 'mysql', feature: 'jaro_winkler' },
    { call: 'levenshtein(name, candidate)', dialect: 'redshift', feature: 'edit_distance' },
    { call: 'levenshtein(name, candidate)', dialect: 'mysql', feature: 'edit_distance' },
    { call: 'metaphone(name)', dialect: 'snowflake', feature: 'metaphone' },
    { call: 'metaphone(name)', dialect: 'bigquery', feature: 'metaphone' },
    { call: 'metaphone(name)', dialect: 'redshift', feature: 'metaphone' },
    { call: 'metaphone(name)', dialect: 'duckdb', feature: 'metaphone' },
    { call: 'metaphone(name)', dialect: 'databricks', feature: 'metaphone' },
    { call: 'metaphone(name)', dialect: 'mysql', feature: 'metaphone' },
    {
      call: 'jaro_winkler(left_name, right_name)',
      dialect: 'clickhouse',
      feature: 'jaro_winkler',
    },
    { call: 'metaphone(name)', dialect: 'clickhouse', feature: 'metaphone' },
  ])('throws for unsupported $call on $dialect', ({ call, dialect, feature }) => {
    expect(() => emitExpr(parseExprField(call), dialect)).toThrow(
      `[unsupported_feature:fuzzy:${feature}]`
    );
  });

  it('exposes fuzzy functions in the typed manifest', () => {
    const fuzzyNames = getExpressionFunctionManifest()
      .functions.filter((fn) => fn.category === 'fuzzy')
      .map((fn) => fn.name);

    expect(fuzzyNames).toEqual(['jaro_winkler', 'levenshtein', 'metaphone', 'soundex']);
    expect(
      getExpressionFunctionManifest().functions.find((fn) => fn.name === 'jaro_winkler')?.signature
        .returns
    ).toBe('number');
  });
});
