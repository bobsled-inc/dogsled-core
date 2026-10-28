import { describe, expect, it } from 'vitest';

import { isValidSqlIdentifier, validateSqlIdentifier } from '../../src/sql-identifiers.js';

describe('SQL identifier validation', () => {
  it('accepts single and dot-qualified identifiers', () => {
    expect(validateSqlIdentifier('schema.table', 'projection')).toBe('schema.table');
    expect(isValidSqlIdentifier('column_name')).toBe(true);
  });

  it('rejects injection payloads', () => {
    expect(() => validateSqlIdentifier('a";DROP TABLE users', 'projection')).toThrow();
    expect(isValidSqlIdentifier('schema.table;DROP')).toBe(false);
  });
});
