import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ClickHouseClientLike,
  ClickHouseDestinationOptions,
} from '../../../src/runtime/destinations/clickhouse.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs', () => ({ createReadStream: vi.fn() }));

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockClient(
  options: {
    existingColumns?: Array<{ name: string; type: string }>;
    sortingKey?: string;
  } = {}
): ClickHouseClientLike & {
  query: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (opts: { query: string }) => {
      if (opts.query.includes('system.columns')) {
        return { json: async () => options.existingColumns ?? [] };
      }
      if (opts.query.includes('system.tables')) {
        return {
          json: async () =>
            options.sortingKey ? [{ sorting_key: options.sortingKey }] : ([] as unknown[]),
        };
      }
      if (opts.query.includes('count()')) {
        return { json: async () => [{ cnt: 1 }] };
      }
      return { json: async () => [] as unknown[] };
    }),
    exec: vi.fn(async () => {}),
    insert: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

async function createDest(
  client?: ClickHouseClientLike,
  logger?: ClickHouseDestinationOptions['logger'],
  options: Pick<ClickHouseDestinationOptions, 'ssl' | 'vectorIndex'> = {}
) {
  const c = client ?? createMockClient();
  const factory = vi.fn(() => c);
  const { ClickHouseDestination } = await import('../../../src/runtime/destinations/clickhouse.js');
  return {
    dest: new ClickHouseDestination({
      host: 'localhost',
      port: 8443,
      database: 'test_db',
      username: 'default',
      password: 'password',
      ...options,
      connectionFactory: factory,
      logger,
    }),
    client: c as ReturnType<typeof createMockClient>,
    factory,
  };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  const content = records.map((row) => JSON.stringify(row)).join('\n');
  vi.mocked(fs.createReadStream).mockImplementation(
    () => Readable.from([content]) as ReturnType<typeof fs.createReadStream>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clickhouse/client');
});

describe('ClickHouseDestination', () => {
  describe('initialize', () => {
    it('creates database on initialize', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      expect(client.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('CREATE DATABASE IF NOT EXISTS'),
      });
      await dest.close();
    });

    it('uses an HTTPS URL when SSL is enabled', async () => {
      const createClient = vi.fn(() => ({
        query: vi.fn(),
        command: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@clickhouse/client', () => ({ createClient }));
      const { ClickHouseDestination } =
        await import('../../../src/runtime/destinations/clickhouse.js');

      const dest = new ClickHouseDestination({
        host: 'ch.example.com',
        port: 8443,
        database: 'db',
        ssl: true,
      });
      await dest.initialize();

      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'https://ch.example.com:8443',
          database: 'db',
          request_timeout: 60_000,
        })
      );
      await dest.close();
    });
  });

  describe('ensureTable', () => {
    it('creates a table with system columns when table does not exist', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      await dest.ensureTable('test_schema', 'issues', issueColumns);

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const createStatement = execCalls.find((sql: string) => sql.includes('CREATE TABLE'));
      expect(createStatement).toBeDefined();
      expect(createStatement).toContain('`id` Nullable(Int64)');
      expect(createStatement).toContain('`title` Nullable(String)');
      expect(createStatement).toContain('`_time_extracted` Nullable(DateTime64(3))');
      expect(createStatement).toContain('`_dogsled_loaded_at` Nullable(DateTime64(3))');
      expect(createStatement).toContain('MergeTree()');
      await dest.close();
    });

    it('creates ORDER BY and PARTITION BY clauses from cursor and key columns', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      await dest.ensureTable(
        'test_schema',
        'issues',
        [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
        {
          keyProperties: ['id'],
          cursorField: 'updated_at',
        }
      );

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const createStatement = execCalls.find((sql: string) => sql.includes('CREATE TABLE'));
      expect(createStatement).toContain('PARTITION BY toYYYYMM(`updated_at`)');
      expect(createStatement).toContain('ORDER BY (`updated_at`, `id`)');
      await dest.close();
    });

    it('falls back to ORDER BY tuple() when no cluster columns are available', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      await dest.ensureTable('test_schema', 'issues', issueColumns);

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const createStatement = execCalls.find((sql: string) => sql.includes('CREATE TABLE'));
      expect(createStatement).toContain('ORDER BY tuple()');
      await dest.close();
    });

    it('maps vector columns to Array(Float32)', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      await dest.ensureTable('test_schema', 'issues', [
        ...issueColumns,
        { name: 'embedding', type: 'vector', dimension: 3 },
      ]);

      const createStatement = client.exec.mock.calls
        .map(([opts]) => opts.query as string)
        .find((sql: string) => sql.includes('CREATE TABLE'));
      expect(createStatement).toContain('`embedding` Array(Float32)');
      await dest.close();
    });

    it('adds an optional vector similarity index with dimension constraints', async () => {
      const { dest, client } = await createDest(undefined, undefined, { vectorIndex: true });
      await dest.initialize();

      await dest.ensureTable('test_schema', 'issues', [
        ...issueColumns,
        {
          name: 'embedding',
          type: 'vector',
          dimension: 3,
          embedded_from: {
            column: 'title',
            provider: 'openai',
            model: 'text-embedding-3-small',
            distance_metric: 'l2',
          },
        },
      ]);

      const createStatement = client.exec.mock.calls
        .map(([opts]) => opts.query as string)
        .find((sql: string) => sql.includes('CREATE TABLE'));
      expect(createStatement).toContain('CHECK length(`embedding`) = 3');
      expect(createStatement).toContain("TYPE vector_similarity('hnsw', 'L2Distance', 3)");
      await dest.close();
    });

    it('treats existing Array(Float32) as compatible with a vector column', async () => {
      const client = createMockClient({
        existingColumns: [
          { name: 'id', type: 'Int64' },
          { name: 'title', type: 'String' },
          { name: 'embedding', type: 'Array(Float32)' },
          { name: '_time_extracted', type: 'DateTime64(3)' },
          { name: '_dogsled_loaded_at', type: 'DateTime64(3)' },
        ],
      });
      const { dest } = await createDest(client);
      await dest.initialize();

      await expect(
        dest.ensureTable('test_schema', 'issues', [
          ...issueColumns,
          { name: 'embedding', type: 'vector', dimension: 3 },
        ])
      ).resolves.toBeUndefined();
      await dest.close();
    });

    it('adds missing columns with ALTER TABLE', async () => {
      const client = createMockClient({
        existingColumns: [
          { name: 'id', type: 'Int64' },
          { name: '_time_extracted', type: 'DateTime64(3)' },
          { name: '_dogsled_loaded_at', type: 'DateTime64(3)' },
        ],
      });
      const { dest } = await createDest(client);
      await dest.initialize();

      await dest.ensureTable('test_schema', 'issues', issueColumns);

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const alterStatement = execCalls.find((sql: string) => sql.includes('ALTER TABLE'));
      expect(alterStatement).toBeDefined();
      expect(alterStatement).toContain('ADD COLUMN `title` Nullable(String)');
      await dest.close();
    });

    it('rejects incompatible type changes', async () => {
      const client = createMockClient({
        existingColumns: [
          { name: 'id', type: 'Nullable(String)' },
          { name: 'title', type: 'Nullable(String)' },
          { name: '_time_extracted', type: 'Nullable(DateTime64(3))' },
          { name: '_dogsled_loaded_at', type: 'Nullable(DateTime64(3))' },
        ],
      });
      const { dest } = await createDest(client);
      await dest.initialize();

      await expect(dest.ensureTable('test_schema', 'issues', issueColumns)).rejects.toThrow(
        /Schema change conflict.*id.*String.*Int64/i
      );
      await dest.close();
    });

    it('warns when existing ORDER BY differs from the requested clustering', async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), metric: vi.fn() };
      const client = createMockClient({
        existingColumns: [
          { name: 'id', type: 'Int64' },
          { name: 'title', type: 'String' },
          { name: 'updated_at', type: 'DateTime64(3)' },
          { name: '_time_extracted', type: 'DateTime64(3)' },
          { name: '_dogsled_loaded_at', type: 'DateTime64(3)' },
        ],
        sortingKey: 'id',
      });
      const { dest } = await createDest(client, logger);
      await dest.initialize();

      await dest.ensureTable(
        'test_schema',
        'issues',
        [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
        {
          keyProperties: ['id'],
          cursorField: 'updated_at',
        }
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'clickhouse_order_by_mismatch',
        expect.objectContaining({
          stream: 'issues',
          currentOrderBy: ['id'],
          desiredOrderBy: ['updated_at', 'id'],
        })
      );
      await dest.close();
    });
  });

  describe('loadAndFinalize', () => {
    it('append inserts structured JSONEachRow records with loaded timestamps', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

      const result = await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'append',
        []
      );

      expect(client.insert).toHaveBeenCalledWith({
        table: '`test_schema`.`issues`',
        values: [
          expect.objectContaining({
            id: 1,
            title: 'Bug',
            _time_extracted: '2026-01-01T00:00:00Z',
            _dogsled_loaded_at: expect.any(String),
          }),
        ],
        format: 'JSONEachRow',
        clickhouse_settings: { date_time_input_format: 'best_effort' },
      });
      expect(result.rowsAffected).toBe(1);
      await dest.close();
    });

    it('full_refresh truncates once per table', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'full_refresh',
        []
      );
      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'full_refresh',
        []
      );

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const truncateCalls = execCalls.filter((sql: string) => sql.startsWith('TRUNCATE TABLE'));
      expect(truncateCalls).toHaveLength(1);
      await dest.close();
    });

    it('merge uses staging table with delete-then-insert pattern', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

      const result = await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'merge',
        ['id']
      );

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);

      const createStaging = execCalls.find(
        (sql: string) => sql.includes('CREATE TABLE') && sql.includes('_dogsled_stg_')
      );
      expect(createStaging).toBeDefined();

      const deleteStatement = execCalls.find(
        (sql: string) => sql.includes('ALTER TABLE') && sql.includes('DELETE WHERE')
      );
      expect(deleteStatement).toBeDefined();

      const insertStatement = execCalls.find(
        (sql: string) => sql.startsWith('INSERT INTO') && sql.includes('SELECT')
      );
      expect(insertStatement).toBeDefined();

      const dropStaging = execCalls.find(
        (sql: string) => sql.includes('DROP TABLE IF EXISTS') && sql.includes('_dogsled_stg_')
      );
      expect(dropStaging).toBeDefined();

      expect(result.rowsAffected).toBe(1);
      await dest.close();
    });

    it('merge DELETE uses mutations_sync = 1 for synchronous execution', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'merge',
        ['id']
      );

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const deleteStatement = execCalls.find((sql: string) => sql.startsWith('ALTER TABLE'));
      expect(deleteStatement).toBeDefined();
      expect(deleteStatement).toContain('SETTINGS mutations_sync = 1');
      await dest.close();
    });

    it('merge builds a winners table with in-batch deduplication and a time guard', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([
        { id: 1, title: 'old', _time_extracted: '2026-01-01T00:00:00Z' },
        { id: 1, title: 'new', _time_extracted: '2026-01-02T00:00:00Z' },
      ]);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'merge',
        ['id']
      );

      const execCalls = client.exec.mock.calls.map(([opts]) => opts.query as string);
      const winners = execCalls.find(
        (sql) => sql.includes('_dogsled_win_') && sql.startsWith('CREATE TABLE')
      );
      expect(winners).toContain('LIMIT 1 BY `id`');
      expect(winners).toContain('ORDER BY `_time_extracted` DESC NULLS LAST');
      expect(winners).toContain('WHERE (`id`) IN (SELECT `id` FROM `test_schema`.`_dogsled_stg_');
      expect(winners).toContain('D.`_time_extracted` >= T.`_time_extracted`');
      expect(winners).toContain('SETTINGS join_use_nulls = 1');
      const del = execCalls.find((sql) => sql.includes('DELETE WHERE'));
      expect(del).toContain('FROM `test_schema`.`_dogsled_win_');
      const ins = execCalls.find((sql) => sql.startsWith('INSERT INTO `test_schema`.`issues`'));
      expect(ins).toContain('FROM `test_schema`.`_dogsled_win_');
      await dest.close();
    });

    it('merge drops both scratch tables even when the INSERT fails', async () => {
      const client = createMockClient();
      client.exec.mockImplementation(async ({ query }: { query: string }) => {
        if (query.startsWith('INSERT INTO `test_schema`.`issues`')) {
          throw new Error('boom');
        }
      });
      const { dest } = await createDest(client);
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'x', _time_extracted: '2026-01-01T00:00:00Z' }]);

      await expect(
        dest.loadAndFinalize('test_schema', 'issues', '/tmp/issues.jsonl', issueColumns, 'merge', [
          'id',
        ])
      ).rejects.toThrow('boom');

      const drops = client.exec.mock.calls
        .map(([opts]) => opts.query as string)
        .filter((sql) => sql.startsWith('DROP TABLE IF EXISTS'));
      expect(drops.some((sql) => sql.includes('_dogsled_stg_'))).toBe(true);
      expect(drops.some((sql) => sql.includes('_dogsled_win_'))).toBe(true);
    });

    it('merge requires key columns', async () => {
      const { dest } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

      await expect(
        dest.loadAndFinalize(
          'test_schema',
          'issues',
          '/tmp/issues.jsonl',
          issueColumns,
          'merge',
          []
        )
      ).rejects.toThrow('merge strategy requires at least one key column');
      await dest.close();
    });

    it('returns zero rows for empty file', async () => {
      const { dest } = await createDest();
      await dest.initialize();
      mockFileContent([]);

      const result = await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'append',
        []
      );

      expect(result.rowsAffected).toBe(0);
      await dest.close();
    });

    it('batches inserts into chunks of 500', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      const records = Array.from({ length: 750 }, (_, i) => ({
        id: i,
        title: `Issue ${i}`,
        _time_extracted: '2026-01-01T00:00:00Z',
      }));
      mockFileContent(records);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'append',
        []
      );

      const insertCalls = client.insert.mock.calls.map(([opts]) => opts);

      expect(insertCalls.length).toBe(2);

      const firstBatch = insertCalls[0];
      expect(firstBatch.table).toBe('`test_schema`.`issues`');
      expect(firstBatch.values).toHaveLength(500);

      const secondBatch = insertCalls[1];
      expect(secondBatch.values).toHaveLength(250);

      await dest.close();
    });

    it('merge batches staging table inserts into chunks of 500', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      const records = Array.from({ length: 750 }, (_, i) => ({
        id: i,
        title: `Issue ${i}`,
        _time_extracted: '2026-01-01T00:00:00Z',
      }));
      mockFileContent(records);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'merge',
        ['id']
      );

      const stagingInsertCalls = client.insert.mock.calls
        .map(([opts]) => opts)
        .filter((opts) => opts.table.includes('_dogsled_stg_'));

      expect(stagingInsertCalls.length).toBe(2);

      const firstBatch = stagingInsertCalls[0];
      expect(firstBatch.values).toHaveLength(500);

      const secondBatch = stagingInsertCalls[1];
      expect(secondBatch.values).toHaveLength(250);

      await dest.close();
    });

    it('keeps string values out of generated SQL', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([
        { id: 1, title: "O'Reilly\\drop", _time_extracted: '2026-01-01T00:00:00Z' },
      ]);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'append',
        []
      );

      const insertRow = client.insert.mock.calls[0]?.[0].values[0];
      expect(insertRow).toMatchObject({ title: "O'Reilly\\drop" });
      expect(client.exec.mock.calls.map(([opts]) => opts.query as string).join('\n')).not.toContain(
        "O'Reilly\\drop"
      );
      await dest.close();
    });

    it('handles null and undefined values', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, _time_extracted: '2026-01-01T00:00:00Z' }]);

      await dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'append',
        []
      );

      const insertRow = client.insert.mock.calls[0]?.[0].values[0];
      expect(insertRow).toMatchObject({ title: null });
      await dest.close();
    });

    it('rejects null vector values with a validation error', async () => {
      const { dest } = await createDest();
      await dest.initialize();
      mockFileContent([{ id: 1, title: 'Bug', embedding: null }]);

      await expect(
        dest.loadAndFinalize(
          'test_schema',
          'issues',
          '/tmp/issues.jsonl',
          [...issueColumns, { name: 'embedding', type: 'vector', dimension: 3 }],
          'append',
          []
        )
      ).rejects.toMatchObject({ exitCode: 2 });
      await dest.close();
    });
  });

  describe('close', () => {
    it('closes client connection', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();
      await dest.close();
      expect(client.close).toHaveBeenCalled();
    });
  });

  describe('getTruncatedTables / setTruncatedTables', () => {
    it('returns and accepts truncated tables set', async () => {
      const { dest } = await createDest();
      const tables = new Set(['schema.table1', 'schema.table2']);
      dest.setTruncatedTables(tables);
      expect(dest.getTruncatedTables()).toEqual(tables);
    });

    it('returns empty set initially', async () => {
      const { dest } = await createDest();
      expect(dest.getTruncatedTables().size).toBe(0);
    });
  });

  describe('deleteRows', () => {
    const deleteCalls = (client: ReturnType<typeof createMockClient>) =>
      client.exec.mock.calls
        .map(([opts]) => opts as { query: string; query_params?: { values: string[] } })
        .filter((opts) => opts.query.includes(' DELETE WHERE '));

    it('runs a synchronous ALTER DELETE with bound array parameters', async () => {
      const { dest, client } = await createDest(createMockClient({ sortingKey: 'id' }));
      await dest.initialize();

      await dest.deleteRows('test_schema', 'docs', 'document_id', ["a'b", 'c']);

      expect(client.query).toHaveBeenCalledWith({
        query: expect.stringContaining(
          "FROM system.tables WHERE database = 'test_schema' AND name = 'docs'"
        ),
      });
      expect(deleteCalls(client)).toEqual([
        {
          query:
            'ALTER TABLE `test_schema`.`docs` DELETE WHERE has({values:Array(String)}, `document_id`) SETTINGS mutations_sync = 2',
          query_params: { values: ["a'b", 'c'] },
        },
      ]);
    });

    it('batches values 500 per statement', async () => {
      const { dest, client } = await createDest(createMockClient({ sortingKey: 'id' }));
      await dest.initialize();

      const values = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
      await dest.deleteRows('test_schema', 'docs', 'document_id', values);

      const batches = deleteCalls(client).map((opts) => opts.query_params!.values);
      expect(batches.map((b) => b.length)).toEqual([500, 500, 1]);
      expect(batches.flat()).toEqual(values);
    });

    it('is a no-op when the table does not exist', async () => {
      const { dest, client } = await createDest();
      await dest.initialize();

      await dest.deleteRows('test_schema', 'missing', 'document_id', ['a']);

      expect(deleteCalls(client)).toEqual([]);
    });

    it('propagates delete errors', async () => {
      const client = createMockClient({ sortingKey: 'id' });
      client.exec.mockImplementation(async (opts: { query: string }) => {
        if (opts.query.includes(' DELETE WHERE ')) throw new Error('ACCESS_DENIED');
      });
      const { dest } = await createDest(client);
      await dest.initialize();

      await expect(dest.deleteRows('test_schema', 'docs', 'document_id', ['a'])).rejects.toThrow(
        'ACCESS_DENIED'
      );
    });

    it('forwards query_params to the SDK command in the default adapter', async () => {
      const command = vi.fn().mockResolvedValue(undefined);
      const createClient = vi.fn(() => ({
        query: vi.fn().mockResolvedValue({ json: async () => [{ '1': 1 }] }),
        command,
        insert: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@clickhouse/client', () => ({ createClient }));
      const { ClickHouseDestination } =
        await import('../../../src/runtime/destinations/clickhouse.js');
      const dest = new ClickHouseDestination({ host: 'ch.example.com', database: 'db' });
      await dest.initialize();

      await dest.deleteRows('db', 'docs', 'document_id', ['a']);

      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ query_params: { values: ['a'] } })
      );
      await dest.close();
    });
  });
});
