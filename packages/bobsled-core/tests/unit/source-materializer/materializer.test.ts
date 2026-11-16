import { access, mkdtemp, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatReceipt,
  materializeSource,
} from '../../../src/runtime/source-materializer/materializer.js';
import type { MetadataRow } from '../../../src/runtime/source-materializer/metadata.js';
import { createQueryResourceHttpSpy } from '../../helpers/query-http-spy.js';

const fsMockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { Writable } = await vi.importActual<typeof import('node:stream')>('node:stream');
  return {
    ...actual,
    createWriteStream: vi.fn((path: string) => {
      const filePath = String(path);
      fsMockState.files.set(filePath, '');
      return new Writable({
        write(chunk, _encoding, callback) {
          const text =
            typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
          fsMockState.files.set(filePath, (fsMockState.files.get(filePath) ?? '') + text);
          callback();
        },
      });
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async (path: string) => {
    if (!fsMockState.files.has(String(path))) throw enoent(String(path));
  }),
  mkdir: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}mock`),
  readFile: vi.fn(async (path: string) => {
    const text = fsMockState.files.get(String(path));
    if (text === undefined) throw enoent(String(path));
    return text;
  }),
  unlink: vi.fn(async (path: string) => {
    if (!fsMockState.files.delete(String(path))) throw enoent(String(path));
  }),
}));

const entry = {
  kind: 'api_resource' as const,
  fqRef: 'sources.issues',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  filter: { state: 'open' },
  maxAge: '15m',
  columns: [
    { name: 'id', type: 'integer' as const },
    { name: 'title', type: 'string' as const },
    { name: 'state', type: 'string' as const },
  ],
};

function enoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function mockDestination() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureTable: vi.fn().mockResolvedValue(undefined),
    loadAndFinalize: vi.fn().mockResolvedValue({ rowsAffected: 3 }),
    close: vi.fn().mockResolvedValue(undefined),
    getTruncatedTables: vi.fn().mockReturnValue(new Set<string>()),
    setTruncatedTables: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function tempRoot(prefix = 'mat-'): Promise<string> {
  return mkdtemp(join('/tmp', prefix));
}

function createIncrementalHarness(
  queryResourceImpl: (args: Record<string, unknown>) => Promise<{
    records: Array<Record<string, unknown>>;
    limitReached: boolean;
    requestCount?: number;
  }>
) {
  let metadataRow: MetadataRow | undefined;
  let targetRowCount = 1;
  const calls: string[] = [];
  const querySpy = vi.fn(queryResourceImpl);
  const destination = mockDestination();
  destination.loadAndFinalize.mockImplementation(
    async (schemaName: string, _tableName: string, _path: string) => ({
      rowsAffected: schemaName === 'temp' ? 1 : targetRowCount,
    })
  );

  const runner = {
    run: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('MERGE INTO ') || sql.startsWith('MERGE ')) {
        targetRowCount += 1;
      }
    }),
    query: vi.fn(async () => [{ c: BigInt(targetRowCount) }]),
  };

  const readRow = vi.fn(async () => metadataRow);
  const upsertRow = vi.fn(async ({ row }: { row: MetadataRow }) => {
    metadataRow = row;
  });

  return {
    calls,
    destination,
    readRow,
    querySpy,
    upsertRow,
    metadataRow: () => metadataRow,
    args: async (nowIso: string) => ({
      entry: {
        ...entry,
        columns: [
          { name: 'id', type: 'integer' as const },
          { name: 'updated_at', type: 'timestamp' as const },
        ],
      },
      nowIso,
      tempRootDir: await tempRoot('mat-incremental-'),
      target: 'duckdb' as const,
      schema: 'sources',
      table: 'issues',
      destination,
      readRow,
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl: querySpy,
      integrationSpecLoader: () =>
        ({
          integration: {} as never,
          resource: {
            output: {
              id: { type: 'integer' },
              updated_at: { type: 'timestamp' },
            },
            extract: {
              table: {
                load_strategy: 'merge',
                primary_key: ['id'],
              },
              incremental: {
                strategy: 'filter',
                cursor_field: 'updated_at',
              },
            },
            query: {},
          } as never,
        }) as never,
      featureFlags: { incrementalRefresh: true },
      runner,
      dialect: 'duckdb' as const,
    }),
  };
}

function hasCursorFilter(request: Record<string, unknown>): boolean {
  const filter = request.filter;
  return (
    filter !== null &&
    typeof filter === 'object' &&
    Object.hasOwn(filter as Record<string, unknown>, 'updated_at')
  );
}

function createPartialHarness(
  queryResourceImpl: (args: Record<string, unknown>) => Promise<{
    records: Array<Record<string, unknown>>;
    limitReached: boolean;
    requestCount?: number;
  }>
) {
  const metadataRows = new Map<string, MetadataRow>();
  const querySpy = vi.fn(queryResourceImpl);
  const destination = mockDestination();
  destination.loadAndFinalize.mockImplementation(async (_schema, _table, path) => {
    const text = await readFile(path as string, 'utf8');
    const rows = text.trim() === '' ? 0 : text.trim().split('\n').length;
    return { rowsAffected: rows };
  });
  const readRow = vi.fn(async ({ snapshotVariant }: { snapshotVariant?: string | null }) =>
    metadataRows.get(snapshotVariant ?? 'canonical')
  );
  const upsertRow = vi.fn(async ({ row }: { row: MetadataRow }) => {
    metadataRows.set(row.snapshot_variant ?? 'canonical', row);
  });
  const runner = {
    run: vi.fn(async (sql: string) => {
      if (/UPDATE .*_dogsled_source_metadata/i.test(sql)) {
        for (const [key, row] of metadataRows.entries()) {
          if (key === 'canonical') continue;
          metadataRows.set(key, {
            ...row,
            loaded_at: '1970-01-01T00:00:00.000Z',
          });
        }
      }
    }),
    query: vi.fn(async () => [{ c: BigInt(1) }]),
  };

  return {
    destination,
    querySpy,
    readRow,
    upsertRow,
    runner,
    metadataRows,
    partialArgs: async (nowIso: string) => ({
      entry,
      nowIso,
      tempRootDir: await tempRoot('mat-partial-'),
      target: 'duckdb' as const,
      schema: 'sources',
      table: 'issues__limit_5',
      canonicalTable: 'issues',
      destination,
      readRow,
      tableExists: vi.fn().mockResolvedValue(true),
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl: querySpy,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      featureFlags: { partialMaterialization: true },
      queryLimit: 5,
      runner,
      dialect: 'duckdb' as const,
    }),
    canonicalArgs: async (nowIso: string) => ({
      entry,
      nowIso,
      tempRootDir: await tempRoot('mat-partial-canonical-'),
      target: 'duckdb' as const,
      schema: 'sources',
      table: 'issues',
      destination,
      readRow,
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl: querySpy,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      runner,
      dialect: 'duckdb' as const,
    }),
  };
}

describe('materializeSource', () => {
  beforeEach(() => {
    fsMockState.files.clear();
    vi.clearAllMocks();
  });

  it('reuses when fresh without extracting or loading', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const readRow = vi.fn().mockResolvedValue({
      source_name: 'issues',
      filter_hash: 'CURRENTHASH',
      loaded_at: '2026-04-22T12:05:00.000Z',
      record_count: 1242,
    });
    const upsertRow = vi.fn();
    const queryResourceImpl = vi.fn();

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'bigquery',
      schema: 'analytics',
      table: 'issues',
      destination,
      readRow,
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(receipt.action).toBe('reused');
    expect(receipt.records).toBe(1242);
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
    expect(upsertRow).not.toHaveBeenCalled();
  });

  it('keeps matching lazy slices indefinitely when maxAge is omitted', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const queryResourceImpl = vi.fn();

    const receipt = await materializeSource({
      entry: { ...entry, maxAge: undefined },
      nowIso: '2030-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 1242,
      }),
      upsertRow: vi.fn(),
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(receipt.action).toBe('reused');
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('reuses extract-mode data without query-time refresh', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const queryResourceImpl = vi.fn();

    const receipt = await materializeSource({
      entry: { ...entry, mode: 'extract' },
      nowIso: '2030-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 1242,
      }),
      tableExists: vi.fn().mockResolvedValue(true),
      upsertRow: vi.fn(),
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(receipt.action).toBe('reused');
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('reuses extract-mode physical tables when query metadata is absent', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const queryResourceImpl = vi.fn();
    const tableExists = vi.fn().mockResolvedValue(true);
    const runner = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([{ c: BigInt(1242) }]),
    };

    const receipt = await materializeSource({
      entry: { ...entry, mode: 'extract' },
      nowIso: '2030-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue(undefined),
      tableExists,
      upsertRow: vi.fn(),
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      runner,
      dialect: 'duckdb',
    });

    expect(receipt.action).toBe('reused');
    expect(receipt.records).toBe(1242);
    expect(tableExists).toHaveBeenCalledWith({ schema: 'sources', table: 'issues' });
    expect(runner.query).toHaveBeenCalledWith('SELECT COUNT(*) AS c FROM "sources"."issues"');
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('throws for extract-mode sources that have not been extracted', async () => {
    await expect(
      materializeSource({
        entry: { ...entry, mode: 'extract' },
        nowIso: '2026-04-22T12:10:00.000Z',
        tempRootDir: await tempRoot(),
        target: 'duckdb',
        schema: 'sources',
        table: 'issues',
        destination: mockDestination(),
        readRow: vi.fn().mockResolvedValue(undefined),
        upsertRow: vi.fn(),
        currentFilterHash: 'CURRENTHASH',
        queryResourceImpl: vi.fn(),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow(/mode: extract.*run dogsled pipeline/);
  });

  it('re-materializes fresh metadata when the physical table is missing', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const upsertRow = vi.fn();
    const tableExists = vi.fn().mockResolvedValue(false);
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, title: 'a', state: 'open' }],
      limitReached: false,
    });

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'bigquery',
      schema: 'analytics',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 1242,
      }),
      tableExists,
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(tableExists).toHaveBeenCalledWith({ schema: 'analytics', table: 'issues' });
    expect(queryResourceImpl).toHaveBeenCalled();
    expect(destination.loadAndFinalize).toHaveBeenCalled();
    expect(receipt.action).toBe('materialized');
    expect(receipt.records).toBe(3);
    expect(upsertRow).toHaveBeenCalledWith({
      schema: 'analytics',
      row: expect.objectContaining({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        record_count: 3,
      }),
    });
  });

  it('surfaces table probe errors instead of rematerializing', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const error = new Error('permission denied for table sources.issues');
    const queryResourceImpl = vi.fn();

    await expect(
      materializeSource({
        entry,
        nowIso: '2026-04-22T12:10:00.000Z',
        tempRootDir,
        target: 'bigquery',
        schema: 'analytics',
        table: 'issues',
        destination,
        readRow: vi.fn().mockResolvedValue({
          source_name: 'issues',
          filter_hash: 'CURRENTHASH',
          loaded_at: '2026-04-22T12:05:00.000Z',
          record_count: 1242,
        }),
        tableExists: vi.fn().mockRejectedValue(error),
        upsertRow: vi.fn(),
        currentFilterHash: 'CURRENTHASH',
        queryResourceImpl,
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow(/permission denied/);

    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('coalesces concurrent fresh misses with the same source and filter hash', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const upsertRow = vi.fn();
    const fetch = deferred<{ records: Array<Record<string, unknown>>; limitReached: boolean }>();
    const queryResourceImpl = vi.fn().mockReturnValue(fetch.promise);
    const args = {
      entry,
      nowIso: '2026-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'duckdb' as const,
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue(undefined),
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      featureFlags: { inFlightDedup: true },
    };

    const first = materializeSource(args);
    const second = materializeSource(args);
    await vi.waitFor(() => expect(queryResourceImpl).toHaveBeenCalledTimes(1));
    fetch.resolve({
      records: [{ id: 1, title: 'a', state: 'open' }],
      limitReached: false,
    });

    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

    expect(firstReceipt.action).toBe('materialized');
    expect(secondReceipt.action).toBe('coalesced');
    expect(secondReceipt.records).toBe(firstReceipt.records);
    expect(destination.loadAndFinalize).toHaveBeenCalledTimes(1);
    expect(upsertRow).toHaveBeenCalledTimes(1);
  });

  it('waits on an external refresh lease instead of issuing a duplicate API call', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const queryResourceImpl = vi.fn();
    const freshRow = {
      source_name: 'issues',
      filter_hash: 'CURRENTHASH',
      loaded_at: '2026-04-22T12:10:00.000Z',
      record_count: 7,
      in_progress_until: null,
    };
    const readRow = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(freshRow)
      .mockResolvedValue(freshRow);

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T12:10:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow,
      tableExists: vi.fn().mockResolvedValue(true),
      upsertRow: vi.fn(),
      beginRefresh: vi.fn().mockResolvedValue({
        acquired: false,
        inProgressUntil: new Date(Date.now() + 500).toISOString(),
      }),
      finishRefresh: vi.fn(),
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(receipt.action).toBe('reused');
    expect(receipt.records).toBe(7);
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('uses conditional ETags on aged-out lazy slices and reuses rows on 304', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const upsertRow = vi.fn();
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [],
      limitReached: false,
      requestCount: 1,
      etag: '"slice-1"',
      notModified: true,
      rateLimit: { limit: 100, remaining: 99 },
    });

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T13:30:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        etag: '"slice-1"',
      }),
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        etag: '"slice-1"',
      })
    );
    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      action: 'reused',
      refreshReason: 'refresh_due',
      records: 42,
      etagHit: true,
      rateBudgetLimit: 100,
      rateBudgetRemaining: 99,
    });
    expect(upsertRow).toHaveBeenCalledWith({
      schema: 'sources',
      row: expect.objectContaining({
        record_count: 42,
        etag: '"slice-1"',
        loaded_at: '2026-04-22T13:30:00.000Z',
      }),
    });
  });

  it('rematerializes 304 slices when the physical table is missing', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const upsertRow = vi.fn();
    const queryResourceImpl = vi
      .fn()
      .mockResolvedValueOnce({
        records: [],
        limitReached: false,
        requestCount: 1,
        etag: '"slice-1"',
        notModified: true,
      })
      .mockResolvedValueOnce({
        records: [{ id: 1, title: 'a', state: 'open' }],
        limitReached: false,
        requestCount: 1,
        etag: '"slice-2"',
      });

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T13:30:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'CURRENTHASH',
        loaded_at: '2026-04-22T12:00:00.000Z',
        record_count: 42,
        etag: '"slice-1"',
      }),
      tableExists: vi.fn().mockResolvedValue(false),
      upsertRow,
      currentFilterHash: 'CURRENTHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(queryResourceImpl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ etag: '"slice-1"' })
    );
    expect(queryResourceImpl).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ etag: expect.anything() })
    );
    expect(destination.loadAndFinalize).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      action: 'materialized',
      refreshReason: 'refresh_due',
      etagHit: false,
    });
    expect(upsertRow).toHaveBeenCalledWith({
      schema: 'sources',
      row: expect.objectContaining({
        record_count: 3,
        etag: '"slice-2"',
      }),
    });
  });

  it('surfaces a clear error when the upstream provider rate-limits the request', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();

    await expect(
      materializeSource({
        entry,
        nowIso: '2026-04-22T12:00:00.000Z',
        tempRootDir,
        target: 'duckdb',
        schema: 'sources',
        table: 'issues',
        destination,
        readRow: vi.fn().mockResolvedValue(undefined),
        upsertRow: vi.fn(),
        currentFilterHash: 'h',
        queryResourceImpl: vi.fn().mockRejectedValue(new Error('HTTP 429: Too Many Requests')),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow(/Upstream provider rate-limited/);

    expect(destination.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('re-materializes when slice identity changes', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    const upsertRow = vi.fn();
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [
        { id: 1, title: 'a', state: 'open' },
        { id: 2, title: 'b', state: 'open' },
      ],
      limitReached: false,
    });

    const receipt = await materializeSource({
      entry,
      nowIso: '2026-04-22T12:06:00.000Z',
      tempRootDir,
      target: 'bigquery',
      schema: 'analytics',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue({
        source_name: 'issues',
        filter_hash: 'OLDHASH',
        loaded_at: '2026-04-22T12:05:00.000Z',
        record_count: 10,
      }),
      upsertRow,
      currentFilterHash: 'NEWHASH',
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(receipt.action).toBe('materialized');
    expect(destination.loadAndFinalize).toHaveBeenCalled();
    expect(upsertRow).toHaveBeenCalledWith({
      schema: 'analytics',
      row: expect.objectContaining({
        source_name: 'issues',
        filter_hash: 'NEWHASH',
        record_count: 3,
      }),
    });
  });

  it('can materialize through the HTTP spy harness and real queryResource', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    destination.loadAndFinalize.mockResolvedValue({ rowsAffected: 2 });
    const spy = createQueryResourceHttpSpy({
      pages: [
        {
          records: [{ id: 1, title: 'a', state: 'open' }],
          nextCursor: 'next-page',
        },
        {
          records: [{ id: 2, title: 'b', state: 'open' }],
          nextCursor: null,
        },
      ],
    });

    try {
      const receipt = await materializeSource({
        entry,
        nowIso: '2026-04-22T12:06:00.000Z',
        tempRootDir,
        target: 'duckdb',
        schema: 'sources',
        table: 'issues',
        destination,
        readRow: vi.fn().mockResolvedValue(undefined),
        upsertRow: vi.fn(),
        currentFilterHash: 'h',
        queryResourceImpl: spy.queryResourceImpl,
        integrationSpecLoader: spy.integrationSpecLoader,
      });

      expect(receipt.action).toBe('materialized');
      expect(receipt.records).toBe(2);
      expect(spy.providerCallCount).toBe(1);
      expect(spy.requestCount).toBe(2);
      expect(spy.requests[0]?.url.searchParams.get('state')).toBe('open');
      expect(spy.requests[1]?.url.searchParams.get('cursor')).toBe('next-page');
    } finally {
      spy.restore();
    }
  });

  it('coalesces concurrent HTTP spy materializations for the same fresh miss', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    destination.loadAndFinalize.mockResolvedValue({ rowsAffected: 1 });
    const spy = createQueryResourceHttpSpy({
      gateResponses: true,
      pages: [
        {
          records: [{ id: 1, title: 'a', state: 'open' }],
          nextCursor: null,
        },
      ],
    });
    const args = {
      entry,
      nowIso: '2026-04-22T12:06:00.000Z',
      tempRootDir,
      target: 'duckdb' as const,
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue(undefined),
      upsertRow: vi.fn(),
      currentFilterHash: 'h',
      queryResourceImpl: spy.queryResourceImpl,
      integrationSpecLoader: spy.integrationSpecLoader,
      featureFlags: { inFlightDedup: true },
    };

    try {
      const first = materializeSource(args);
      await spy.waitForRequestCount(1);
      const second = materializeSource(args);

      await Promise.resolve();
      expect(spy.providerCallCount).toBe(1);
      expect(spy.requestCount).toBe(1);

      spy.releaseAllResponses();
      const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
      expect(firstReceipt.action).toBe('materialized');
      expect(secondReceipt.action).toBe('coalesced');
    } finally {
      spy.releaseAllResponses();
      spy.restore();
    }
  });

  it('passes id as keyProperties when present', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    await materializeSource({
      entry,
      nowIso: '2026-04-22T12:00:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue(undefined),
      upsertRow: vi.fn(),
      currentFilterHash: 'h',
      queryResourceImpl: vi.fn().mockResolvedValue({ records: [{ id: 1 }], limitReached: false }),
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });
    expect(destination.ensureTable).toHaveBeenCalledWith(
      'sources',
      'issues',
      expect.any(Array),
      expect.objectContaining({ keyProperties: ['id'] })
    );
  });

  it('uses the incremental path when stale metadata includes cursor state', async () => {
    const harness = createIncrementalHarness(async (request) =>
      hasCursorFilter(request)
        ? {
            records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );

    const first = await materializeSource(await harness.args('2026-04-22T00:30:00Z'));
    const second = await materializeSource(await harness.args('2026-04-23T11:00:00Z'));

    expect(first.refreshReason).toBe('first_load');
    expect(harness.metadataRow()).toEqual(
      expect.objectContaining({
        cursor_field: 'updated_at',
        cursor_value: '2026-04-23T10:00:00Z',
      })
    );
    expect(second.refreshReason).toBe('incremental_merge');
    expect(second.cursorValue).toBe('2026-04-23T10:00:00Z');
    expect(second.deltaRowCount).toBe(1);
    expect(second.totalRowCount).toBe(2);
    expect(harness.querySpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filter: {
          state: 'open',
          updated_at: { $gte: '2026-04-22T00:00:00Z' },
        },
      })
    );
  });

  it('preserves existing filter operators when incremental refresh injects a cursor filter', async () => {
    const harness = createIncrementalHarness(async (request) =>
      request.filter !== null &&
      typeof request.filter === 'object' &&
      typeof (request.filter as Record<string, unknown>)['updated_at'] === 'object' &&
      (request.filter as { updated_at?: Record<string, unknown> }).updated_at !== null &&
      Object.hasOwn(
        (request.filter as { updated_at?: Record<string, unknown> }).updated_at ?? {},
        '$gte'
      )
        ? {
            records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );

    const firstArgs = await harness.args('2026-04-22T00:30:00Z');
    firstArgs.entry = {
      ...firstArgs.entry,
      filter: {
        state: 'open',
        updated_at: { lte: '2026-04-23T23:59:59Z' },
      },
    };
    await materializeSource(firstArgs);

    const secondArgs = await harness.args('2026-04-23T11:00:00Z');
    secondArgs.entry = {
      ...secondArgs.entry,
      filter: {
        state: 'open',
        updated_at: { lte: '2026-04-23T23:59:59Z' },
      },
    };
    await materializeSource(secondArgs);

    expect(harness.querySpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filter: {
          state: 'open',
          updated_at: {
            $gte: '2026-04-22T00:00:00Z',
            $lte: '2026-04-23T23:59:59Z',
          },
        },
      })
    );
  });

  it('falls back to full refresh on cursor regression', async () => {
    const harness = createIncrementalHarness(async (request) =>
      hasCursorFilter(request)
        ? {
            records: [{ id: 2, updated_at: '1999-01-01T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );

    await materializeSource(await harness.args('2026-04-22T00:30:00Z'));
    const second = await materializeSource(await harness.args('2026-04-23T11:00:00Z'));

    expect(second.refreshReason).toBe('incremental_fallback_cursor_regression');
    expect(second.snapshotKind).toBe('canonical');
  });

  it('stages incremental deltas through a scratch table before merge', async () => {
    const harness = createIncrementalHarness(async (request) =>
      hasCursorFilter(request)
        ? {
            records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );

    await materializeSource(await harness.args('2026-04-22T00:30:00Z'));
    await materializeSource(await harness.args('2026-04-23T11:00:00Z'));

    const createScratch = harness.calls.findIndex((sql) =>
      /CREATE TEMP TABLE temp\.main\."issues_scratch_/.test(sql)
    );
    const mergeIndex = harness.calls.findIndex((sql) => /MERGE INTO/.test(sql));
    const dropScratch = harness.calls.findIndex((sql) =>
      /DROP TABLE IF EXISTS temp\.main\."issues_scratch_/.test(sql)
    );

    expect(createScratch).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(createScratch);
    expect(dropScratch).toBeGreaterThan(mergeIndex);
  });

  it('appends incremental deltas without a MERGE when refresh strategy is append', async () => {
    const harness = createIncrementalHarness(async (request) =>
      hasCursorFilter(request)
        ? {
            records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );

    const firstArgs = await harness.args('2026-04-22T00:30:00Z');
    firstArgs.entry = {
      ...firstArgs.entry,
      refresh: { strategy: 'append', cursor_field: 'updated_at' },
    };
    await materializeSource(firstArgs);

    const secondArgs = await harness.args('2026-04-23T11:00:00Z');
    secondArgs.entry = {
      ...secondArgs.entry,
      refresh: { strategy: 'append', cursor_field: 'updated_at' },
    };
    const second = await materializeSource(secondArgs);

    expect(second.refreshReason).toBe('incremental_append');
    expect(harness.calls.some((sql) => /MERGE INTO|MERGE /.test(sql))).toBe(false);
    expect(harness.destination.loadAndFinalize).toHaveBeenLastCalledWith(
      'sources',
      'issues',
      expect.any(String),
      expect.any(Array),
      'append',
      []
    );
  });

  it('honors resource table load_strategy append for incremental refresh', async () => {
    const harness = createIncrementalHarness(async (request) =>
      hasCursorFilter(request)
        ? {
            records: [{ id: 2, updated_at: '2026-04-23T10:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
        : {
            records: [{ id: 1, updated_at: '2026-04-22T00:00:00Z' }],
            limitReached: false,
            requestCount: 1,
          }
    );
    const appendSpecLoader = () =>
      ({
        integration: {} as never,
        resource: {
          output: {
            id: { type: 'integer' },
            updated_at: { type: 'timestamp' },
          },
          extract: {
            table: {
              load_strategy: 'append',
              primary_key: ['id'],
            },
            incremental: {
              strategy: 'filter',
              cursor_field: 'updated_at',
            },
          },
          query: {},
        } as never,
      }) as never;

    const firstArgs = await harness.args('2026-04-22T00:30:00Z');
    firstArgs.integrationSpecLoader = appendSpecLoader;
    await materializeSource(firstArgs);

    const secondArgs = await harness.args('2026-04-23T11:00:00Z');
    secondArgs.integrationSpecLoader = appendSpecLoader;
    const second = await materializeSource(secondArgs);

    expect(second.refreshReason).toBe('incremental_append');
    expect(harness.calls.some((sql) => /MERGE INTO|MERGE /.test(sql))).toBe(false);
    expect(harness.destination.loadAndFinalize).toHaveBeenLastCalledWith(
      'sources',
      'issues',
      expect.any(String),
      expect.any(Array),
      'append',
      []
    );
  });

  it('uses the partial path when queryLimit is set and the flag is on', async () => {
    const harness = createPartialHarness(async (request) => ({
      records: Array.from({ length: request.limit as number }, (_, index) => ({ id: index + 1 })),
      limitReached: true,
      requestCount: 1,
    }));

    const receipt = await materializeSource(await harness.partialArgs('2026-04-22T12:00:00.000Z'));

    expect(receipt).toMatchObject({
      snapshotKind: 'limited',
      snapshotVariant: 'limit=5',
      records: 5,
      refreshReason: 'partial_rebuild',
    });
    expect(harness.querySpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('reuses a partial snapshot within its TTL', async () => {
    const harness = createPartialHarness(async () => ({
      records: [{ id: 1 }],
      limitReached: true,
      requestCount: 1,
    }));

    await materializeSource(await harness.partialArgs('2026-04-22T12:00:00.000Z'));
    const second = await materializeSource(await harness.partialArgs('2026-04-22T12:05:00.000Z'));

    expect(harness.querySpy).toHaveBeenCalledTimes(1);
    expect(second.refreshReason).toBe('partial_reuse');
    expect(second.snapshotVariant).toBe('limit=5');
  });

  it('forces partial variants to rebuild after a canonical refresh', async () => {
    const harness = createPartialHarness(async () => ({
      records: [{ id: 1 }],
      limitReached: true,
      requestCount: 1,
    }));

    await materializeSource(await harness.partialArgs('2026-04-22T12:00:00.000Z'));
    await materializeSource(await harness.canonicalArgs('2026-04-22T12:10:00.000Z'));
    const rebuilt = await materializeSource(await harness.partialArgs('2026-04-22T12:11:00.000Z'));

    expect(rebuilt.refreshReason).toBe('partial_rebuild');
    expect(harness.querySpy).toHaveBeenCalledTimes(3);
    expect(harness.runner.run).toHaveBeenCalledWith(
      expect.stringMatching(/snapshot_kind = 'limited'/)
    );
  });

  it('does not re-enrich _time_extracted in staged JSONL', async () => {
    const tempRootDir = await tempRoot();
    const destination = mockDestination();
    let capturedContent = '';
    destination.loadAndFinalize.mockImplementation(async (_schema, _table, path) => {
      capturedContent = await readFile(path as string, 'utf8');
      return { rowsAffected: 1 };
    });

    await materializeSource({
      entry,
      nowIso: '2026-04-22T12:00:00.000Z',
      tempRootDir,
      target: 'duckdb',
      schema: 'sources',
      table: 'issues',
      destination,
      readRow: vi.fn().mockResolvedValue(undefined),
      upsertRow: vi.fn(),
      currentFilterHash: 'h',
      queryResourceImpl: vi.fn().mockResolvedValue({ records: [{ id: 1 }], limitReached: false }),
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(capturedContent).toBe(JSON.stringify({ id: 1 }) + '\n');
    expect(capturedContent).not.toContain('_time_extracted');
  });

  it('unlinks the staged JSONL even when loadAndFinalize throws', async () => {
    const tempRootDir = await tempRoot('mat-cleanup-');
    const pinnedNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(pinnedNow);
    try {
      const destination = mockDestination();
      const sawFile = vi.fn();
      destination.loadAndFinalize.mockImplementation(async (_schema, _table, path) => {
        await access(path as string);
        sawFile(path as string);
        throw new Error('boom');
      });

      await expect(
        materializeSource({
          entry,
          nowIso: '2026-04-22T12:00:00.000Z',
          tempRootDir,
          target: 'duckdb',
          schema: 'sources',
          table: 'issues',
          destination,
          readRow: vi.fn().mockResolvedValue(undefined),
          upsertRow: vi.fn(),
          currentFilterHash: 'h',
          queryResourceImpl: vi
            .fn()
            .mockResolvedValue({ records: [{ id: 1 }], limitReached: false }),
          integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
        })
      ).rejects.toThrow(/boom/);

      const stagedPath = join(tempRootDir, `sources.issues.${pinnedNow}.jsonl`);
      expect(sawFile).toHaveBeenCalledWith(stagedPath);
      await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('surfaces staged JSONL cleanup errors other than missing files', async () => {
    const tempRootDir = await tempRoot('mat-cleanup-');
    const cleanupError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    cleanupError.code = 'EACCES';
    vi.mocked(unlink).mockRejectedValueOnce(cleanupError);

    await expect(
      materializeSource({
        entry,
        nowIso: '2026-04-22T12:00:00.000Z',
        tempRootDir,
        target: 'duckdb',
        schema: 'sources',
        table: 'issues',
        destination: mockDestination(),
        readRow: vi.fn().mockResolvedValue(undefined),
        upsertRow: vi.fn(),
        currentFilterHash: 'h',
        queryResourceImpl: vi.fn().mockResolvedValue({ records: [{ id: 1 }], limitReached: false }),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow(/permission denied/);
  });
});

describe('materializeSource live primary-key dedup', () => {
  beforeEach(() => {
    fsMockState.files.clear();
  });

  const liveEntry = {
    ...entry,
    mode: 'live' as const,
    columns: [
      { name: 'id', type: 'string' as const },
      { name: 'identifier', type: 'string' as const },
      { name: 'updated_at', type: 'timestamp' as const },
    ],
  };

  const liveSpecLoader = () =>
    ({
      integration: {} as never,
      resource: {
        output: {
          id: { type: 'string' },
          identifier: { type: 'string' },
          updated_at: { type: 'timestamp' },
        },
        extract: { table: { primary_key: ['id'] } },
        query: {},
      } as never,
    }) as never;

  async function liveArgs(records: Array<Record<string, unknown>>) {
    const destination = mockDestination();
    const written: Array<Record<string, unknown>> = [];
    destination.loadAndFinalize.mockImplementation(async (_schema, _table, path) => {
      const text = await readFile(path as string, 'utf8');
      const rows = text
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      written.push(...rows);
      return { rowsAffected: rows.length };
    });

    return {
      written,
      destination,
      args: {
        entry: liveEntry,
        nowIso: '2026-06-10T12:00:00.000Z',
        tempRootDir: await tempRoot('mat-live-'),
        target: 'duckdb' as const,
        schema: 'temp',
        table: '__dogsled_live_issues_0',
        destination,
        readRow: vi.fn().mockResolvedValue(undefined),
        tableExists: vi.fn().mockResolvedValue(false),
        upsertRow: vi.fn(),
        currentFilterHash: 'CURRENTHASH',
        queryResourceImpl: vi.fn().mockResolvedValue({ records, limitReached: false }),
        integrationSpecLoader: liveSpecLoader,
      },
    };
  }

  it('collapses duplicate primary keys re-served by paginated fetch', async () => {
    const { written, destination, args } = await liveArgs([
      { id: 'a', identifier: 'ENG-1', updated_at: '2026-06-10T10:00:00.000Z' },
      { id: 'b', identifier: 'ENG-2', updated_at: '2026-06-10T09:00:00.000Z' },
      { id: 'a', identifier: 'ENG-1', updated_at: '2026-06-10T11:30:00.000Z' },
      { id: 'a', identifier: 'ENG-1', updated_at: '2026-06-10T11:45:00.000Z' },
      { id: 'b', identifier: 'ENG-2', updated_at: '2026-06-10T11:50:00.000Z' },
    ]);

    const receipt = await materializeSource(args);

    const ids = written.map((row) => row['id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['a', 'b']);
    // Last occurrence wins: the most-recently re-served copy is retained.
    expect(written.find((row) => row['id'] === 'a')?.['updated_at']).toBe(
      '2026-06-10T11:45:00.000Z'
    );
    expect(destination.loadAndFinalize).toHaveBeenCalledWith(
      'temp',
      '__dogsled_live_issues_0',
      expect.any(String),
      expect.any(Array),
      'full_refresh',
      ['id']
    );
    expect(receipt.records).toBe(2);
  });

  it('passes through records that are missing the primary key', async () => {
    const { written, args } = await liveArgs([
      { id: 'a', identifier: 'AI-1', updated_at: '2026-06-10T10:00:00.000Z' },
      { id: null, identifier: 'AI-2', updated_at: '2026-06-10T09:00:00.000Z' },
      { id: 'a', identifier: 'AI-1', updated_at: '2026-06-10T11:00:00.000Z' },
    ]);

    await materializeSource(args);

    // One row for key `a`, plus the unkeyed row passed through untouched.
    expect(written).toHaveLength(2);
    expect(written.filter((row) => row['id'] === 'a')).toHaveLength(1);
    expect(written.filter((row) => row['id'] === null)).toHaveLength(1);
  });
});

describe('formatReceipt', () => {
  it('includes Day-0 optional observability fields when present', () => {
    const line = formatReceipt({
      source: 'issues',
      target: 'duckdb',
      table: 'sources.issues',
      filterHash: 'abc',
      snapshotAgeSeconds: 0,
      records: 3,
      action: 'coalesced',
      durationMs: 12,
      refreshReason: 'refresh_due',
      rateBudgetRemaining: 42,
      rateBudgetLimit: 100,
      etagHit: true,
    });

    expect(line).toContain('action=coalesced');
    expect(line).toContain('refresh_reason=refresh_due');
    expect(line).toContain('rate_budget_remaining=42');
    expect(line).toContain('rate_budget_limit=100');
    expect(line).toContain('etag_hit=true');
  });
});
