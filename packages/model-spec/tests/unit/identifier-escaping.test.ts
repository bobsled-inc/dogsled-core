/**
 * Defense-in-depth SQL injection tests for identifier interpolation paths
 * used by the cross-warehouse publisher and other model-spec consumers.
 *
 * The primary line of defense is `identifierRegex` (`/^[a-zA-Z_]\w*$/`) on
 * source/model column-name schemas, which rejects malicious YAML inputs at
 * parse time. These tests pin that behavior and verify the secondary
 * defense — `quoteIdentifier` quotes per-dialect even if a caller bypasses
 * schema validation.
 */
import { describe, expect, it } from 'vitest';

import {
  caseName,
  getCanonicalDialect,
  quoteIdentifier,
  SUPPORTED_DIALECTS,
} from '../../src/compiler/index.js';
import type { SupportedDialect } from '../../src/compiler/dialect.js';
import { identifierRegex, identifierMsg } from '../../src/compiler/shared-validators.js';

describe('identifier validation', () => {
  describe('identifierRegex (the primary line of defense)', () => {
    it('accepts valid identifiers', () => {
      for (const valid of ['foo', 'FOO', '_foo', 'foo_bar', 'foo123', 'F_1_x']) {
        expect(identifierRegex.test(valid)).toBe(true);
      }
    });

    it('rejects injection attempts at the YAML schema layer', () => {
      const adversarial = [
        'foo; DROP TABLE x; --',
        'foo`; DROP TABLE x; --',
        'foo"; DROP TABLE x; --',
        "foo'; DELETE FROM y; --",
        'foo OR 1=1',
        'foo--comment',
        'foo /* comment */ bar',
        'foo UNION SELECT',
        '1foo', // starts with digit — disallowed
        '"injected"',
        '`injected`',
        '$injected',
        '',
        ' ',
        'foo bar',
        'foo.bar',
        'foo,bar',
        'foo;bar',
        'foo\nbar',
        'foo\0bar',
      ];
      for (const bad of adversarial) {
        expect(identifierRegex.test(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(
          false
        );
      }
    });

    it('error message is actionable', () => {
      expect(identifierMsg).toMatch(/identifier/);
    });
  });

  describe('quoteIdentifier (defense-in-depth at SQL emission)', () => {
    // For each dialect, verify quoting + embedded-quote escaping. These
    // adversarial inputs would NEVER reach quoteIdentifier in practice
    // because identifierRegex rejects them — but the cross-warehouse
    // publisher uses quoteIdentifier in sourceSelectSql precisely so a
    // programmatic caller that builds a SourceEntryColumn without going
    // through the YAML schema layer cannot inject SQL.
    // quoteIdentifier case-folds before quoting (Snowflake → UPPER,
    // others → lower), so adversarial inputs are normalized in case before
    // the embedded-quote doubling escape applies.
    const cases: Array<{
      dialect: SupportedDialect;
      input: string;
      expected: string;
    }> = [
      { dialect: 'snowflake', input: 'foo', expected: '"FOO"' },
      { dialect: 'snowflake', input: 'foo"; DROP', expected: '"FOO""; DROP"' },
      { dialect: 'bigquery', input: 'foo', expected: '`foo`' },
      { dialect: 'postgres', input: 'foo', expected: '"foo"' },
      { dialect: 'postgres', input: 'foo"; DROP', expected: '"foo""; drop"' },
      { dialect: 'duckdb', input: 'foo', expected: '"foo"' },
      { dialect: 'duckdb', input: 'foo"; DROP', expected: '"foo""; drop"' },
      { dialect: 'databricks', input: 'foo', expected: '`foo`' },
      { dialect: 'databricks', input: 'foo`; DROP', expected: '`foo``; drop`' },
    ];

    for (const { dialect, input, expected } of cases) {
      it(`quotes and escapes for ${dialect}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
        expect(quoteIdentifier(input, dialect)).toBe(expected);
      });
    }

    it('bigquery rejects embedded backticks and backslashes instead of doubling', () => {
      expect(() => quoteIdentifier('foo`; DROP', 'bigquery')).toThrow('cannot contain backticks');
      expect(() => quoteIdentifier('foo\\', 'bigquery')).toThrow('backslashes');
    });

    it('every supported dialect has a quoting strategy that escapes its quote char', () => {
      for (const dialect of SUPPORTED_DIALECTS) {
        if (getCanonicalDialect(dialect) === 'bigquery') continue;
        const quoted = quoteIdentifier('foo', dialect);
        // Every quoted form must start and end with the same quote character.
        const firstChar = quoted.charAt(0);
        const lastChar = quoted.charAt(quoted.length - 1);
        expect(firstChar).toBe(lastChar);
        expect(['"', '`']).toContain(firstChar);
        // Embedded quotes must be doubled (SQL standard escape).
        const adversarialQuoted = quoteIdentifier(`foo${firstChar}bar`, dialect);
        expect(adversarialQuoted).toContain(`${firstChar}${firstChar}`);
      }
    });
  });

  describe('caseName (case-folding only, NOT a SQL safety boundary)', () => {
    it('does not quote — relies on schema validation upstream', () => {
      // This test exists to pin caseName's intentionally limited behavior
      // so a future "fix" that adds quoting to caseName doesn't silently
      // break call sites that compose case-folded names into larger
      // identifiers (e.g. fqRef construction). The cross-warehouse publisher
      // now uses quoteIdentifier explicitly for its SELECT-list emission.
      expect(caseName('foo', 'snowflake')).toBe('FOO');
      expect(caseName('FOO', 'bigquery')).toBe('foo');
      expect(caseName('Foo_Bar', 'postgres')).toBe('foo_bar');
    });
  });
});
