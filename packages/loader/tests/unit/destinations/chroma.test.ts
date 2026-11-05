import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

function createMockCollection() {
  return {
    add: vi.fn().mockResolvedValue({ ids: [] }),
    upsert: vi.fn().mockResolvedValue({ ids: [] }),
    count: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockClient(collection?: ReturnType<typeof createMockCollection>) {
  return {
    heartbeat: vi.fn().mockResolvedValue({}),
    getOrCreateCollection: vi.fn().mockResolvedValue(collection ?? createMockCollection()),
    getCollection: vi.fn().mockResolvedValue(collection ?? createMockCollection()),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
  };
}

const embeddingColumns: SchemaColumn[] = [
  { name: 'id', type: 'string', primary_key: true },
  { name: 'embedding', type: 'vector', dimension: 3 },
  { name: 'text', type: 'string' },
];

async function createDest(
  client?: ReturnType<typeof createMockClient>,
  options?: { host?: string; port?: number }
) {
  const c = client ?? createMockClient();
  const { ChromaDestination } = await import('../../../src/runtime/destinations/chroma.js');
  const dest = new ChromaDestination({
    host: options?.host ?? 'localhost',
    port: options?.port ?? 8000,
    clientFactory: async () => c,
  });
  await dest.initialize();
  return { dest, client: c };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((r) => JSON.stringify(r)).join('\n'));
}

describe('ChromaDestination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('initialize() connects and calls heartbeat', async () => {
    const client = createMockClient();
    await createDest(client);
    expect(client.heartbeat).toHaveBeenCalled();
  });

  it('initialize() surfaces optional chromadb install guidance when the SDK is unavailable', async () => {
    const chromaModule = await import('../../../src/runtime/destinations/chroma.js');
    const loadModuleSpy = vi
      .spyOn(chromaModule.chromaRuntime, 'loadModule')
      .mockRejectedValue(
        new chromaModule.ChromaModuleLoadError(
          "Failed to load chromadb. Install it to use --dest chroma. Cannot find package 'chromadb'",
          1
        )
      );
    const dest = new chromaModule.ChromaDestination({
      host: 'localhost',
      port: 8000,
    });

    await expect(dest.initialize()).rejects.toThrow(
      /Failed to load chromadb\. Install it to use --dest chroma\..*Cannot find package 'chromadb'/
    );
    expect(loadModuleSpy).toHaveBeenCalledOnce();
  });

  it('initialize() throws if Chroma is unreachable', async () => {
    const { ChromaDestination } = await import('../../../src/runtime/destinations/chroma.js');
    const dest = new ChromaDestination({
      host: 'localhost',
      port: 9999,
      clientFactory: async () => ({
        heartbeat: vi.fn().mockRejectedValue(new Error('Connection refused')),
        getOrCreateCollection: vi.fn(),
        getCollection: vi.fn(),
      }),
    });
    await expect(dest.initialize()).rejects.toThrow(/Failed to connect to Chroma/);
  });

  it('ensureTable() creates collection with getOrCreate', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const { dest } = await createDest(client);
    await dest.ensureTable('default', 'test_embeddings', embeddingColumns);
    expect(client.getOrCreateCollection).toHaveBeenCalledWith({
      name: 'test_embeddings',
    });
  });

  it('ensureTable() rejects collection names with hyphens', async () => {
    const { sanitizeTableName } = await import('../../../src/runtime/destinations/database.js');
    expect(() => sanitizeTableName('my-table')).toThrow(/Invalid table name/);
  });

  it('ensureTable() rejects names starting with numbers', async () => {
    const { sanitizeTableName } = await import('../../../src/runtime/destinations/database.js');
    expect(() => sanitizeTableName('123table')).toThrow(/Invalid table name/);
  });

  it('loadAndFinalize("append") uses add() for new records', async () => {
    const collection = createMockCollection();
    collection.add.mockResolvedValue({ ids: ['id1', 'id2'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([
      { id: 'id1', embedding: [0.1, 0.2, 0.3], text: 'Hello world' },
      { id: 'id2', embedding: [0.4, 0.5, 0.6], text: 'Goodbye world' },
    ]);

    const result = await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'append',
      []
    );

    expect(collection.add).toHaveBeenCalled();
    expect(collection.upsert).not.toHaveBeenCalled();
    const addCall = collection.add.mock.calls[0]![0] as {
      ids: string[];
      embeddings: number[][];
    };
    expect(addCall.ids).toEqual(['id1', 'id2']);
    expect(addCall.embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(result.rowsAffected).toBe(2);
  });

  it('loadAndFinalize("append") splits into multiple add() calls when exceeding batch size', async () => {
    const collection = createMockCollection();
    const records = Array.from({ length: 501 }, (_, i) => ({
      id: `id${i}`,
      embedding: [0.1, 0.2],
      text: `doc-${i}`,
    }));
    // Mock add to return the ids it receives
    collection.add.mockImplementation(async (payload: { ids: string[] }) => ({
      ids: payload.ids,
    }));
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent(records);

    const result = await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'append',
      []
    );

    expect(collection.add).toHaveBeenCalledTimes(2);
    expect(result.rowsAffected).toBe(501);
  });

  it('loadAndFinalize("merge") upserts records (idempotent)', async () => {
    const collection = createMockCollection();
    collection.upsert.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1, 0.2], text: 'Updated text' }]);

    const result = await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'merge',
      ['id']
    );

    expect(collection.upsert).toHaveBeenCalled();
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize("full_refresh") clears collection on first call', async () => {
    const collection = createMockCollection();
    collection.upsert.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1, 0.2, 0.3], text: 'Fresh data' }]);

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    expect(client.deleteCollection).toHaveBeenCalled();
  });

  it('loadAndFinalize("full_refresh") does not clear on second call', async () => {
    const collection = createMockCollection();
    collection.upsert.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1, 0.2, 0.3], text: 'Fresh data' }]);

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    client.deleteCollection.mockClear();

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('loadAndFinalize() throws if no embedding column found', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', text: 'No embedding' }]);

    await expect(
      dest.loadAndFinalize(
        'default',
        'test_embeddings',
        '/tmp/embeddings.jsonl',
        [
          { name: 'id', type: 'string' },
          { name: 'text', type: 'string' },
        ],
        'append',
        []
      )
    ).rejects.toThrow(/No embedding column found/);
  });

  it('loadAndFinalize() uses vector column name if present', async () => {
    const collection = createMockCollection();
    collection.add.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', vector: [0.9, 0.1, 0.8], text: 'Using vector' }]);

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      [
        { name: 'id', type: 'string' },
        { name: 'vector', type: 'array' },
        { name: 'text', type: 'string' },
      ],
      'append',
      []
    );

    const addCall = collection.add.mock.calls[0]![0] as { embeddings: number[][] };
    expect(addCall.embeddings).toEqual([[0.9, 0.1, 0.8]]);
  });

  it('loadAndFinalize() extracts document from content column', async () => {
    const collection = createMockCollection();
    collection.add.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1], content: 'Document content' }]);

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      [
        { name: 'id', type: 'string' },
        { name: 'embedding', type: 'array' },
        { name: 'content', type: 'string' },
      ],
      'append',
      []
    );

    const addCall = collection.add.mock.calls[0]![0] as { documents?: string[] };
    expect(addCall.documents).toEqual(['Document content']);
  });

  it('loadAndFinalize() returns 0 rows for empty file', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    vi.mocked(fs.readFile).mockResolvedValue('');

    const result = await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'append',
      []
    );

    expect(collection.add).not.toHaveBeenCalled();
    expect(collection.upsert).not.toHaveBeenCalled();
    expect(result.rowsAffected).toBe(0);
  });

  it('buildMetadata preserves string values as strings', async () => {
    const collection = createMockCollection();
    collection.add.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1], zipcode: '12345' }]);

    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      [
        { name: 'id', type: 'string' },
        { name: 'embedding', type: 'array' },
        { name: 'zipcode', type: 'string' },
      ],
      'append',
      []
    );

    const addCall = collection.add.mock.calls[0]![0] as {
      metadatas?: Record<string, unknown>[];
    };
    expect(addCall.metadatas).toBeDefined();
    expect(addCall.metadatas![0]!.zipcode).toBe('12345');
    expect(typeof addCall.metadatas![0]!.zipcode).toBe('string');
  });

  it('getTruncatedTables() returns a defensive copy', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    mockFileContent([{ id: 'id1', embedding: [0.1], text: 'Hello' }]);
    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    const tables = dest.getTruncatedTables();
    tables.add('injected');
    expect(dest.getTruncatedTables().has('injected')).toBe(false);
  });

  it('setTruncatedTables() initializes from checkpoint', async () => {
    const collection = createMockCollection();
    collection.upsert.mockResolvedValue({ ids: ['id1'] });
    const client = createMockClient(collection);
    const { dest } = await createDest(client);

    dest.setTruncatedTables(new Set(['test_embeddings']));

    mockFileContent([{ id: 'id1', embedding: [0.1], text: 'Hello' }]);
    await dest.loadAndFinalize(
      'default',
      'test_embeddings',
      '/tmp/embeddings.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('close() clears client reference', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const { dest } = await createDest(client);
    await dest.close();
    await expect(
      dest.loadAndFinalize('default', 'test', '/tmp/f.jsonl', [], 'append', [])
    ).rejects.toThrow(/not initialized/);
  });
});

describe('ChromaDestination.deleteRows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('deletes rows whose metadata column is in the values', async () => {
    const collection = createMockCollection();
    const { dest, client } = await createDest(createMockClient(collection));

    await dest.deleteRows('default', 'docs', 'document_id', ["a'1", 'b']);

    expect(client.getCollection).toHaveBeenCalledWith({ name: 'docs' });
    expect(collection.delete).toHaveBeenCalledExactlyOnceWith({
      where: { document_id: { $in: ["a'1", 'b'] } },
    });
  });

  it('batches values over 500 per delete', async () => {
    const collection = createMockCollection();
    const { dest } = await createDest(createMockClient(collection));
    const values = Array.from({ length: 501 }, (_, i) => `v${i}`);

    await dest.deleteRows('default', 'docs', 'document_id', values);

    expect(collection.delete).toHaveBeenCalledTimes(2);
    expect(collection.delete.mock.calls[0]![0].where.document_id.$in).toHaveLength(500);
    expect(collection.delete.mock.calls[1]![0].where.document_id.$in).toEqual(['v500']);
  });

  it('is a no-op when the collection does not exist', async () => {
    const collection = createMockCollection();
    const client = createMockClient(collection);
    const notFound = Object.assign(new Error('The requested resource could not be found'), {
      name: 'ChromaNotFoundError',
    });
    client.getCollection.mockRejectedValue(notFound);
    const { dest } = await createDest(client);

    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).resolves.toBeUndefined();
    expect(collection.delete).not.toHaveBeenCalled();
  });

  it('propagates other errors', async () => {
    const client = createMockClient();
    client.getCollection.mockRejectedValue(new Error('permission denied'));
    const { dest } = await createDest(client);

    await expect(dest.deleteRows('default', 'docs', 'document_id', ['a'])).rejects.toThrow(
      'permission denied'
    );
  });
});
