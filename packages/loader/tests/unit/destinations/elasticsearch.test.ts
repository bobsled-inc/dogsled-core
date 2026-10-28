import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import type {
  ElasticsearchClientLike,
  ElasticsearchDestinationOptions,
} from '../../../src/runtime/destinations/elasticsearch.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

const embeddingColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'text', type: 'string' },
  { name: 'embedding', type: 'vector', dimension: 1536 },
];

function createMockClient(
  options: {
    indexExists?: boolean;
    existingMapping?: Record<string, { type?: string; dims?: number }>;
    bulkResponse?: { errors?: boolean };
  } = {}
): ElasticsearchClientLike {
  return {
    request: vi.fn().mockImplementation(async (init) => {
      const url = init.url ?? '';

      if (url.includes('/_bulk') || url.includes('/_bulk?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errors: options.bulkResponse?.errors ?? false,
            items: [],
          }),
        };
      }

      if (init.method === 'HEAD' && url.match(/\/\w+$/)) {
        return {
          ok: options.indexExists ?? false,
          status: options.indexExists ? 200 : 404,
          json: async () => ({}),
        };
      }

      if (init.method === 'PUT' && url.match(/\/\w+$/)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ acknowledged: true }),
        };
      }

      if (url.endsWith('/_mapping') && init.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ acknowledged: true }),
        };
      }

      if (url.endsWith('/_mapping') && init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            [url.split('/').pop()?.split('/')[0]]: {
              mappings: {
                properties: options.existingMapping ?? {},
              },
            },
          }),
        };
      }

      if (init.method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ acknowledged: true }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }),
  };
}

async function createDest(
  client?: ElasticsearchClientLike,
  options: Partial<
    Omit<ElasticsearchDestinationOptions, 'host' | 'port' | 'apiKey' | 'clientFactory'>
  > = {}
) {
  const c = client ?? createMockClient();
  const { ElasticsearchDestination } =
    await import('../../../src/runtime/destinations/elasticsearch.js');
  const dest = new ElasticsearchDestination({
    host: 'localhost',
    port: 9200,
    index: 'test',
    apiKey: 'test-key',
    ...options,
    clientFactory: () => c,
  });
  await dest.initialize();
  return { dest, client: c };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((r) => JSON.stringify(r)).join('\n'));
}

describe('ElasticsearchDestination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('bounds decoded default-client responses and denies redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('x'.repeat(16 * 1024 * 1024 + 1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { createDefaultClient } =
      await import('../../../src/runtime/destinations/elasticsearch.js');
    const client = createDefaultClient('https://search.example.com', {
      apiKey: 'test-key',
    });

    const response = await client.request({ method: 'GET' });
    await expect(response.json()).rejects.toThrow(/exceeds the 16 MiB limit/);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://search.example.com',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('initialize() connects to cluster', async () => {
    const client = createMockClient();
    await createDest(client);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://localhost:9200',
      })
    );
  });

  it('throws if methods called before initialize()', async () => {
    const { ElasticsearchDestination } =
      await import('../../../src/runtime/destinations/elasticsearch.js');
    const dest = new ElasticsearchDestination({
      host: 'localhost',
      port: 9200,
      clientFactory: () => createMockClient(),
    });
    await expect(dest.ensureTable('default', 'test', issueColumns)).rejects.toThrow(
      /not initialized/
    );
  });

  it('ensureTable() creates index with mapping', async () => {
    const client = createMockClient({ indexExists: false });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);

    const putCalls = client.request.mock.calls;
    const indexCall = putCalls.find(
      (c) => typeof c[0] === 'object' && c[0].method === 'PUT' && c[0].url?.includes('/test_index')
    );
    expect(indexCall).toBeDefined();
    const callArgs = indexCall as unknown as [Record<string, unknown>];
    const body = callArgs[0].body as string;
    expect(body).toContain('"id"');
    expect(body).toContain('"title"');
  });

  it('ensureTable() creates index with dense_vector for embedding columns', async () => {
    const client = createMockClient({ indexExists: false });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'embeddings', embeddingColumns, {
      vectorDimension: 1536,
    });

    const putCalls = client.request.mock.calls;
    const indexCall = putCalls.find(
      (c) => typeof c[0] === 'object' && c[0].method === 'PUT' && c[0].url?.includes('/embeddings')
    );
    expect(indexCall).toBeDefined();
    const callArgs = indexCall as unknown as [Record<string, unknown>];
    const body = callArgs[0].body as string;
    expect(body).toBeDefined();
    expect(body.length).toBeGreaterThan(0);
    const parsedBody = JSON.parse(body);
    expect(parsedBody.mappings.properties).toBeDefined();
    expect(parsedBody.mappings.properties.embedding).toBeDefined();
    expect(parsedBody.mappings.properties.embedding.type).toBe('dense_vector');
    expect(parsedBody.mappings.properties.embedding.dims).toBe(1536);
  });

  it('prefers schema vector dimensions even when vectorColumns config omits the field', async () => {
    const client = createMockClient({ indexExists: false });
    const { dest } = await createDest(client, {
      vectorColumns: ['custom_vector'],
      vectorDimension: 42,
    });

    await dest.ensureTable('default', 'embeddings', embeddingColumns);

    const putCalls = client.request.mock.calls;
    const indexCall = putCalls.find(
      (c) => typeof c[0] === 'object' && c[0].method === 'PUT' && c[0].url?.includes('/embeddings')
    );
    expect(indexCall).toBeDefined();
    const callArgs = indexCall as unknown as [Record<string, unknown>];
    const body = callArgs[0].body as string;
    const parsedBody = JSON.parse(body);
    expect(parsedBody.mappings.properties.embedding).toMatchObject({
      type: 'dense_vector',
      dims: 1536,
      index: true,
      algorithm: 'hnsw',
    });
  });

  it('ensureTable() updates mapping for existing index', async () => {
    const client = createMockClient({
      indexExists: true,
      existingMapping: {
        id: { type: 'long' },
        _time_extracted: { type: 'date' },
        _dogsled_loaded_at: { type: 'date' },
      },
    });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        url: 'http://localhost:9200/test_index/_mapping',
      })
    );
  });

  it('loadAndFinalize() bulk indexes documents', async () => {
    const client = createMockClient({ indexExists: true });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);
    client.request.mockClear();

    mockFileContent([
      { id: 1, title: 'First', _time_extracted: '2024-01-01T00:00:00Z' },
      { id: 2, title: 'Second', _time_extracted: '2024-01-02T00:00:00Z' },
    ]);

    const result = await dest.loadAndFinalize(
      'default',
      'test_index',
      '/tmp/test.jsonl',
      issueColumns,
      'append',
      ['id']
    );

    expect(result.rowsAffected).toBe(2);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'http://localhost:9200/_bulk',
      })
    );
  });

  it('loadAndFinalize() truncates index for full_refresh strategy', async () => {
    const client = createMockClient({ indexExists: true });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);
    client.request.mockClear();

    mockFileContent([{ id: 1, title: 'First', _time_extracted: '2024-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'default',
      'test_index',
      '/tmp/test.jsonl',
      issueColumns,
      'full_refresh',
      ['id']
    );

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: 'http://localhost:9200/test_index',
      })
    );
  });

  it('loadAndFinalize() throws if merge strategy has no key columns', async () => {
    const client = createMockClient({ indexExists: true });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);

    mockFileContent([{ id: 1, title: 'First', _time_extracted: '2024-01-01T00:00:00Z' }]);

    await expect(
      dest.loadAndFinalize('default', 'test_index', '/tmp/test.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow('merge strategy requires at least one key column');
  });

  it('loadAndFinalize() returns 0 for empty file', async () => {
    const client = createMockClient({ indexExists: true });
    const { dest } = await createDest(client);

    await dest.ensureTable('default', 'test_index', issueColumns);
    client.request.mockClear();

    vi.mocked(fs.readFile).mockResolvedValue('');

    const result = await dest.loadAndFinalize(
      'default',
      'test_index',
      '/tmp/empty.jsonl',
      issueColumns,
      'append',
      ['id']
    );

    expect(result.rowsAffected).toBe(0);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('getTruncatedTables() returns empty set initially', async () => {
    const { dest } = await createDest();
    expect(dest.getTruncatedTables().size).toBe(0);
  });

  it('setTruncatedTables() updates the truncated tables set', async () => {
    const { dest } = await createDest();
    const tables = new Set(['default.test_index']);
    dest.setTruncatedTables(tables);
    expect(dest.getTruncatedTables()).toEqual(tables);
  });

  it('close() clears client', async () => {
    const client = createMockClient();
    const { dest } = await createDest(client);

    await dest.close();
    await expect(dest.ensureTable('default', 'test', issueColumns)).rejects.toThrow(
      /not initialized/
    );
  });
});
