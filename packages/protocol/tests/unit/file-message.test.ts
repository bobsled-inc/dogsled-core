import { describe, expect, it } from 'vitest';

import { parseRequiredStdoutMessage } from '../../src/index.js';

const base = {
  _v: 1,
  type: 'FILE',
  stream: 'drops',
  uri: 'file:///tmp/dogsled-copy-abc123/1',
  relative_key: '2026/report.csv',
  size: 120,
};

describe('FILE message', () => {
  it('parses a stream, temp file URI, relative key and size', () => {
    expect(parseRequiredStdoutMessage(base)).toEqual(base);
  });

  it('keeps an empty file', () => {
    expect(parseRequiredStdoutMessage({ ...base, size: 0 })).toMatchObject({ size: 0 });
  });

  it.each([
    ['missing stream', { ...base, stream: undefined }],
    ['missing uri', { ...base, uri: undefined }],
    ['non-file uri', { ...base, uri: 'https://example.com/report.csv' }],
    ['missing relative_key', { ...base, relative_key: undefined }],
    ['empty relative_key', { ...base, relative_key: '' }],
    ['null byte in relative_key', { ...base, relative_key: 'a\0b.csv' }],
    ['missing size', { ...base, size: undefined }],
    ['negative size', { ...base, size: -1 }],
    ['fractional size', { ...base, size: 1.5 }],
    ['string size', { ...base, size: '120' }],
  ])('rejects %s', (_label, message) => {
    expect(() => parseRequiredStdoutMessage(message)).toThrow();
  });
});
