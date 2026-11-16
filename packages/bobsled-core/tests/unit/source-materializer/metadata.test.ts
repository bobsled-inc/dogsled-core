import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureMetadataTable,
  readMetadataRow,
  upsertMetadataRow,
  type MetadataRow,
} from '../../../src/runtime/source-materializer/metadata.js';
import {
  DuckDBMetadataStore,
  InMemoryMetadataStore,
} from '../../../src/runtime/source-materializer/metadata-store.js';

function fakeRunner(rows: MetadataRow[] = []) {
  const calls: string[] = [];

  function handleSql(sql: string): { rows: MetadataRow[]; rowCount: number } {
    calls.push(sql);
    if (/SELECT.*FROM.*_bobsled_source_metadata/is.test(sql)) {
      const sourceMatch = /source_name\s*=\s*'([^']+)'/i.exec(sql);
      const filterMatch = /filter_hash\s*=\s*'([^']+)'/i.exec(sql);
      const kindMatch =
        /COALESCE\(snapshot_kind,\s*'canonical'\)\s*=\s*'([^']+)'/i.exec(sql) ??
        /snapshot_kind\s*=\s*'([^']+)'/i.exec(sql);
      const variantMatch = /snapshot_variant\s*=\s*'([^']+)'/i.exec(sql);
      const requiresNullVariant = /snapshot_variant\s+IS\s+NULL/i.test(sql);
      const row = sourceMatch
        ? [...rows]
            .filter(
              (candidate) =>
                candidate.source_name === sourceMatch[1] &&
                (filterMatch === null || candidate.filter_hash === filterMatch[1]) &&
                (kindMatch === null || (candidate.snapshot_kind ?? 'canonical') === kindMatch[1]) &&
                (!requiresNullVariant || (candidate.snapshot_variant ?? null) === null) &&
                (variantMatch === null || candidate.snapshot_variant === variantMatch[1])
            )
            .sort(
              (left, right) =>
                Date.parse(String(right.loaded_at)) - Date.parse(String(left.loaded_at))
            )[0]
        : undefined;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  const runner = {
    run: vi.fn(async (sql: string) => handleSql(sql)),
    query: vi.fn(async (sql: string) => handleSql(sql).rows),
    calls,
  };
  return runner;
}

describe('metadata helpers', () => {
  it('MetadataRow accepts cursor and snapshot fields', () => {
    const row: MetadataRow = {
      source_name: 'issues',
      filter_hash: 'abc123',
      loaded_at: '2026-04-23T00:00:00Z',
      record_count: 42,
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      cursor_value: '2026-04-22T23:59:00Z',
      snapshot_kind: 'canonical',
      snapshot_variant: null,
      row_count: 42,
      in_progress_until: null,
    };

    expect(row.cursor_value).toBe('2026-04-22T23:59:00Z');
    expect(row.snapshot_kind).toBe('canonical');
  });

  it('ensureMetadataTable creates the target schema table', async () => {
    const runner = fakeRunner();
    await ensureMetadataTable({ runner, schema: 'analytics', dialect: 'duckdb' });
    expect(runner.calls.some((sql) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(sql))).toBe(true);
    expect(runner.calls[0]).toContain('"analytics"."_bobsled_source_metadata"');
  });

  it('ensureMetadataTable adds cursor and snapshot columns additively', async () => {
    const runner = fakeRunner();
    await ensureMetadataTable({ runner, schema: 'analytics', dialect: 'duckdb' });

    for (const column of [
      'cursor_field',
      'cursor_type',
      'cursor_value',
      'snapshot_kind',
      'snapshot_variant',
      'row_count',
      'in_progress_until',
    ]) {
      expect(
        runner.calls.some((sql) => /ADD COLUMN IF NOT EXISTS/i.test(sql) && sql.includes(column))
      ).toBe(true);
    }
  });

  it('uses BigQuery identifiers and scalar types for BigQuery metadata', async () => {
    const runner = fakeRunner();
    await ensureMetadataTable({ runner, schema: 'analytics', dialect: 'bigquery' });
    expect(runner.calls[0]).toContain('`analytics`.`_bobsled_source_metadata`');
    expect(runner.calls[0]).toContain('source_name  STRING');
    expect(runner.calls[0]).toContain('record_count INT64');
  });

  it('readMetadataRow returns undefined when no row exists', async () => {
    const runner = fakeRunner([]);
    await expect(
      readMetadataRow({ runner, schema: 'analytics', sourceName: 'issues' })
    ).resolves.toBeUndefined();
  });

  it('readMetadataRow returns the row for the current source', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
    ]);
    await expect(
      readMetadataRow({ runner, schema: 'analytics', sourceName: 'issues' })
    ).resolves.toEqual({
      source_name: 'issues',
      filter_hash: 'abc',
      loaded_at: '2026-04-22T12:00:00.000Z',
      record_count: 42,
      snapshot_kind: 'canonical',
      snapshot_variant: null,
    });
  });

  it('readMetadataRow can select the current source and filter slice', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'old',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 1,
      },
      {
        source_name: 'issues',
        filter_hash: 'current',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 2,
      },
    ]);

    await expect(
      readMetadataRow({
        runner,
        schema: 'analytics',
        sourceName: 'issues',
        filterHash: 'current',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        filter_hash: 'current',
        record_count: 2,
      })
    );
  });

  it('readMetadataRow returns the newest matching snapshot row', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'current',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 1,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
      {
        source_name: 'issues',
        filter_hash: 'current',
        loaded_at: '2026-04-22T12:10:00.000Z',
        record_count: 2,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
    ]);

    await expect(
      readMetadataRow({
        runner,
        schema: 'analytics',
        sourceName: 'issues',
        filterHash: 'current',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        loaded_at: '2026-04-22T12:10:00.000Z',
        record_count: 2,
      })
    );
  });

  it('readMetadataRow defaults to the canonical snapshot and can target limited variants', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'current',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 2,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
      {
        source_name: 'issues',
        filter_hash: 'current',
        loaded_at: '2026-04-22T12:06:00.000Z',
        record_count: 1,
        snapshot_kind: 'limited',
        snapshot_variant: 'limit=1',
      },
    ]);

    await expect(
      readMetadataRow({
        runner,
        schema: 'analytics',
        sourceName: 'issues',
        filterHash: 'current',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      })
    );

    await expect(
      readMetadataRow({
        runner,
        schema: 'analytics',
        sourceName: 'issues',
        filterHash: 'current',
        snapshotKind: 'limited',
        snapshotVariant: 'limit=1',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        snapshot_kind: 'limited',
        snapshot_variant: 'limit=1',
      })
    );
  });

  it('normalizes timezone-less warehouse timestamps as UTC instants', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22 12:00:00',
        record_count: 42,
      },
    ]);
    await expect(
      readMetadataRow({ runner, schema: 'analytics', sourceName: 'issues' })
    ).resolves.toEqual(
      expect.objectContaining({
        loaded_at: '2026-04-22T12:00:00.000Z',
      })
    );
  });

  it('readMetadataRow returns active lease timestamps as UTC instants', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22 12:00:00',
        record_count: 42,
        in_progress_until: '2026-04-22 12:01:00',
      },
    ]);
    await expect(
      readMetadataRow({ runner, schema: 'analytics', sourceName: 'issues' })
    ).resolves.toEqual(
      expect.objectContaining({
        in_progress_until: '2026-04-22T12:01:00.000Z',
      })
    );
  });

  it('upsertMetadataRow deletes then inserts for duckdb', async () => {
    const runner = fakeRunner();
    await upsertMetadataRow({
      runner,
      schema: 'analytics',
      row: {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        cursor_field: 'updated_at',
        cursor_type: 'timestamp',
        cursor_value: '2026-04-22T11:59:00.000Z',
        snapshot_kind: 'canonical',
        snapshot_variant: null,
        row_count: 42,
      },
    });
    expect(
      runner.calls.some(
        (sql) =>
          /^DELETE FROM/i.test(sql.trim()) &&
          /source_name = 'issues'/i.test(sql) &&
          /filter_hash = 'abc'/i.test(sql) &&
          /COALESCE\(snapshot_kind, 'canonical'\) = 'canonical'/i.test(sql) &&
          /snapshot_variant IS NULL/i.test(sql)
      )
    ).toBe(true);
    expect(runner.calls.some((sql) => /^INSERT INTO/i.test(sql.trim()))).toBe(true);
    const insertSql = runner.calls.find((sql) => /^INSERT INTO/i.test(sql.trim()));
    expect(insertSql).toContain('cursor_field');
    expect(insertSql).toContain('cursor_type');
    expect(insertSql).toContain('cursor_value');
    expect(insertSql).toContain('snapshot_kind');
    expect(insertSql).toContain('snapshot_variant');
    expect(insertSql).toContain('row_count');
    expect(insertSql).toContain('in_progress_until');
  });

  it('upsertMetadataRow uses MERGE for bigquery', async () => {
    const runner = fakeRunner();
    await upsertMetadataRow({
      runner,
      schema: 'analytics',
      dialect: 'bigquery',
      row: {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
    });
    expect(runner.calls.some((sql) => /^MERGE/i.test(sql.trim()))).toBe(true);
    expect(
      runner.calls.some((sql) =>
        /ON t\.source_name = s\.source_name AND t\.filter_hash = s\.filter_hash AND COALESCE\(t\.snapshot_kind, 'canonical'\) = 'canonical' AND t\.snapshot_variant IS NULL/.test(
          sql
        )
      )
    ).toBe(true);
    expect(runner.calls.some((sql) => /TIMESTAMP\('2026-04-22T12:00:00.000Z'\)/.test(sql))).toBe(
      true
    );
  });

  it('upsertMetadataRow uses MERGE for snowflake', async () => {
    const runner = fakeRunner();
    await upsertMetadataRow({
      runner,
      schema: 'analytics',
      dialect: 'snowflake',
      row: {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
    });
    expect(runner.calls.some((sql) => /^MERGE INTO/i.test(sql.trim()))).toBe(true);
    expect(
      runner.calls.some((sql) =>
        /ON t\.source_name = s\.source_name AND t\.filter_hash = s\.filter_hash AND COALESCE\(t\.snapshot_kind, 'canonical'\) = 'canonical' AND t\.snapshot_variant IS NULL/.test(
          sql
        )
      )
    ).toBe(true);
  });

  it('upsertMetadataRow scopes limited variants independently', async () => {
    const runner = fakeRunner();
    await upsertMetadataRow({
      runner,
      schema: 'analytics',
      row: {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 1,
        snapshot_kind: 'limited',
        snapshot_variant: 'limit=1',
      },
    });

    expect(
      runner.calls.some(
        (sql) =>
          /DELETE FROM/i.test(sql) &&
          /snapshot_kind = 'limited'/i.test(sql) &&
          /snapshot_variant = 'limit=1'/i.test(sql)
      )
    ).toBe(true);
  });

  it('rejects invalid snapshot kind and variant combinations before persisting', async () => {
    const runner = fakeRunner();

    await expect(
      upsertMetadataRow({
        runner,
        schema: 'analytics',
        row: {
          source_name: 'issues',
          filter_hash: 'limited-without-variant',
          loaded_at: '2026-04-22T12:00:00.000Z',
          record_count: 1,
          snapshot_kind: 'limited',
          snapshot_variant: null,
        },
      })
    ).rejects.toThrow(/snapshot_variant is required/);

    await expect(
      upsertMetadataRow({
        runner,
        schema: 'analytics',
        row: {
          source_name: 'issues',
          filter_hash: 'canonical-with-variant',
          loaded_at: '2026-04-22T12:00:00.000Z',
          record_count: 1,
          snapshot_kind: 'canonical',
          snapshot_variant: 'limit=1',
        },
      })
    ).rejects.toThrow(/snapshot_variant must be null/);
  });

  it('validates identifiers to prevent SQL injection', async () => {
    const runner = fakeRunner();
    await expect(
      ensureMetadataTable({ runner, schema: 'bad; DROP TABLE x', dialect: 'duckdb' })
    ).rejects.toThrow(/identifier/);
  });
});

describe('MetadataStore leases', () => {
  const leaseArgs = {
    schema: 'analytics',
    sourceName: 'issues',
    filterHash: 'abc',
    leaseSeconds: 60,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('DuckDBMetadataStore acquires leases with a transaction-backed metadata write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T16:00:00.000Z'));
    const runner = fakeRunner();
    const store = new DuckDBMetadataStore({ runner });

    await expect(store.beginRefresh(leaseArgs)).resolves.toEqual(
      expect.objectContaining({
        acquired: true,
        inProgressUntil: '2026-04-27T16:01:00.000Z',
      })
    );

    expect(runner.calls).toContain('BEGIN IMMEDIATE');
    expect(runner.calls).toContain('COMMIT');
    expect(runner.calls.some((sql) => /^INSERT INTO/i.test(sql.trim()))).toBe(true);
    expect(runner.calls.some((sql) => /in_progress_until/i.test(sql))).toBe(true);
  });

  it('DuckDBMetadataStore releases only the matching lease token in one transaction', async () => {
    const runner = fakeRunner([
      {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-27T15:00:00.000Z',
        record_count: 2,
        in_progress_until: '2026-04-27T16:01:00.000Z',
      },
    ]);
    const store = new DuckDBMetadataStore({ runner });

    await store.finishRefresh({
      schema: 'analytics',
      sourceName: 'issues',
      filterHash: 'abc',
      inProgressUntil: '2026-04-27T16:01:00.000Z',
    });

    const releaseSql = runner.calls.filter((sql) =>
      /DELETE FROM|UPDATE .*SET in_progress_until/i.test(sql)
    );
    expect(runner.calls).toContain('BEGIN IMMEDIATE');
    expect(runner.calls).toContain('COMMIT');
    expect(releaseSql).toHaveLength(2);
    for (const sql of releaseSql) {
      expect(sql).toContain("in_progress_until = TIMESTAMP '2026-04-27T16:01:00.000Z'");
    }
  });

  it('InMemoryMetadataStore reports a held lease until it expires', async () => {
    vi.useFakeTimers();
    const store = new InMemoryMetadataStore();

    vi.setSystemTime(new Date('2026-04-27T16:00:00.000Z'));
    const first = await store.beginRefresh(leaseArgs);
    vi.setSystemTime(new Date('2026-04-27T16:00:30.000Z'));
    const second = await store.beginRefresh(leaseArgs);
    vi.setSystemTime(new Date('2026-04-27T16:01:01.000Z'));
    const expired = await store.beginRefresh(leaseArgs);

    expect(first).toEqual(
      expect.objectContaining({
        acquired: true,
        inProgressUntil: '2026-04-27T16:01:00.000Z',
      })
    );
    expect(second).toEqual(
      expect.objectContaining({
        acquired: false,
        inProgressUntil: '2026-04-27T16:01:00.000Z',
      })
    );
    expect(expired).toEqual(
      expect.objectContaining({
        acquired: true,
        inProgressUntil: '2026-04-27T16:02:01.000Z',
      })
    );
  });

  it('InMemoryMetadataStore bases leases on wall-clock time, not query time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T16:00:00.000Z'));
    const store = new InMemoryMetadataStore();

    const result = await store.beginRefresh({
      ...leaseArgs,
      nowIso: '1999-01-01T00:00:00.000Z',
    } as Parameters<InMemoryMetadataStore['beginRefresh']>[0]);

    expect(result).toEqual(
      expect.objectContaining({
        acquired: true,
        inProgressUntil: '2026-04-27T16:01:00.000Z',
      })
    );
  });

  it('InMemoryMetadataStore finishRefresh writes metadata and releases the lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T16:00:00.000Z'));
    const store = new InMemoryMetadataStore();
    const lease = await store.beginRefresh(leaseArgs);

    await store.finishRefresh({
      schema: 'analytics',
      inProgressUntil: lease.inProgressUntil,
      row: {
        source_name: 'issues',
        filter_hash: 'abc',
        loaded_at: '2026-04-27T16:00:45.000Z',
        record_count: 3,
        snapshot_kind: 'canonical',
        snapshot_variant: null,
      },
    });

    await expect(
      store.read({
        schema: 'analytics',
        sourceName: 'issues',
        filterHash: 'abc',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        loaded_at: '2026-04-27T16:00:45.000Z',
        record_count: 3,
        in_progress_until: null,
      })
    );

    await expect(
      store.beginRefresh({
        ...leaseArgs,
      })
    ).resolves.toEqual(expect.objectContaining({ acquired: true }));
  });

  it('InMemoryMetadataStore deletes lease-only placeholders on failed refresh cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T16:00:00.000Z'));
    const store = new InMemoryMetadataStore();
    const lease = await store.beginRefresh(leaseArgs);

    await store.finishRefresh({
      schema: 'analytics',
      sourceName: 'issues',
      filterHash: 'abc',
      inProgressUntil: lease.inProgressUntil,
    });

    await expect(
      store.read({ schema: 'analytics', sourceName: 'issues', filterHash: 'abc' })
    ).resolves.toBeUndefined();
  });

  it('InMemoryMetadataStore can clear a lease without replacing metadata', async () => {
    const store = new InMemoryMetadataStore({
      rows: [
        {
          schema: 'analytics',
          row: {
            source_name: 'issues',
            filter_hash: 'abc',
            loaded_at: '2026-04-27T15:00:00.000Z',
            record_count: 2,
            in_progress_until: '2026-04-27T16:01:00.000Z',
          },
        },
      ],
    });

    await store.finishRefresh({
      schema: 'analytics',
      sourceName: 'issues',
      filterHash: 'abc',
      inProgressUntil: '2026-04-27T16:01:00.000Z',
    });

    await expect(
      store.read({ schema: 'analytics', sourceName: 'issues', filterHash: 'abc' })
    ).resolves.toEqual(
      expect.objectContaining({
        loaded_at: '2026-04-27T15:00:00.000Z',
        in_progress_until: null,
      })
    );
  });

  it('InMemoryMetadataStore does not release a lease when the token is stale', async () => {
    const store = new InMemoryMetadataStore({
      rows: [
        {
          schema: 'analytics',
          row: {
            source_name: 'issues',
            filter_hash: 'abc',
            loaded_at: '2026-04-27T15:00:00.000Z',
            record_count: 2,
            in_progress_until: '2026-04-27T16:02:00.000Z',
          },
        },
      ],
    });

    await store.finishRefresh({
      schema: 'analytics',
      sourceName: 'issues',
      filterHash: 'abc',
      inProgressUntil: '2026-04-27T16:01:00.000Z',
    });

    await expect(
      store.read({ schema: 'analytics', sourceName: 'issues', filterHash: 'abc' })
    ).resolves.toEqual(
      expect.objectContaining({
        in_progress_until: '2026-04-27T16:02:00.000Z',
      })
    );
  });
});
