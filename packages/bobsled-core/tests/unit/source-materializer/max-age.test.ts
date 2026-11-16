import { describe, expect, it } from 'vitest';

import { parseMaxAge } from '../../../src/runtime/source-materializer/max-age.js';

describe('parseMaxAge', () => {
  it('parses supported units to seconds', () => {
    expect(parseMaxAge('30s')).toBe(30);
    expect(parseMaxAge('15m')).toBe(900);
    expect(parseMaxAge('2h')).toBe(7200);
    expect(parseMaxAge('1d')).toBe(86400);
  });

  it('returns undefined when max_age is omitted', () => {
    expect(parseMaxAge(undefined)).toBeUndefined();
  });

  it('rejects unsupported grammar', () => {
    expect(() => parseMaxAge('1w')).toThrow(/max_age/);
    expect(() => parseMaxAge('15 minutes')).toThrow(/max_age/);
  });
});
