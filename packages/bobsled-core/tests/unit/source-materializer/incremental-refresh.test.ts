import { describe, expect, it } from 'vitest';

import { runIncrementalRefresh } from '../../../src/runtime/source-materializer/incremental-refresh.js';

describe('runIncrementalRefresh', () => {
  const baseResource = {
    output: {
      id: { type: 'integer' },
      updated_at: { type: 'timestamp' },
    },
  } as const;

  it('fetches delta rows and returns the max cursor seen', async () => {
    let merged: Record<string, unknown>[] = [];

    const result = await runIncrementalRefresh({
      integration: {} as never,
      resource: baseResource,
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
      keyProperties: ['id'],
      queryResourceImpl: async () => ({
        records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async (rows) => {
        merged = rows;
      },
    });

    expect(result).toEqual({
      outcome: 'merged',
      newCursorValue: '2026-04-23T10:00:00Z',
      deltaRowCount: 1,
    });
    expect(merged).toHaveLength(1);
  });

  it('appends delta rows without requiring merge keys', async () => {
    let appended: Record<string, unknown>[] = [];

    const result = await runIncrementalRefresh({
      strategy: 'append',
      integration: {} as never,
      resource: {
        output: {
          created_at: { type: 'timestamp' },
        },
      },
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'created_at',
      cursorType: 'timestamp',
      keyProperties: [],
      queryResourceImpl: async () => ({
        records: [{ created_at: '2026-04-23T10:00:00Z', event: 'opened' }],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => {
        throw new Error('merge should not be used for append strategy');
      },
      appendImpl: async (rows) => {
        appended = rows;
      },
    });

    expect(result).toEqual({
      outcome: 'appended',
      newCursorValue: '2026-04-23T10:00:00Z',
      deltaRowCount: 1,
    });
    expect(appended).toHaveLength(1);
  });

  it('does not append rows at the prior cursor boundary', async () => {
    let appended: Record<string, unknown>[] = [];

    const result = await runIncrementalRefresh({
      strategy: 'append',
      integration: {} as never,
      resource: {
        output: {
          created_at: { type: 'timestamp' },
        },
      },
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'created_at',
      cursorType: 'timestamp',
      keyProperties: [],
      queryResourceImpl: async () => ({
        records: [
          { created_at: '2026-04-22T00:00:00Z', event: 'already-seen' },
          { created_at: '2026-04-23T10:00:00Z', event: 'opened' },
        ],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => {
        throw new Error('merge should not be used for append strategy');
      },
      appendImpl: async (rows) => {
        appended = rows;
      },
    });

    expect(result).toEqual({
      outcome: 'appended',
      newCursorValue: '2026-04-23T10:00:00Z',
      deltaRowCount: 1,
    });
    expect(appended).toEqual([{ created_at: '2026-04-23T10:00:00Z', event: 'opened' }]);
  });

  it('reports zero_delta when append refresh only sees the prior cursor row', async () => {
    let appendCalls = 0;

    const result = await runIncrementalRefresh({
      strategy: 'append',
      integration: {} as never,
      resource: {
        output: {
          created_at: { type: 'timestamp' },
        },
      },
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'created_at',
      cursorType: 'timestamp',
      keyProperties: [],
      queryResourceImpl: async () => ({
        records: [{ created_at: '2026-04-22T00:00:00Z', event: 'already-seen' }],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => undefined,
      appendImpl: async () => {
        appendCalls += 1;
      },
    });

    expect(result).toEqual({
      outcome: 'zero_delta',
      newCursorValue: '2026-04-22T00:00:00Z',
      deltaRowCount: 0,
    });
    expect(appendCalls).toBe(0);
  });

  it('returns zero_delta when the extractor yields no rows', async () => {
    const result = await runIncrementalRefresh({
      integration: {} as never,
      resource: baseResource,
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
      keyProperties: ['id'],
      queryResourceImpl: async () => ({
        records: [],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => undefined,
    });

    expect(result).toEqual({
      outcome: 'zero_delta',
      newCursorValue: '2026-04-22T00:00:00Z',
      deltaRowCount: 0,
    });
  });

  it('falls back on null cursors', async () => {
    const result = await runIncrementalRefresh({
      integration: {} as never,
      resource: baseResource,
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
      keyProperties: ['id'],
      queryResourceImpl: async () => ({
        records: [{ id: 2, updated_at: null }],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => undefined,
    });

    expect(result).toEqual({
      outcome: 'fallback',
      fallbackReason: 'null_cursor',
      deltaRowCount: 0,
    });
  });

  it('falls back on cursor regression', async () => {
    const result = await runIncrementalRefresh({
      integration: {} as never,
      resource: baseResource,
      priorCursorValue: '2026-04-23T00:00:00Z',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
      keyProperties: ['id'],
      queryResourceImpl: async () => ({
        records: [{ id: 2, updated_at: '2026-04-22T00:00:00Z' }],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => undefined,
    });

    expect(result).toEqual({
      outcome: 'fallback',
      fallbackReason: 'cursor_regression',
      deltaRowCount: 0,
    });
  });

  it('falls back when no merge keys are available', async () => {
    const result = await runIncrementalRefresh({
      integration: {} as never,
      resource: {
        output: {
          updated_at: { type: 'timestamp' },
        },
      },
      priorCursorValue: '2026-04-22T00:00:00Z',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
      keyProperties: [],
      queryResourceImpl: async () => ({
        records: [],
        limitReached: false,
        requestCount: 1,
      }),
      mergeImpl: async () => undefined,
    });

    expect(result).toEqual({
      outcome: 'fallback',
      fallbackReason: 'missing_keys',
      deltaRowCount: 0,
    });
  });
});
