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

  it('keeps the source key and the modified time when the sender gives them', () => {
    const message = {
      ...base,
      source_key: 'incoming/2026/report.csv',
      modified: '2026-11-20T15:24:53.408Z',
    };
    expect(parseRequiredStdoutMessage(message)).toEqual(message);
    expect(
      parseRequiredStdoutMessage({ ...base, modified: '2026-11-20T09:24:53+06:00' })
    ).toMatchObject({ modified: '2026-11-20T09:24:53+06:00' });
    expect(
      parseRequiredStdoutMessage({ ...base, modified: '2026-11-20T15:24:53.123456789Z' })
    ).toMatchObject({ modified: '2026-11-20T15:24:53.123456789Z' });
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
    ['empty source_key', { ...base, source_key: '' }],
    ['numeric source_key', { ...base, source_key: 7 }],
    ['modified that is not text', { ...base, modified: 1763652293408 }],
    ['modified that is not a date-time', { ...base, modified: 'yesterday' }],
    ['modified without a zone', { ...base, modified: '2026-11-20T15:24:53' }],
    ['modified that is not a real date', { ...base, modified: '2026-13-45T25:61:61Z' }],
    // More than nine fraction digits is refused, so that a time stays small enough for an object.
    [
      'modified with a 3,000-digit fraction',
      { ...base, modified: `2026-11-20T15:24:53.${'1'.repeat(3000)}Z` },
    ],
  ])('rejects %s', (_label, message) => {
    expect(() => parseRequiredStdoutMessage(message)).toThrow();
  });
});
