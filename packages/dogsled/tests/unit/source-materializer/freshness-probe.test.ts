import { describe, expect, it, vi } from 'vitest';

import { probeFreshness } from '../../../src/runtime/source-materializer/freshness-probe.js';

function fakeReader(row?: {
  source_name: string;
  filter_hash: string;
  loaded_at: string;
  record_count: number;
  row_count?: number;
  etag?: string;
  cursor_field?: string;
  cursor_type?: 'string' | 'number' | 'integer' | 'timestamp' | 'lsn';
  cursor_value?: string;
  in_progress_until?: string | null;
}) {
  return vi.fn().mockResolvedValue(row);
}

describe('probeFreshness', () => {
  const nowIso = '2026-04-22T12:10:00.000Z';

  it('returns missing when no metadata row exists', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader(undefined),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
    });
    expect(verdict.verdict).toBe('missing');
  });

  it('treats lease-only placeholders as missing', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '1970-01-01T00:00:00.000Z',
        record_count: 0,
        row_count: 0,
        in_progress_until: '2026-04-22T12:11:00.000Z',
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: undefined,
      nowIso,
    });
    expect(verdict.verdict).toBe('missing');
  });

  it('returns slice_changed when filter_hash differs', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'OLDHASH',
        loaded_at: nowIso,
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'NEWHASH',
      maxAgeSec: 900,
      nowIso,
    });
    expect(verdict.verdict).toBe('slice_changed');
  });

  it('returns aged_out when age exceeds maxAge', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T11:50:00.000Z',
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
    });
    expect(verdict.verdict).toBe('aged_out');
  });

  it('returns refresh_due instead of aged_out for stale persistent rows without cursor state', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T11:50:00.000Z',
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
      persistentMode: true,
    });
    expect(verdict).toEqual({ verdict: 'refresh_due', ageSec: 1200, recordCount: 1 });
  });

  it('returns fresh when filter_hash matches within max_age', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 42,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
    });
    expect(verdict).toEqual({ verdict: 'fresh', ageSec: 300, recordCount: 42 });
  });

  it('never returns fresh when maxAgeSec is zero', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: nowIso,
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 0,
      nowIso,
    });
    expect(verdict.verdict).toBe('aged_out');
  });

  it('returns refresh_due when maxAgeSec is zero in persistent mode', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: nowIso,
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 0,
      nowIso,
      persistentMode: true,
    });
    expect(verdict.verdict).toBe('refresh_due');
  });

  it('returns incremental_eligible when stale cursor metadata is available', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T11:50:00.000Z',
        record_count: 5,
        cursor_field: 'updated_at',
        cursor_value: '2026-04-22T11:45:00.000Z',
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
      incrementalEnabled: true,
    });

    expect(verdict).toEqual({
      verdict: 'incremental_eligible',
      ageSec: 1200,
      recordCount: 5,
      cursorField: 'updated_at',
      cursorValue: '2026-04-22T11:45:00.000Z',
    });
  });

  it('returns incremental_eligible for stale persistent rows with cursor state', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T11:50:00.000Z',
        record_count: 5,
        cursor_field: 'updated_at',
        cursor_value: '2026-04-22T11:45:00.000Z',
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
      incrementalEnabled: true,
      persistentMode: true,
    });

    expect(verdict.verdict).toBe('incremental_eligible');
  });

  it('stays aged_out when incremental refresh is disabled', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T11:50:00.000Z',
        record_count: 5,
        cursor_field: 'updated_at',
        cursor_value: '2026-04-22T11:45:00.000Z',
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: 900,
      nowIso,
      incrementalEnabled: false,
    });

    expect(verdict.verdict).toBe('aged_out');
  });

  it('treats maxAgeSec undefined as fresh when the slice matches', async () => {
    const verdict = await probeFreshness({
      readRow: fakeReader({
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2020-01-01T00:00:00.000Z',
        record_count: 1,
      }),
      schema: 's',
      sourceName: 'issues',
      currentFilterHash: 'abc',
      maxAgeSec: undefined,
      nowIso,
    });
    expect(verdict.verdict).toBe('fresh');
  });
});
