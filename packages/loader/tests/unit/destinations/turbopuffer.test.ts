import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchemaColumn } from '@bobsled-inc/protocol';
import {
  TurbopufferDestination,
  TurbopufferModuleLoadError,
  turbopufferRuntime,
} from '../../../src/runtime/destinations/turbopuffer.js';
import type {
  TurbopufferDestinationOptions,
  TurbopufferNamespaceLike,
  TurbopufferClientLike,
} from '../../../src/runtime/destinations/turbopuffer.js';

vi.mock('node:fs', () => ({ createReadStream: vi.fn() }));

function createMockNamespace(
  overrides: Partial<TurbopufferNamespaceLike> = {}
): TurbopufferNamespaceLike & {
  write: ReturnType<typeof vi.fn>;
  schema: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  deleteAll: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn().mockResolvedValue({ rows_affected: 2 }),
    schema: vi.fn().mockResolvedValue({}),
    exists: vi.fn().mockResolvedValue(false),
    deleteAll: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function createMockClient(ns = createMockNamespace()): TurbopufferClientLike & {
  namespace: ReturnType<typeof vi.fn>;
  namespaces: ReturnType<typeof vi.fn>;
} {
  return {
    namespace: vi.fn(() => ns),
    namespaces: vi.fn().mockResolvedValue({ namespaces: [] }),
  };
}

const columns: SchemaColumn[] = [
  { name: 'id', type: 'string', primary_key: true },
  { name: 'body', type: 'string' },
  { name: 'tags', type: 'array' },
  {
    name: 'body_embedding',
    type: 'vector',
    dimension: 3,
    embedded_from: {
      column: 'body',
      provider: 'openai',
      model: 'text-embedding-3-small',
      distance_metric: 'cosine',
    },
  },
];

async function createDest(
  client: TurbopufferClientLike,
  options: Omit<TurbopufferDestinationOptions, 'apiKey' | 'clientFactory'> = {}
): Promise<{ dest: TurbopufferDestination; namespace: ReturnType<typeof createMockNamespace> }> {
  const namespace = client.namespace('issues') as ReturnType<typeof createMockNamespace>;
  const dest = new TurbopufferDestination({
    apiKey: 'k',
    clientFactory: async () => client,
    ...options,
  });
  await dest.initialize();
  return { dest, namespace };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  const content = records.map((row) => JSON.stringify(row)).join('\n');
  vi.mocked(fs.createReadStream).mockImplementation(
    () => Readable.from([content]) as ReturnType<typeof fs.createReadStream>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TurbopufferDestination', () => {
  it('initializes by listing namespaces', async () => {
    const client = createMockClient();
    await createDest(client);

    expect(client.namespaces).toHaveBeenCalledWith({ page_size: 1 });
  });

  it('wraps connection failures with the region', async () => {
    const client = createMockClient();
    client.namespaces.mockRejectedValue(new Error('network down'));
    const dest = new TurbopufferDestination({
      apiKey: 'k',
      clientFactory: async () => client,
    });

    await expect(dest.initialize()).rejects.toThrow(
      /Failed to connect to Turbopuffer in region gcp-us-central1/
    );
  });

  it('surfaces the SDK installation message', async () => {
    vi.spyOn(turbopufferRuntime, 'loadModule').mockRejectedValue(
      new TurbopufferModuleLoadError('install @turbopuffer/turbopuffer', 1)
    );
    const dest = new TurbopufferDestination({ apiKey: 'k' });

    await expect(dest.initialize()).rejects.toThrow(/install @turbopuffer\/turbopuffer/);
  });

  it('does not fetch a schema for a missing namespace', async () => {
    const namespace = createMockNamespace();
    const client = createMockClient(namespace);
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'issues', columns);

    expect(namespace.exists).toHaveBeenCalled();
    expect(namespace.schema).not.toHaveBeenCalled();
  });

  it('rejects incompatible existing attribute types', async () => {
    const namespace = createMockNamespace({
      exists: vi.fn().mockResolvedValue(true),
      schema: vi.fn().mockResolvedValue({ body: { type: 'int' } }),
    });
    const { dest } = await createDest(createMockClient(namespace));

    await expect(dest.ensureTable('default', 'issues', columns)).rejects.toThrow(
      /Schema change conflict/
    );
  });

  it('rejects vector dimension changes', async () => {
    const namespace = createMockNamespace({
      exists: vi.fn().mockResolvedValue(true),
      schema: vi.fn().mockResolvedValue({ body_embedding: { type: '[4]f32' } }),
    });
    const { dest } = await createDest(createMockClient(namespace));

    await expect(dest.ensureTable('default', 'issues', columns)).rejects.toThrow(
      /Schema change conflict/
    );
  });

  it('enforces strict schema behavior for new attributes', async () => {
    const namespace = createMockNamespace({
      exists: vi.fn().mockResolvedValue(true),
      schema: vi.fn().mockResolvedValue({ body: { type: 'string' } }),
    });
    const { dest } = await createDest(createMockClient(namespace));

    await expect(
      dest.ensureTable('default', 'issues', columns, { schemaBehavior: 'strict' })
    ).rejects.toThrow(/strict/);
  });

  it('writes typed attributes, vectors, system columns, and the distance metric', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([
      {
        id: 'doc-1',
        body: 'hello',
        tags: ['a'],
        body_embedding: [1, 2, 3],
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns,
      'append',
      []
    );

    expect(result.rowsAffected).toBe(2);
    expect(namespace.write).toHaveBeenCalledWith(
      expect.objectContaining({
        distance_metric: 'cosine_distance',
        schema: expect.objectContaining({
          body: { type: 'string' },
          tags: { type: 'string', filterable: false },
          body_embedding: { type: '[3]f32', ann: true },
          _time_extracted: { type: 'datetime' },
          _bobsled_loaded_at: { type: 'datetime' },
        }),
      })
    );
    const row = namespace.write.mock.calls[0]?.[0].upsert_rows[0];
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses keyed ids and keeps the newest duplicate in a merge batch', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([
      { id: 'key-1', body: 'old', _time_extracted: '2026-01-01T00:00:00Z' },
      { id: 'key-1', body: 'new', _time_extracted: '2026-01-02T00:00:00Z' },
    ]);

    const result = await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'merge',
      ['id']
    );

    expect(result.rowsAffected).toBe(2);
    expect(namespace.write).toHaveBeenCalledTimes(1);
    expect(namespace.write.mock.calls[0]?.[0].upsert_rows).toHaveLength(1);
    expect(namespace.write.mock.calls[0]?.[0].upsert_rows[0]).toMatchObject({
      id: 'key-1',
      body: 'new',
    });
  });

  it('hashes composite keys and uses UUIDs for null keys', async () => {
    const namespace = createMockNamespace();
    const client = createMockClient(namespace);
    const { dest } = await createDest(client);
    mockFileContent([
      { id: 'a', body: 'b', _time_extracted: '2026-01-01T00:00:00Z' },
      { id: null, body: 'null-key', _time_extracted: '2026-01-01T00:00:00Z' },
    ]);

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'merge',
      ['id', 'body']
    );

    const rows = namespace.write.mock.calls[0]?.[0].upsert_rows as Array<{ id: string }>;
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('deletes a namespace once for full refresh', async () => {
    const namespace = createMockNamespace({ exists: vi.fn().mockResolvedValue(true) });
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello' }]);

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'full_refresh',
      []
    );
    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'full_refresh',
      []
    );

    expect(namespace.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('does not delete a missing namespace for full refresh', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello' }]);

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'full_refresh',
      []
    );

    expect(namespace.deleteAll).not.toHaveBeenCalled();
  });

  it('enables full-text search for configured string columns', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace), { fullTextColumns: ['body'] });
    mockFileContent([{ id: 'one', body: 'hello' }]);

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'append',
      []
    );

    expect(namespace.write.mock.calls[0]?.[0].schema.body).toEqual({
      type: 'string',
      full_text_search: true,
    });
  });

  it('maps l2 vectors to euclidean_squared', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello', body_embedding: [1, 2, 3] }]);

    await dest.loadAndFinalize('default', 'issues', '/tmp/issues.jsonl', columns, 'append', []);

    expect(namespace.write.mock.calls[0]?.[0].distance_metric).toBe('cosine_distance');

    const l2Columns = columns.map((column) =>
      column.name === 'body_embedding' && column.type === 'vector'
        ? { ...column, embedded_from: { ...column.embedded_from, distance_metric: 'l2' as const } }
        : column
    );
    const l2Namespace = createMockNamespace();
    const { dest: l2Dest } = await createDest(createMockClient(l2Namespace));
    await l2Dest.loadAndFinalize('default', 'issues', '/tmp/issues.jsonl', l2Columns, 'append', []);
    expect(l2Namespace.write.mock.calls[0]?.[0].distance_metric).toBe('euclidean_squared');
  });

  it('rejects dot-product vectors unless a supported metric is configured', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello', body_embedding: [1, 2, 3] }]);
    const dotColumns = columns.map((column) =>
      column.name === 'body_embedding' && column.type === 'vector'
        ? { ...column, embedded_from: { ...column.embedded_from, distance_metric: 'dot' as const } }
        : column
    );

    await expect(
      dest.loadAndFinalize('default', 'issues', '/tmp/issues.jsonl', dotColumns, 'append', [])
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('omits distance_metric for attribute-only namespaces', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello' }]);

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'append',
      []
    );

    expect(namespace.write.mock.calls[0]?.[0]).not.toHaveProperty('distance_metric');
  });

  it('rejects null vectors', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent([{ id: 'one', body: 'hello', body_embedding: null }]);

    await expect(
      dest.loadAndFinalize('default', 'issues', '/tmp/issues.jsonl', columns, 'append', [])
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('writes 1200 records in three batches', async () => {
    const namespace = createMockNamespace();
    const { dest } = await createDest(createMockClient(namespace));
    mockFileContent(
      Array.from({ length: 1200 }, (_, index) => ({ id: String(index), body: `row-${index}` }))
    );

    await dest.loadAndFinalize(
      'default',
      'issues',
      '/tmp/issues.jsonl',
      columns.slice(0, 2),
      'append',
      []
    );

    expect(namespace.write).toHaveBeenCalledTimes(3);
    expect(namespace.write.mock.calls.map(([params]) => params.upsert_rows.length)).toEqual([
      500, 500, 200,
    ]);
  });

  it('closes idempotently and round-trips truncated tables', async () => {
    const { dest } = await createDest(createMockClient());
    const tables = new Set(['issues']);
    dest.setTruncatedTables(tables);

    expect(dest.getTruncatedTables()).toEqual(tables);
    await expect(dest.close()).resolves.toBeUndefined();
    await expect(dest.close()).resolves.toBeUndefined();
  });
});

describe('TurbopufferDestination.deleteRows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function existingNamespace() {
    return createMockNamespace({
      exists: vi.fn().mockResolvedValue(true),
      schema: vi.fn().mockResolvedValue({ document_id: { type: 'string' } }),
    });
  }

  it('deletes by an In filter on the column', async () => {
    const ns = existingNamespace();
    const client = createMockClient(ns);
    const { dest } = await createDest(client, { namespacePrefix: 'dev_' });

    await dest.deleteRows('default', 'docs', 'document_id', ['a', 'b']);

    expect(client.namespace).toHaveBeenLastCalledWith('dev_docs');
    expect(ns.write).toHaveBeenCalledExactlyOnceWith({
      delete_by_filter: ['document_id', 'In', ['a', 'b']],
    });
  });

  it('batches values over 500 per write', async () => {
    const ns = existingNamespace();
    const { dest } = await createDest(createMockClient(ns));
    const values = Array.from({ length: 501 }, (_, i) => `v${i}`);

    await dest.deleteRows('default', 'docs', 'document_id', values);

    expect(ns.write).toHaveBeenCalledTimes(2);
    expect(ns.write.mock.calls[0]![0].delete_by_filter[2]).toHaveLength(500);
    expect(ns.write.mock.calls[1]![0].delete_by_filter[2]).toEqual(['v500']);
  });

  it('is a no-op when the namespace or attribute does not exist', async () => {
    const missing = createMockNamespace();
    const { dest } = await createDest(createMockClient(missing));
    await dest.deleteRows('default', 'docs', 'document_id', ['a']);
    expect(missing.write).not.toHaveBeenCalled();

    const ns = existingNamespace();
    const other = await createDest(createMockClient(ns));
    await other.dest.deleteRows('default', 'docs', 'other_column', ['a']);
    expect(ns.write).not.toHaveBeenCalled();
  });

  it('propagates write errors', async () => {
    const ns = existingNamespace();
    ns.write.mockRejectedValue(new Error('invalid filter'));
    const { dest } = await createDest(createMockClient(ns));

    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
      'invalid filter'
    );
  });
});
