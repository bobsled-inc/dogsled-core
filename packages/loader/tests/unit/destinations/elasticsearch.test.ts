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

describe('ElasticsearchDestination.deleteRows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function response(status: number, body: Record<string, unknown> = {}) {
    return { ok: status < 300, status, json: async () => body };
  }

  /** Serves `hits` ids once per search page, then empty pages. */
  function deleteClient(pages: string[][], refreshStatus = 200) {
    const searches: Array<Record<string, unknown>> = [];
    const bulks: string[] = [];
    const request = vi.fn().mockImplementation(async (init) => {
      const url: string = init.url ?? '';
      if (url.endsWith('/_refresh')) return response(refreshStatus);
      if (url.includes('/_search')) {
        searches.push(JSON.parse(init.body));
        const ids = pages.shift() ?? [];
        return response(200, { hits: { hits: ids.map((_id) => ({ _id })) } });
      }
      if (url.includes('/_bulk')) {
        bulks.push(init.body);
        const items = (init.body as string)
          .trim()
          .split('\n')
          .map(() => ({ delete: { result: 'deleted', status: 200 } }));
        return response(200, { errors: false, items });
      }
      return response(200);
    });
    return { client: { request } as ElasticsearchClientLike, request, searches, bulks };
  }

  it('finds exact matches through a runtime keyword field and bulk-deletes them with refresh', async () => {
    const { client, request, searches, bulks } = deleteClient([['id1', 'id2']]);
    const { dest } = await createDest(client);

    await dest.deleteRows('default', 'docs', 'document_id', ['a"1', 'b']);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: 'http://localhost:9200/docs/_refresh' })
    );
    expect(searches).toHaveLength(2);
    expect(searches[0]).toMatchObject({
      size: 500,
      _source: false,
      runtime_mappings: {
        dogsled_replace_key: {
          type: 'keyword',
          script: { params: { field: 'document_id' } },
        },
      },
      query: { terms: { dogsled_replace_key: ['a"1', 'b'] } },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:9200/_bulk?refresh=true' })
    );
    expect(bulks).toEqual([
      '{"delete":{"_index":"docs","_id":"id1"}}\n{"delete":{"_index":"docs","_id":"id2"}}\n',
    ]);
  });

  it('batches values over 500 per search', async () => {
    const { client, searches } = deleteClient([]);
    const { dest } = await createDest(client);
    const values = Array.from({ length: 501 }, (_, i) => `v${i}`);

    await dest.deleteRows('default', 'docs', 'document_id', values);

    expect(searches).toHaveLength(2);
    expect(
      (searches[0]!.query as { terms: Record<string, string[]> }).terms.dogsled_replace_key
    ).toHaveLength(500);
    expect(searches[1]!.query).toEqual({ terms: { dogsled_replace_key: ['v500'] } });
  });

  it('is a no-op when the index does not exist', async () => {
    const { client, searches, bulks } = deleteClient([['id1']], 404);
    const { dest } = await createDest(client);

    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).resolves.toBeUndefined();
    expect(searches).toHaveLength(0);
    expect(bulks).toHaveLength(0);
  });

  it('rejects partial or timed-out searches instead of finishing early', async () => {
    for (const partial of [{ timed_out: true }, { _shards: { total: 2, failed: 1 } }]) {
      const { client, request, searches } = deleteClient([]);
      const base = request.getMockImplementation()!;
      request.mockImplementation(async (init) =>
        (init.url as string).includes('/_search')
          ? response(200, { ...partial, hits: { hits: [] } })
          : base(init)
      );
      const { dest } = await createDest(client);
      await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
        /Search on index "docs" failed/
      );
      expect(searches).toHaveLength(0);
    }
    const { client, request } = deleteClient([]);
    const { dest } = await createDest(client);
    await dest.deleteRows('default', 'docs', 'document_id', ['a']);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:9200/docs/_search?allow_partial_search_results=false',
      })
    );
  });

  it('treats not_found as deleted when a bulk delete is replayed', async () => {
    const { client, request, bulks } = deleteClient([['id1']]);
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (init) =>
      (init.url as string).includes('/_bulk')
        ? (bulks.push(init.body), response(200, { items: [{ delete: { result: 'not_found' } }] }))
        : base(init)
    );
    const { dest } = await createDest(client);
    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).resolves.toBeUndefined();
    expect(bulks).toHaveLength(1);
  });

  it('fails instead of looping when the same hits survive their delete', async () => {
    const { client } = deleteClient([['id1'], ['id1'], ['id1']]);
    const { dest } = await createDest(client);
    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
      /did not remove matching documents/
    );
  });

  it('propagates refresh failures and item-level delete errors', async () => {
    const failing = deleteClient([], 403);
    const first = await createDest(failing.client);
    await expect(first.dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
      /Failed to refresh index "docs"/
    );

    const { client, request } = deleteClient([['id1']]);
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (init) =>
      (init.url as string).includes('/_bulk')
        ? response(200, { errors: true, items: [{ delete: { error: { type: 'x' } } }] })
        : base(init)
    );
    const second = await createDest(client);
    await expect(second.dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
      /item-level error/
    );
  });
});
