import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { snapshotKey } from '../../../src/runtime/source-materializer/snapshot-key.js';

describe('snapshotKey', () => {
  it('returns canonical variant with null when no limit is set', () => {
    expect(snapshotKey({ filterHash: 'abc' })).toEqual({
      filterHash: 'abc',
      snapshotKind: 'canonical',
      snapshotVariant: null,
    });
  });

  it('returns a readable limited variant string', () => {
    expect(snapshotKey({ filterHash: 'abc', limit: 100 })).toEqual({
      filterHash: 'abc',
      snapshotKind: 'limited',
      snapshotVariant: 'limit=100',
    });
  });

  it('rejects non-positive or fractional limits with a validation error', () => {
    for (const limit of [0, -1, 1.5]) {
      try {
        snapshotKey({ filterHash: 'abc', limit });
        throw new Error('expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(CommandError);
        expect((error as CommandError).exitCode).toBe(EXIT_VALIDATION);
        expect((error as Error).message).toMatch(/positive integer/);
      }
    }
  });
});
