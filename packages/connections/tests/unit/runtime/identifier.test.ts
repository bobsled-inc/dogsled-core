import { describe, expect, it } from 'vitest';

import { validateSqlIdentifier as validateProtocolSqlIdentifier } from '@bobsled-inc/protocol';
import { validateSqlIdentifier } from '../../../src/runtime/identifier.js';

describe('validateSqlIdentifier', () => {
  it('re-exports the protocol-owned validator', () => {
    expect(validateSqlIdentifier).toBe(validateProtocolSqlIdentifier);
  });

  it('accepts single and dotted identifiers', () => {
    expect(validateSqlIdentifier('schema.table', 'projection')).toBe('schema.table');
  });

  it('rejects injection payloads', () => {
    expect(() => validateSqlIdentifier('a";DROP TABLE users', 'projection')).toThrow();
  });
});
