import { describe, expect, it } from 'vitest';

import {
  encodeMetadataValue,
  OBJECT_METADATA_MAX_BYTES,
  objectMetadataBytes,
  objectMetadataProblem,
} from '../../src/index.js';

describe('object metadata', () => {
  it.each([
    [{ team: 'data', 'cost-center': '4021' }],
    [{ 'run-id': 'a1b2c3d4-0000-4000-8000-000000000000' }],
    // A key may start with "dogsled-": only the two a copy sets are reserved.
    [
      {
        'dogsled-run-id': 'a1b2c3d4-0000-4000-8000-000000000000',
        'dogsled-attempt-id': '2',
        'dogsled-pipeline': 'orders',
      },
    ],
    [{}],
  ])('accepts %j', (metadata) => {
    expect(objectMetadataProblem(metadata)).toBeUndefined();
  });

  it.each([
    ['a list', ['a'], /object of text values/],
    ['text', 'team=data', /object of text values/],
    ['an upper-case key', { Team: 'data' }, /lowercase letters, digits and dashes/],
    ['a key with an underscore', { cost_center: '1' }, /lowercase letters, digits and dashes/],
    ['an empty key', { '': 'x' }, /lowercase letters, digits and dashes/],
    ['a key a copy sets', { 'dogsled-source': 'x' }, /set by a copy/],
    ['the other key a copy sets', { 'dogsled-source-modified': 'x' }, /set by a copy/],
    ['a number value', { team: 7 }, /must be text/],
    ['an empty value', { team: '' }, /must not be empty/],
  ])('refuses %s', (_label, metadata, reason) => {
    expect(objectMetadataProblem(metadata)).toMatch(reason);
  });

  it('counts the two keys a copy adds, and the prefix of every key, against the 2,048 bytes', () => {
    // S3 may or may not count the 11-byte "x-amz-meta-" before each key, so each key counts it.
    // A copy adds dogsled-source (11 + 14), dogsled-source-modified (11 + 23) and a 24-byte time.
    const room = OBJECT_METADATA_MAX_BYTES - (11 + 'note'.length) - (11 + 14) - (11 + 23) - 24;
    const fits = { note: 'x'.repeat(room) };
    const over = { note: 'x'.repeat(room + 1) };

    expect(objectMetadataProblem(fits)).toBeUndefined();
    expect(objectMetadataProblem(over)).toMatch(/at most 2048 bytes/);
  });

  it('counts a value as it will be written, after percent-encoding', () => {
    // Each of these characters is 2 bytes in UTF-8, and 6 once encoded.
    const metadata = { note: 'é'.repeat(400) };

    expect(objectMetadataBytes(metadata)).toBe(11 + 'note'.length + 400 * 6);
    expect(objectMetadataProblem(metadata)).toMatch(/at most 2048 bytes/);
  });

  it('encodes every byte that is not US-ASCII, and the percent sign, so decoding restores it', () => {
    const value = 'incoming/2026/café 100%.csv';

    const encoded = encodeMetadataValue(value);

    expect(encoded).toBe('incoming/2026/caf%C3%A9%20100%25.csv');
    expect(encoded).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(encoded)).toBe(value);
    expect(encodeMetadataValue('2026-11-20T15:24:53.408Z')).toBe('2026-11-20T15:24:53.408Z');
  });
});
