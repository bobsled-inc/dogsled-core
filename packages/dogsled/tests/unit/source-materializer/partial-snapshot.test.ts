import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  materializePartial,
  partialTableName,
} from '../../../src/runtime/source-materializer/partial-snapshot.js';

describe('partialTableName', () => {
  it('derives a deterministic name', () => {
    expect(partialTableName('github_issues', 100)).toBe('github_issues__limit_100');
  });

  it('rejects non-positive or non-integer limits with a validation error', () => {
    for (const limit of [0, -1, 3.5]) {
      try {
        partialTableName('github_issues', limit);
        throw new Error('expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(CommandError);
        expect((error as CommandError).exitCode).toBe(EXIT_VALIDATION);
        expect((error as Error).message).toMatch(/positive integer/);
      }
    }
  });
});

describe('materializePartial', () => {
  it('fetches exactly N rows and writes them through the provided callback', async () => {
    let writtenRows: Array<Record<string, unknown>> = [];

    const result = await materializePartial({
      integration: {} as never,
      resource: {} as never,
      limit: 5,
      queryResourceImpl: async (options) => ({
        records: Array.from({ length: options.limit }, (_, index) => ({ id: index })),
        limitReached: true,
        requestCount: 1,
      }),
      writePartialImpl: async (rows) => {
        writtenRows = rows;
      },
    });

    expect(result.recordCount).toBe(5);
    expect(result.limitReached).toBe(true);
    expect(writtenRows).toHaveLength(5);
  });

  it('truncates over-delivered rows before persisting a limited snapshot', async () => {
    let writtenRows: Array<Record<string, unknown>> = [];

    const result = await materializePartial({
      integration: {} as never,
      resource: {} as never,
      limit: 5,
      queryResourceImpl: async () => ({
        records: Array.from({ length: 7 }, (_, index) => ({ id: index })),
        limitReached: false,
        requestCount: 2,
      }),
      writePartialImpl: async (rows) => {
        writtenRows = rows;
      },
    });

    expect(writtenRows).toHaveLength(5);
    expect(result.recordCount).toBe(5);
    expect(result.requestCount).toBe(2);
    expect(result.limitReached).toBe(true);
  });
});
