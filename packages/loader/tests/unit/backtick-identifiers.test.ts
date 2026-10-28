import { describe, expect, it } from 'vitest';

import { quoteBqIdentifier } from '../../src/runtime/destinations/bigquery-identifiers.js';

describe('BigQuery loader identifier quoting', () => {
  it.each(['x\\', 'x\\ AS SELECT 1; DROP TABLE t; --', 'a\nb', 'a\u0000b'])(
    'rejects %j before quoting',
    (value) => {
      expect(() => quoteBqIdentifier(value)).toThrow(
        'backslashes and control characters are not allowed'
      );
    }
  );

  it('keeps backticks rejected and ordinary names quoted', () => {
    expect(() => quoteBqIdentifier('a`b')).toThrow('backticks are not allowed');
    expect(quoteBqIdentifier('analytics-dev')).toBe('`analytics-dev`');
  });
});
