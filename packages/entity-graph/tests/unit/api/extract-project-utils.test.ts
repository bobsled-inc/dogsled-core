import { describe, it, expect } from 'vitest';

import { buildFqName } from '@bobsled-inc/model-spec';

import { insertRows, sqlValue } from '../../../src/api/extract-project-utils.js';

describe('sqlValue — dialect-aware literal escaping', () => {
  it("backslash-escapes apostrophes for BigQuery instead of '' doubling", () => {
    // Regression: BigQuery parses '' as two adjacent string literals and rejects
    // them with "concatenated string literals must be separated by whitespace or
    // comments". It requires \'. The old hand-rolled escaper emitted '' and broke
    // extract_mentions / extract_relationships on every apostrophe-bearing value.
    expect(sqlValue("What We're Shooting For", 'bigquery')).toBe("'What We\\'re Shooting For'");
  });

  it("doubles apostrophes for ANSI dialects (DuckDB uses '')", () => {
    expect(sqlValue("O'Brien", 'duckdb')).toBe("'O''Brien'");
  });

  it('passes multi-byte typography (em-dash) through unchanged — it was never the bug', () => {
    // The em-dash is ordinary UTF-8 inside a literal; BigQuery accepts it. Only
    // the ASCII apostrophe in the same titles triggered the parse error.
    expect(sqlValue('Lakehouse evolution plan — 2026', 'bigquery')).toBe(
      "'Lakehouse evolution plan — 2026'"
    );
  });

  it('renders NULL / numbers / booleans without quoting', () => {
    expect(sqlValue(null, 'bigquery')).toBe('NULL');
    expect(sqlValue(undefined, 'bigquery')).toBe('NULL');
    expect(sqlValue(42, 'bigquery')).toBe('42');
    expect(sqlValue(true, 'bigquery')).toBe('TRUE');
  });
});

describe('insertRows — generated BigQuery INSERT', () => {
  it('emits BigQuery-valid escaping for apostrophe-bearing text', async () => {
    const captured: string[] = [];
    const runner = {
      run: async (sql: string) => {
        captured.push(sql);
        return {};
      },
    };
    const table = buildFqName('eg', '__document_mentions', 'bigquery');
    await insertRows(
      runner,
      table,
      ['entity_name'],
      [{ entity_name: "What We're Shooting For — June 2026" }],
      'bigquery'
    );
    expect(captured).toHaveLength(1);
    const sql = captured[0]!;
    // Backslash-escaped apostrophe, em-dash preserved, no '' doubling.
    expect(sql).toContain("'What We\\'re Shooting For — June 2026'");
    expect(sql).not.toContain("We''re");
  });
});
