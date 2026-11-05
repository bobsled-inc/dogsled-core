import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import type {
  PgVectorPoolLike,
  PgVectorPoolClientLike,
  PgVectorQueryResultLike,
} from '../../../src/runtime/destinations/pgvector.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const embeddingColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'content', type: 'string' },
  { name: 'embedding', type: 'array' },
];

function createMockQueryResult(
  options: { rows?: Record<string, unknown>[]; rowCount?: number } = {}
): PgVectorQueryResultLike {
  return {
    rows: options.rows ?? [],
    rowCount: options.rowCount ?? 0,
  };
}

function createMockClient(
  options: { existingColumns?: Array<{ column_name: string; data_type: string }> } = {}
): PgVectorPoolClientLike {
  const queryFn = vi.fn().mockImplementation(() => {
    return Promise.resolve(createMockQueryResult({ rows: options.existingColumns ?? [] }));
  });
  return {
    query: queryFn,
    release: vi.fn(),
  };
}

function createMockPool(client?: PgVectorPoolClientLike): PgVectorPoolLike {
  const c = client ?? createMockClient();
  return {
    connect: vi.fn().mockResolvedValue(c),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

async function createDest(
  pool?: PgVectorPoolLike,
  options?: { schema?: string; vectorColumns?: string[]; vectorDimension?: number }
) {
  const p = pool ?? createMockPool();
  const { PgVectorDestination } = await import('../../../src/runtime/destinations/pgvector.js');
  const vectorConfig =
    options?.vectorColumns && options?.vectorDimension
      ? { columns: options.vectorColumns, dimension: options.vectorDimension }
      : undefined;
  const dest = new PgVectorDestination(
    {
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      schema: options?.schema ?? 'public',
      username: 'testuser',
      password: 'testpass',
      poolFactory: () => p,
    },
    vectorConfig
  );
  await dest.initialize();
  return { dest, pool: p };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((r) => JSON.stringify(r)).join('\n'));
}

describe('PgVectorDestination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ── Initialization ──

  it('initialize() creates schema and vector extension', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    await createDest(pool, { schema: 'my_schema' });
    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(queries).toContain('CREATE SCHEMA IF NOT EXISTS "my_schema"');
    expect(queries).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(client.release).toHaveBeenCalled();
  });

  it('exports serializeVectorValue for reuse', async () => {
    const { serializeVectorValue } = await import('../../../src/runtime/destinations/pgvector.js');
    expect(serializeVectorValue([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    expect(serializeVectorValue(null)).toBeNull();
    expect(serializeVectorValue('[0.1,0.2,0.3]')).toBe('[0.1,0.2,0.3]');
    expect(serializeVectorValue('[]')).toBeNull();
    expect(serializeVectorValue('[foo]')).toBeNull();
    expect(serializeVectorValue('[1, NaN]')).toBeNull();
    expect(serializeVectorValue({ value: 1 })).toBeNull();
  });

  it('throws if getPool() called before initialize()', async () => {
    const { PgVectorDestination } = await import('../../../src/runtime/destinations/pgvector.js');
    const dest = new PgVectorDestination({
      host: 'localhost',
      database: 'testdb',
      username: 'user',
      password: 'pass',
      poolFactory: () => createMockPool(),
    });
    await expect(dest.ensureTable('public', 'test', embeddingColumns)).rejects.toThrow(
      /not initialized/
    );
  });

  // ── ensureTable ──

  it('ensureTable() creates table with vector type', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 1536,
    });

    await dest.ensureTable('public', 'embeddings', embeddingColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toBeDefined();
    expect(createSql).toContain('"id" BIGINT');
    expect(createSql).toContain('"content" TEXT');
    expect(createSql).toContain('"embedding" vector(1536)');
    expect(createSql).toContain('"_time_extracted" TIMESTAMPTZ');
    expect(createSql).toContain('"_dogsled_loaded_at" TIMESTAMPTZ DEFAULT NOW()');
  });

  it('ensureTable() accepts protocol vector columns without vectorColumns config', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'embeddings', [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'embedding', type: 'vector', dimension: 1536 },
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"embedding" vector(1536)');
  });

  it('ensureTable() creates table with regular columns when no vector config', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'items', embeddingColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toBeDefined();
    expect(createSql).toContain('"id" BIGINT');
    expect(createSql).toContain('"embedding" TEXT');
  });

  it('ensureTable() adds missing columns via ALTER TABLE', async () => {
    const client = createMockClient({
      existingColumns: [
        { column_name: 'id', data_type: 'BIGINT' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMPTZ' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMPTZ' },
      ],
    });
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 768,
    });

    await dest.ensureTable('public', 'embeddings', embeddingColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const alterSql = queries.find((q) => q.startsWith('ALTER TABLE'));
    expect(alterSql).toBeDefined();
    expect(alterSql).toContain('ADD COLUMN "content" TEXT');
    expect(alterSql).toContain('ADD COLUMN "embedding" vector(768)');
  });

  it('ensureTable() detects vector type conflicts', async () => {
    const client = createMockClient({
      existingColumns: [
        { column_name: 'id', data_type: 'BIGINT' },
        { column_name: 'content', data_type: 'TEXT' },
        { column_name: 'embedding', data_type: 'VECTOR(1536)' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMPTZ' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMPTZ' },
      ],
    });
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 768,
    });

    await expect(dest.ensureTable('public', 'embeddings', embeddingColumns)).rejects.toThrow(
      /Schema change conflict/i
    );
  });

  // ── loadAndFinalize: append ──

  it('loadAndFinalize("append") inserts records with vector serialization', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 3,
    });

    mockFileContent([
      {
        id: 1,
        content: 'Hello',
        embedding: [0.1, 0.2, 0.3],
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await dest.loadAndFinalize(
      'public',
      'embeddings',
      '/tmp/data.jsonl',
      embeddingColumns,
      'append',
      []
    );

    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    expect(insertCall).toBeDefined();
    const sql = insertCall![0] as string;
    expect(sql).toContain('NOW()');
    const params = insertCall![1] as unknown[];
    expect(params).toContain('[0.1,0.2,0.3]');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize("append") handles JSON string vectors', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 3,
    });

    mockFileContent([
      {
        id: 1,
        content: 'Hello',
        embedding: '[0.1, 0.2, 0.3]',
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);

    await dest.loadAndFinalize(
      'public',
      'embeddings',
      '/tmp/data.jsonl',
      embeddingColumns,
      'append',
      []
    );

    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    const params = insertCall![1] as unknown[];
    expect(params).toContain('[0.1,0.2,0.3]');
  });

  // ── loadAndFinalize: full_refresh ──

  it('loadAndFinalize("full_refresh") TRUNCATEs on first call', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, content: 'Test', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'public',
      'items',
      '/tmp/data.jsonl',
      embeddingColumns,
      'full_refresh',
      []
    );

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(queries.some((q) => q.includes('TRUNCATE TABLE'))).toBe(true);
  });

  // ── loadAndFinalize: merge ──

  it('loadAndFinalize("merge") creates temp table without schema prefix', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, { schema: 'analytics' });

    mockFileContent([{ id: 1, content: 'Test', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('analytics', 'items', '/tmp/data.jsonl', embeddingColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createTempSql = queries.find((q) => q.includes('CREATE TEMP TABLE'));
    expect(createTempSql).toBeDefined();
    expect(createTempSql).not.toContain('"analytics"');
    expect(createTempSql).toMatch(/"_dogsled_stg_items_[a-f0-9]{16}"/);
  });

  it('loadAndFinalize("merge") generates correct ON CONFLICT SQL with EXCLUDED and target alias', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, content: 'Test', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('public', 'items', '/tmp/data.jsonl', embeddingColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const mergeSql = queries.find((q) => q.includes('ON CONFLICT'));
    expect(mergeSql).toBeDefined();
    expect(mergeSql).toContain('EXCLUDED.');
    expect(mergeSql).toContain(' AS T ');
    expect(mergeSql).not.toContain('= S.');
  });

  it('loadAndFinalize("merge") requires at least one key column', async () => {
    const { dest } = await createDest();
    mockFileContent([{ id: 1, content: 'Test' }]);

    await expect(
      dest.loadAndFinalize('public', 'items', '/tmp/data.jsonl', embeddingColumns, 'merge', [])
    ).rejects.toThrow(/merge strategy requires at least one key column/);
  });

  // ── Type mapping ──

  it('type mapping: vector column with dimension', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 1024,
    });

    await dest.ensureTable('public', 'test', embeddingColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"embedding" vector(1024)');
  });

  // ── Lifecycle ──

  it('close() ends the pool', async () => {
    const pool = createMockPool();
    const { dest } = await createDest(pool);
    await dest.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it('getTruncatedTables() returns a defensive copy', async () => {
    const { dest } = await createDest();
    const tables = dest.getTruncatedTables();
    tables.add('injected');
    expect(dest.getTruncatedTables().has('injected')).toBe(false);
  });

  // ── Vector value serialization ──

  it('serializes vector arrays as pgvector format', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 4,
    });

    mockFileContent([
      {
        id: 1,
        content: 'Test',
        embedding: [1.0, 2.0, 3.0, 4.0],
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);

    await dest.loadAndFinalize('public', 'test', '/tmp/data.jsonl', embeddingColumns, 'append', []);

    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    const params = insertCall![1] as unknown[];
    expect(params).toContain('[1,2,3,4]');
  });

  it('handles null vector values', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, {
      vectorColumns: ['embedding'],
      vectorDimension: 3,
    });

    mockFileContent([
      {
        id: 1,
        content: 'Test',
        embedding: null,
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);

    await dest.loadAndFinalize('public', 'test', '/tmp/data.jsonl', embeddingColumns, 'append', []);

    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    const params = insertCall![1] as unknown[];
    expect(params).toContain(null);
  });
});

describe('PgVectorDestination deleteRows', () => {
  function deleteClient(
    tableOid: string | null,
    deleteImpl?: () => Promise<PgVectorQueryResultLike>
  ): PgVectorPoolClientLike {
    const client = createMockClient();
    vi.mocked(client.query).mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT to_regclass')) {
        return createMockQueryResult({ rows: [{ table_oid: tableOid }] });
      }
      if (sql.startsWith('DELETE') && deleteImpl) return deleteImpl();
      return createMockQueryResult();
    });
    return client;
  }

  function deleteCalls(client: PgVectorPoolClientLike) {
    return vi
      .mocked(client.query)
      .mock.calls.filter((call) => String(call[0]).startsWith('DELETE'));
  }

  it('deletes matching rows with a bound array parameter', async () => {
    const client = deleteClient('public.chunks');
    const { dest } = await createDest(createMockPool(client));
    const values = ["abc'); DROP TABLE x; --", 'def'];

    await dest.deleteRows('public', 'chunks', 'document_id', values);

    expect(vi.mocked(client.query)).toHaveBeenCalledWith('SELECT to_regclass($1) AS table_oid', [
      '"public"."chunks"',
    ]);
    expect(deleteCalls(client)).toEqual([
      ['DELETE FROM "public"."chunks" WHERE "document_id" = ANY($1)', [values]],
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it('batches values over 500 per statement', async () => {
    const client = deleteClient('public.chunks');
    const { dest } = await createDest(createMockPool(client));
    const values = Array.from({ length: 1001 }, (_, i) => `id-${i}`);

    await dest.deleteRows('public', 'chunks', 'document_id', values);

    const batches = deleteCalls(client).map((call) => (call[1] as string[][])[0]!);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(batches.flat()).toEqual(values);
  });

  it('is a no-op when the table does not exist', async () => {
    const client = deleteClient(null);
    const { dest } = await createDest(createMockPool(client));

    await expect(
      dest.deleteRows('public', 'chunks', 'document_id', ['a'])
    ).resolves.toBeUndefined();
    expect(deleteCalls(client)).toHaveLength(0);
  });

  it('propagates delete errors', async () => {
    const client = deleteClient('public.chunks', () =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' }))
    );
    const { dest } = await createDest(createMockPool(client));

    await expect(dest.deleteRows('public', 'chunks', 'document_id', ['a'])).rejects.toThrow(
      'permission denied'
    );
    expect(client.release).toHaveBeenCalled();
  });
});
