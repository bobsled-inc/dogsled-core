import { describe, expect, it } from 'vitest';
import {
  assertBacktickIdentifier,
  assertBigQueryQuotedIdentifier,
  quoteWarehouseIdentifier,
  quoteWarehouseLiteral,
} from '../../src/sql-quoting.js';
describe('backslash warehouse quoting', () => {
  it('keeps hostile values within one SQL literal', () => {
    expect(quoteWarehouseLiteral("x\\', (SELECT current_user()) -- \n\r\t\b\f")).toBe(
      "'x\\\\'', (SELECT current_user()) -- \\n\\r\\t\\b\\f'"
    );
  });
  it('escapes identifier delimiters', () => {
    expect(quoteWarehouseIdentifier('a`b', 'databricks')).toBe('`a``b`');
    expect(quoteWarehouseIdentifier('a"b', 'snowflake')).toBe('"a""b"');
  });
});

describe('backtick identifier guard', () => {
  it.each(['x\\', 'x\\` AS SELECT 1', 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a b'])(
    'rejects %j before quoting',
    (value) => {
      expect(() => assertBacktickIdentifier(value)).toThrow(
        'backslashes and control characters are not allowed'
      );
      expect(() => quoteWarehouseIdentifier(value, 'databricks')).toThrow(
        'backslashes and control characters are not allowed'
      );
    }
  );

  it('keeps ordinary and double-quoted identifiers unchanged', () => {
    expect(assertBacktickIdentifier('analytics-dev')).toBe('analytics-dev');
    expect(quoteWarehouseIdentifier('a\\b', 'snowflake')).toBe('"a\\b"');
  });
});

describe('BigQuery quoted identifier guard', () => {
  it('rejects backticks, backslashes, and control characters', () => {
    for (const value of ['a`b', 'x\\', 'a\nb']) {
      expect(() => assertBigQueryQuotedIdentifier(value)).toThrow();
    }
    expect(assertBigQueryQuotedIdentifier('analytics-dev.raw.INFORMATION_SCHEMA.COLUMNS')).toBe(
      'analytics-dev.raw.INFORMATION_SCHEMA.COLUMNS'
    );
  });
});
