import { describe, expect, it } from 'vitest';

import {
  isValidStreamSubfolder,
  normalizeStreamSubfolder,
  STREAM_SUBFOLDER_MAX_LENGTH,
} from '../../src/stream-subfolder.js';

describe('stream subfolder rule', () => {
  it.each([
    'data',
    'data/20261120T050007Z-9f3a1c2b',
    'date=2026-11-20',
    'a.b_c-d/e',
    'a'.repeat(STREAM_SUBFOLDER_MAX_LENGTH),
  ])('accepts %s', (value) => {
    expect(isValidStreamSubfolder(value)).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '../up',
    'a/../b',
    'a/./b',
    '/absolute',
    'a//b',
    'a/',
    'a\\b',
    'a b',
    'a?b',
    'a#b',
    'a'.repeat(STREAM_SUBFOLDER_MAX_LENGTH + 1),
  ])('rejects %j', (value) => {
    expect(isValidStreamSubfolder(value)).toBe(false);
  });

  it('removes trailing slashes only', () => {
    expect(normalizeStreamSubfolder('data/run-1//')).toBe('data/run-1');
    expect(normalizeStreamSubfolder('data/run-1')).toBe('data/run-1');
  });
});
