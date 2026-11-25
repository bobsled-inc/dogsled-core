import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import type {
  PostgresDestinationOptions,
  PostgresPoolLike,
  PostgresPoolClientLike,
  PostgresQueryResultLike,
} from '../../../src/runtime/destinations/postgres.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockQueryResult(
  options: { rows?: Record<string, unknown>[]; rowCount?: number } = {}
): PostgresQueryResultLike {
  return {
    rows: options.rows ?? [],
    rowCount: options.rowCount ?? 0,
  };
}

function createMockClient(
  options: {
    existingColumns?: Array<{ column_name: string; data_type: string }>;
    queryImpl?: (sql: string, params?: unknown[]) => Promise<PostgresQueryResultLike>;
  } = {}
): PostgresPoolClientLike {
  const queryFn = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (options.queryImpl) {
      return options.queryImpl(sql, params);
    }
    return Promise.resolve(createMockQueryResult({ rows: options.existingColumns ?? [] }));
  });
  return {
    query: queryFn,
    release: vi.fn(),
  };
}

function createMockPool(client?: PostgresPoolClientLike): PostgresPoolLike {
  const c = client ?? createMockClient();
  return {
    connect: vi.fn().mockResolvedValue(c),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

async function createDest(pool?: PostgresPoolLike, options?: { schema?: string }) {
  const p = pool ?? createMockPool();
  const { PostgresDestination } = await import('../../../src/runtime/destinations/postgres.js');
  const dest = new PostgresDestination({
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    schema: options?.schema ?? 'public',
    username: 'testuser',
    password: 'testpass',
    poolFactory: () => p,
  });
  await dest.initialize();
  return { dest, pool: p };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((r) => JSON.stringify(r)).join('\n'));
}

describe('PostgresDestination', () => {
  it('creates and comments a reserved table in one transaction', async () => {
    const marker = 'temp-dataset-019a';
    let columnReads = 0;
    const client = createMockClient({
      queryImpl: async (sql) => {
        if (sql.includes('information_schema.columns')) {
          columnReads += 1;
          if (columnReads === 1) return createMockQueryResult();
          return createMockQueryResult({
            rows: [
              { column_name: 'id', data_type: 'BIGINT' },
              { column_name: 'title', data_type: 'TEXT' },
              { column_name: '_time_extracted', data_type: 'TIMESTAMP WITH TIME ZONE' },
              { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP WITH TIME ZONE' },
            ],
          });
        }
        if (sql.startsWith('SELECT to_regclass')) {
          return createMockQueryResult({ rows: [{ table_oid: null }] });
        }
        if (sql.startsWith('SELECT obj_description')) {
          return createMockQueryResult({ rows: [{ marker, relkind: 'r', relpersistence: 'p' }] });
        }
        return createMockQueryResult();
      },
    });
    const { dest } = await createDest(createMockPool(client));
    await dest.ensureTable('public', 'issues', issueColumns, { tableOwnershipMarker: marker });
    const queries = vi.mocked(client.query).mock.calls.map(([sql]) => sql);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(queries).toContain(`COMMENT ON TABLE "public"."issues" IS '${marker}'`);
    expect(queries.indexOf('COMMIT')).toBeGreaterThan(
      queries.findIndex((query) => query.startsWith('COMMENT ON TABLE'))
    );
  });

  it('rejects an unmarked reserved table before altering it', async () => {
    const client = createMockClient({
      queryImpl: async (sql) => {
        if (sql.includes('information_schema.columns')) {
          return createMockQueryResult({ rows: [{ column_name: 'id', data_type: 'BIGINT' }] });
        }
        if (sql.startsWith('SELECT obj_description')) {
          return createMockQueryResult({ rows: [{ marker: null }] });
        }
        return createMockQueryResult();
      },
    });
    const { dest } = await createDest(createMockPool(client));
    await expect(
      dest.ensureTable('public', 'issues', issueColumns, {
        tableOwnershipMarker: 'temp-dataset-019a',
      })
    ).rejects.toThrow('ownership marker does not match');
    expect(vi.mocked(client.query).mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(
      false
    );
  });
  it('rejects a same-marker view before altering it', async () => {
    const marker = 'temp-dataset-019a';
    const client = createMockClient({
      queryImpl: async (sql) => {
        if (sql.includes('information_schema.columns')) {
          return createMockQueryResult({ rows: [{ column_name: 'id', data_type: 'BIGINT' }] });
        }
        if (sql.startsWith('SELECT obj_description')) {
          return createMockQueryResult({ rows: [{ marker, relkind: 'v', relpersistence: 'p' }] });
        }
        return createMockQueryResult();
      },
    });
    const { dest } = await createDest(createMockPool(client));
    await expect(
      dest.ensureTable('public', 'issues', issueColumns, { tableOwnershipMarker: marker })
    ).rejects.toThrow('ownership marker does not match');
    expect(vi.mocked(client.query).mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(
      false
    );
  });

  it('rejects mismatched physical columns after a same-marker create race', async () => {
    const marker = 'temp-dataset-019a';
    let columnReads = 0;
    const client = createMockClient({
      queryImpl: async (sql) => {
        if (sql.includes('information_schema.columns')) {
          columnReads += 1;
          return createMockQueryResult({
            rows: columnReads === 1 ? [] : [{ column_name: 'different', data_type: 'TEXT' }],
          });
        }
        if (sql.startsWith('SELECT to_regclass')) {
          return createMockQueryResult({ rows: [{ table_oid: 'existing' }] });
        }
        if (sql.startsWith('SELECT obj_description')) {
          return createMockQueryResult({ rows: [{ marker, relkind: 'r', relpersistence: 'p' }] });
        }
        return createMockQueryResult();
      },
    });
    const { dest } = await createDest(createMockPool(client));
    await expect(
      dest.ensureTable('public', 'issues', issueColumns, { tableOwnershipMarker: marker })
    ).rejects.toThrow('schema does not match');
  });
  it('maps vector columns to pgvector types', async () => {
    const { mapPostgresType } = await import('../../../src/runtime/destinations/postgres.js');
    expect(mapPostgresType({ name: 'embedding', type: 'vector', dimension: 1536 })).toBe(
      'vector(1536)'
    );
  });

  // ── Initialization ──

  it('initialize() creates schema', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    await createDest(pool, { schema: 'my_schema' });
    expect(client.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "my_schema"');
    expect(client.release).toHaveBeenCalled();
  });

  it('throws if getPool() called before initialize()', async () => {
    const { PostgresDestination } = await import('../../../src/runtime/destinations/postgres.js');
    const dest = new PostgresDestination({
      host: 'localhost',
      database: 'testdb',
      username: 'user',
      password: 'pass',
      poolFactory: () => createMockPool(),
    });
    await expect(dest.ensureTable('public', 'test', issueColumns)).rejects.toThrow(
      /not initialized/
    );
  });

  // ── ensureTable ──

  it('ensureTable() creates table with DDL including system columns', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'issues', issueColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toBeDefined();
    expect(createSql).toContain('"id" BIGINT');
    expect(createSql).toContain('"title" TEXT');
    expect(createSql).toContain('"_time_extracted" TIMESTAMPTZ');
    expect(createSql).toContain('"_dogsled_loaded_at" TIMESTAMPTZ DEFAULT NOW()');
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
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'issues', issueColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const alterSql = queries.find((q) => q.startsWith('ALTER TABLE'));
    expect(alterSql).toBeDefined();
    expect(alterSql).toContain('ADD COLUMN "title" TEXT');
  });

  it('ensureTable() detects type conflicts and throws', async () => {
    const client = createMockClient({
      existingColumns: [
        { column_name: 'id', data_type: 'TEXT' },
        { column_name: 'title', data_type: 'TEXT' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMPTZ' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMPTZ' },
      ],
    });
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await expect(dest.ensureTable('public', 'issues', issueColumns)).rejects.toThrow(
      /Schema change conflict.*id.*TEXT.*BIGINT/i
    );
  });

  it('ensureTable() skips API calls when column cache is populated', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    // First call populates cache
    await dest.ensureTable('public', 'issues', issueColumns);
    const callCountAfterFirst = client.query.mock.calls.length;

    // Second call should hit cache
    await dest.ensureTable('public', 'issues', issueColumns);
    expect(client.query.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('ensureTable() rejects invalid schema names', async () => {
    const { dest } = await createDest();
    await expect(dest.ensureTable('public; DROP TABLE--', 'issues', issueColumns)).rejects.toThrow(
      /Invalid schema name/
    );
  });

  it('ensureTable() rejects invalid table names', async () => {
    const { dest } = await createDest();
    await expect(dest.ensureTable('public', 'my-table', issueColumns)).rejects.toThrow(
      /Invalid table name/
    );
  });

  it('ensureTable() creates pgvector extension and vector columns when schema declares vector type', async () => {
    const vectorColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'embedding', type: 'vector', dimension: 1536 },
    ];
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'embeddings', vectorColumns);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(queries).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"embedding" vector(1536)');
  });

  describe('existing pgvector columns', () => {
    const vectorColumns = (dimension: number): SchemaColumn[] => [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'embedding', type: 'vector', dimension },
    ];

    /** Answers as a Postgres server does: without the catalog, a vector is USER-DEFINED. */
    function createVectorTableClient(ownershipMarker?: string): PostgresPoolClientLike {
      let exists = ownershipMarker === undefined;
      return createMockClient({
        queryImpl: async (sql) => {
          if (sql.startsWith('CREATE TABLE')) exists = true;
          if (sql.startsWith('SELECT to_regclass')) {
            return createMockQueryResult({ rows: [{ table_oid: null }] });
          }
          if (sql.startsWith('SELECT obj_description')) {
            return createMockQueryResult({
              rows: [{ marker: ownershipMarker, relkind: 'r', relpersistence: 'p' }],
            });
          }
          if (!sql.includes('information_schema.columns') || !exists) {
            return createMockQueryResult();
          }
          const vectorType = sql.includes('format_type') ? 'vector(3)' : 'USER-DEFINED';
          return createMockQueryResult({
            rows: [
              { column_name: 'id', data_type: 'bigint' },
              { column_name: 'embedding', data_type: vectorType },
              { column_name: '_time_extracted', data_type: 'timestamp with time zone' },
              { column_name: '_dogsled_loaded_at', data_type: 'timestamp with time zone' },
            ],
          });
        },
      });
    }

    it.each(['evolve', 'strict'] as const)(
      'accepts the same dimension on the next load with schema_behavior %s',
      async (schemaBehavior) => {
        const client = createVectorTableClient();
        const { dest } = await createDest(createMockPool(client));
        await dest.ensureTable('public', 'embeddings', vectorColumns(3), { schemaBehavior });
        await dest.ensureTable('public', 'embeddings', vectorColumns(3), { schemaBehavior });
        const queries = vi.mocked(client.query).mock.calls.map(([sql]) => sql);
        expect(queries.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
        expect(queries.filter((sql) => sql.startsWith('ALTER TABLE'))).toEqual([]);
      }
    );

    it('refuses a changed dimension and names both types', async () => {
      const { dest } = await createDest(createMockPool(createVectorTableClient()));
      await expect(dest.ensureTable('public', 'embeddings', vectorColumns(4))).rejects.toThrow(
        'Schema change conflict on "public"."embeddings".embedding: ' +
          'existing type VECTOR(3) does not match expected vector(4)'
      );
    });

    it('accepts a new reserved table', async () => {
      const marker = 'temp-dataset-019a';
      const { dest } = await createDest(createMockPool(createVectorTableClient(marker)));
      await expect(
        dest.ensureTable('public', 'embeddings', vectorColumns(3), { tableOwnershipMarker: marker })
      ).resolves.toBeUndefined();
    });
  });

  it('ensureTable() throws a helpful error when pgvector extension cannot be created', async () => {
    const vectorColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'embedding', type: 'vector', dimension: 1536 },
    ];
    const client = createMockClient({
      queryImpl: async (sql: string) => {
        if (sql === 'CREATE EXTENSION IF NOT EXISTS vector') {
          throw new Error('permission denied');
        }
        return createMockQueryResult({ rows: [] });
      },
    });
    const pool = createMockPool(client);
    const { PostgresDestination } = await import('../../../src/runtime/destinations/postgres.js');
    const options: PostgresDestinationOptions = {
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      schema: 'public',
      username: 'testuser',
      password: 'testpass',
      poolFactory: () => pool,
    };
    const dest = new PostgresDestination(options);
    await dest.initialize();

    await expect(dest.ensureTable('public', 'embeddings', vectorColumns)).rejects.toThrow(
      /pgvector extension.*permission denied/i
    );
  });

  // ── loadAndFinalize: append ──

  it('loadAndFinalize("append") inserts records with NOW() for _dogsled_loaded_at', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    const result = await dest.loadAndFinalize(
      'public',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    // Find the INSERT query
    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    expect(insertCall).toBeDefined();
    const sql = insertCall![0] as string;
    // NOW() should be in the SQL, not in the params
    expect(sql).toContain('NOW()');
    // Params should NOT contain the string 'NOW()'
    const params = insertCall![1] as unknown[];
    expect(params).not.toContain('NOW()');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize("append") uses a single connection for all rows', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([
      { id: 1, title: 'Bug 1', _time_extracted: '2026-01-01T00:00:00Z' },
      { id: 2, title: 'Bug 2', _time_extracted: '2026-01-01T00:00:00Z' },
      { id: 3, title: 'Bug 3', _time_extracted: '2026-01-01T00:00:00Z' },
    ]);

    await dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    // pool.connect() called once in initialize() + once for the load = 2 total
    // (NOT 3 more times for each row)
    const connectCalls = (pool.connect as ReturnType<typeof vi.fn>).mock.calls.length;
    // 1 for init schema creation + 1 for the load batch
    expect(connectCalls).toBe(2);
  });

  // ── loadAndFinalize: full_refresh ──

  it('loadAndFinalize("full_refresh") TRUNCATEs on first call', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'public',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(queries.some((q) => q.includes('TRUNCATE TABLE'))).toBe(true);
  });

  it('loadAndFinalize("full_refresh") does not TRUNCATE on second call', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'public',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    // Reset call tracking for second call
    client.query.mockClear();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));

    await dest.loadAndFinalize(
      'public',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const secondCallQueries = client.query.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : ''
    );
    expect(secondCallQueries.some((q) => q.includes('TRUNCATE'))).toBe(false);
  });

  // ── loadAndFinalize: merge ──

  it('loadAndFinalize("merge") creates temp table WITHOUT schema prefix', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool, { schema: 'analytics' });

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('analytics', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createTempSql = queries.find((q) => q.includes('CREATE TEMP TABLE'));
    expect(createTempSql).toBeDefined();
    // Should NOT contain "analytics"."_dogsled_stg_issues" — just the name
    expect(createTempSql).not.toContain('"analytics"');
    expect(createTempSql).toContain('"_dogsled_stg_issues"');
  });

  it('loadAndFinalize("merge") uses NULLS LAST in ROW_NUMBER for safe dedup', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const mergeSql = queries.find((q) => q.includes('ON CONFLICT'));
    expect(mergeSql).toBeDefined();
    expect(mergeSql).toContain('NULLS LAST');
  });

  it('loadAndFinalize("merge") time guard handles NULL _time_extracted on target', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const mergeSql = queries.find((q) => q.includes('ON CONFLICT'));
    expect(mergeSql).toContain('IS NULL');
  });

  it('loadAndFinalize("merge") requires at least one key column', async () => {
    const { dest } = await createDest();
    mockFileContent([{ id: 1, title: 'Bug' }]);

    await expect(
      dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow(/merge strategy requires at least one key column/);
  });

  it('loadAndFinalize("merge") cleans up staging table even on error', async () => {
    const client = createMockClient();
    client.query.mockImplementation(async (sql: string) => {
      // Fail on the INSERT INTO staging
      if (typeof sql === 'string' && sql.includes('INSERT INTO "_dogsled_stg_')) {
        throw new Error('insert failure');
      }
      return createMockQueryResult();
    });
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await expect(
      dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', ['id'])
    ).rejects.toThrow('insert failure');

    // Check that DROP TABLE IF EXISTS was called for cleanup
    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(queries.some((q) => q.includes('DROP TABLE IF EXISTS'))).toBe(true);
  });

  it('loadAndFinalize("merge") updates _time_extracted and _dogsled_loaded_at on conflict', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('public', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const mergeSql = queries.find((q) => q.includes('ON CONFLICT'));
    expect(mergeSql).toBeDefined();
    expect(mergeSql).toContain('"_time_extracted" = S."_time_extracted"');
    expect(mergeSql).toContain('"_dogsled_loaded_at" = NOW()');
  });

  // ── Type mapping ──

  it('type mapping: integer -> BIGINT', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'test', [{ name: 'val', type: 'integer' }]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"val" BIGINT');
  });

  it('type mapping: number -> DOUBLE PRECISION', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'test', [{ name: 'val', type: 'number' }]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"val" DOUBLE PRECISION');
  });

  it('type mapping: array/object -> TEXT (JSON serialized)', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    await dest.ensureTable('public', 'test', [
      { name: 'tags', type: 'array' },
      { name: 'meta', type: 'object' },
    ]);

    const queries = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const createSql = queries.find((q) => q.startsWith('CREATE TABLE'));
    expect(createSql).toContain('"tags" TEXT');
    expect(createSql).toContain('"meta" TEXT');
  });

  // ── Lifecycle ──

  it('close() ends the pool', async () => {
    const pool = createMockPool();
    const { dest } = await createDest(pool);
    await dest.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it('cancel() destroys a checked-out client while its query is active', async () => {
    let blockQueries = false;
    let rejectQuery: ((error: Error) => void) | undefined;
    const client = createMockClient({
      queryImpl: () => {
        if (!blockQueries) return Promise.resolve(createMockQueryResult());
        return new Promise<PostgresQueryResultLike>((_resolve, reject) => {
          rejectQuery = reject;
        });
      },
    });
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);
    blockQueries = true;

    const operation = dest.ensureTable('public', 'issues', issueColumns);
    await vi.waitFor(() => expect(rejectQuery).toBeDefined());
    await dest.cancel();

    expect(client.release).toHaveBeenCalledWith(true);
    rejectQuery!(new Error('query terminated'));
    await expect(operation).rejects.toThrow('query terminated');
  });

  it('getTruncatedTables() returns a defensive copy', async () => {
    const { dest } = await createDest();
    const tables = dest.getTruncatedTables();
    tables.add('injected');
    expect(dest.getTruncatedTables().has('injected')).toBe(false);
  });

  it('omits loadFromUri so cross-warehouse routes Postgres to streaming via the optional-method check', async () => {
    const { dest } = await createDest();

    // The cross-warehouse publisher decides between staged-URI loads and
    // JSONL streaming via `typeof destination.loadFromUri === 'function'`.
    // Postgres has no native staged-URI ingest, so the method must be
    // absent — not a throwing stub, which would falsely advertise capability
    // and surface as a noisy unload-failure warning on every source.
    expect((dest as { loadFromUri?: unknown }).loadFromUri).toBeUndefined();
  });

  // ── serializeValue ──

  it('serializes array values as JSON strings', async () => {
    const client = createMockClient();
    client.query.mockResolvedValue(createMockQueryResult({ rowCount: 1 }));
    const pool = createMockPool(client);
    const { dest } = await createDest(pool);

    const cols: SchemaColumn[] = [
      { name: 'id', type: 'integer' },
      { name: 'tags', type: 'array' },
    ];

    mockFileContent([{ id: 1, tags: ['a', 'b'], _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize('public', 'test', '/tmp/data.jsonl', cols, 'append', []);

    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO')
    );
    const params = insertCall![1] as unknown[];
    // tags should be JSON-serialized
    expect(params[1]).toBe('["a","b"]');
  });
});

describe('PostgresDestination connection errors', () => {
  it('reports a failed connection without suggesting a driver install', async () => {
    const { PostgresDestination } = await import('../../../src/runtime/destinations/postgres.js');
    const destination = new PostgresDestination({
      host: '127.0.0.1',
      database: 'shop',
      username: 'loader',
      password: 'wrong',
      poolFactory: () =>
        ({
          connect: async () => {
            throw new Error('password authentication failed for user "loader"');
          },
          end: async () => undefined,
        }) as unknown as PostgresPoolLike,
    });

    await expect(destination.initialize()).rejects.toThrow(
      'Could not connect to Postgres: password authentication failed for user "loader"'
    );
    await expect(destination.initialize()).rejects.not.toThrow(/Install it/);
  });
});

describe('PostgresDestination deleteRows', () => {
  function deleteClient(
    tableOid: string | null,
    deleteImpl?: () => Promise<PostgresQueryResultLike>
  ) {
    return createMockClient({
      queryImpl: async (sql) => {
        if (sql.startsWith('SELECT to_regclass')) {
          return createMockQueryResult({ rows: [{ table_oid: tableOid }] });
        }
        if (sql.startsWith('DELETE') && deleteImpl) return deleteImpl();
        return createMockQueryResult();
      },
    });
  }

  function deleteCalls(client: PostgresPoolClientLike) {
    return vi
      .mocked(client.query)
      .mock.calls.filter((call) => String(call[0]).startsWith('DELETE'));
  }

  it('deletes matching rows with a bound array parameter', async () => {
    const client = deleteClient('public.docs');
    const { dest } = await createDest(createMockPool(client));
    const values = ["abc'); DROP TABLE x; --", 'def'];

    await dest.deleteRows('public', 'docs', 'document_id', values);

    expect(vi.mocked(client.query)).toHaveBeenCalledWith('SELECT to_regclass($1) AS table_oid', [
      '"public"."docs"',
    ]);
    expect(deleteCalls(client)).toEqual([
      ['DELETE FROM "public"."docs" WHERE "document_id" = ANY($1)', [values]],
    ]);
  });

  it('batches values over 500 per statement', async () => {
    const client = deleteClient('public.docs');
    const { dest } = await createDest(createMockPool(client));
    const values = Array.from({ length: 1201 }, (_, i) => `id-${i}`);

    await dest.deleteRows('public', 'docs', 'document_id', values);

    const batches = deleteCalls(client).map((call) => (call[1] as string[][])[0]!);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(values);
  });

  it('is a no-op when the table does not exist', async () => {
    const client = deleteClient(null);
    const { dest } = await createDest(createMockPool(client));

    await expect(dest.deleteRows('public', 'docs', 'document_id', ['a'])).resolves.toBeUndefined();
    expect(deleteCalls(client)).toHaveLength(0);
  });

  it('propagates delete errors', async () => {
    const client = deleteClient('public.docs', () =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' }))
    );
    const { dest } = await createDest(createMockPool(client));

    await expect(dest.deleteRows('public', 'docs', 'document_id', ['a'])).rejects.toThrow(
      'permission denied'
    );
  });
});
