import { describe, expect, it, vi } from 'vitest';

import { withRefreshLease } from '../../../src/runtime/source-materializer/refresh-lease.js';
import type { Receipt } from '../../../src/runtime/source-materializer/receipt.js';

const receipt: Receipt = {
  source: 'issues',
  target: 'duckdb',
  table: 'sources.issues__limit_5',
  filterHash: 'abc',
  snapshotAgeSeconds: 0,
  records: 5,
  action: 'materialized',
  durationMs: 1,
  snapshotKind: 'limited',
  snapshotVariant: 'limit=5',
};

describe('withRefreshLease', () => {
  it('scopes lease acquire and release to the current snapshot token', async () => {
    const beginRefresh = vi.fn().mockResolvedValue({
      acquired: true,
      inProgressUntil: '2026-04-27T16:01:00.000Z',
    });
    const finishRefresh = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRefreshLease({
        context: {
          target: 'duckdb',
          schema: 'sources',
          currentFilterHash: 'abc',
          nowIso: '2026-04-27T16:00:00.000Z',
          snapshotKind: 'limited',
          snapshotVariant: 'limit=5',
          readRow: vi.fn(),
          beginRefresh,
          finishRefresh,
        },
        sourceName: 'issues',
        operation: async () => receipt,
        retry: async () => receipt,
      })
    ).resolves.toEqual(receipt);

    expect(beginRefresh).toHaveBeenCalledWith({
      schema: 'sources',
      sourceName: 'issues',
      filterHash: 'abc',
      snapshotKind: 'limited',
      snapshotVariant: 'limit=5',
    });
    expect(finishRefresh).toHaveBeenCalledWith({
      schema: 'sources',
      sourceName: 'issues',
      filterHash: 'abc',
      snapshotKind: 'limited',
      snapshotVariant: 'limit=5',
      inProgressUntil: '2026-04-27T16:01:00.000Z',
    });
  });
});
