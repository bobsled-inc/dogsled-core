import { describe, expect, it } from 'vitest';

import { REPLACE_MAX_VALUES, parseRequiredStdoutMessage } from '../../src/index.js';

const base = { _v: 1, type: 'REPLACE', stream: 'docs__chunks', key: 'document_id' };

describe('REPLACE message', () => {
  it('parses a stream, key and values', () => {
    expect(parseRequiredStdoutMessage({ ...base, values: ['a', 'b'] })).toEqual({
      ...base,
      values: ['a', 'b'],
    });
  });

  it.each([
    ['missing values', { ...base }],
    ['empty values', { ...base, values: [] }],
    ['non-string value', { ...base, values: [1] }],
    [
      'too many values',
      { ...base, values: Array.from({ length: REPLACE_MAX_VALUES + 1 }, String) },
    ],
    ['missing key', { ...base, key: undefined, values: ['a'] }],
    ['empty key', { ...base, key: '', values: ['a'] }],
  ])('rejects %s', (_label, message) => {
    expect(() => parseRequiredStdoutMessage(message)).toThrow();
  });
});
