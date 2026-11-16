import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MsSqlConnectionLike,
  MsSqlConnectionPoolLike,
} from '../../../src/runtime/destinations/mssql.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockConnection(
  options: { existingColumns?: Array<{ COLUMN_NAME: string; DATA_TYPE: string }> } = {}
): MsSqlConnectionLike & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return Promise.resolve([options.existingColumns ?? [], {}]);
    }
    return Promise.resolve([[], {}]);
  });

  return {
    execute,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPool(connection?: MsSqlConnectionLike): MsSqlConnectionPoolLike & {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const conn = connection ?? createMockConnection();
  return {
    acquire: vi.fn().mockResolvedValue(conn),
    release: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function createDestination(pool?: MsSqlConnectionPoolLike) {
  const p = pool ?? createMockPool();
  const { MsSqlDestination } = await import('../../../src/runtime/destinations/mssql.js');
  return {
    dest: new MsSqlDestination({
      host: 'localhost',
      port: 1433,
      database: 'analytics',
      username: 'sa',
      password: 'test-pass',
      pool: p,
    }),
    pool: p,
  };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((row) => JSON.stringify(row)).join('\n'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('tedious');
});

describe('MsSqlDestination', () => {
  it('initialize() verifies connectivity and releases the connection', async () => {
    const connection = createMockConnection();
    const pool = createMockPool(connection);
    const { dest } = await createDestination(pool);

    await dest.initialize();

    expect(connection.execute).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(pool.release).toHaveBeenCalled();
  });

  it('ensureTable() creates a table with system columns', async () => {
    const connection = createMockConnection();
    const pool = createMockPool(connection);
    const { dest } = await createDestination(pool);
    await dest.initialize();

    await dest.ensureTable('analytics', 'issues', issueColumns);

    const statements = connection.execute.mock.calls.map(([sql]) => sql as string);
    const createStatement = statements.find((sql) => sql.startsWith('CREATE TABLE'));
    expect(createStatement).toBeDefined();
    expect(createStatement).toContain('[id] BIGINT');
    expect(createStatement).toContain('[title] NVARCHAR(4000)');
    expect(createStatement).toContain('[_time_extracted] DATETIME2(6)');
    expect(createStatement).toContain('[_bobsled_loaded_at] DATETIME2(6)');
  });

  it('ensureTable() adds missing columns with ALTER TABLE', async () => {
    const connection = createMockConnection({
      existingColumns: [
        { COLUMN_NAME: 'id', DATA_TYPE: 'BIGINT' },
        { COLUMN_NAME: '_time_extracted', DATA_TYPE: 'DATETIME2' },
        { COLUMN_NAME: '_bobsled_loaded_at', DATA_TYPE: 'DATETIME2' },
      ],
    });
    const { dest } = await createDestination(createMockPool(connection));
    await dest.initialize();

    await dest.ensureTable('analytics', 'issues', issueColumns);

    const statements = connection.execute.mock.calls.map(([sql]) => sql as string);
    const alterStatement = statements.find((sql) => sql.startsWith('ALTER TABLE'));
    expect(alterStatement).toBeDefined();
    expect(alterStatement).toContain('ADD [title] NVARCHAR(4000)');
  });

  it('ensureTable() rejects incompatible type changes', async () => {
    const connection = createMockConnection({
      existingColumns: [
        { COLUMN_NAME: 'id', DATA_TYPE: 'NVARCHAR' },
        { COLUMN_NAME: 'title', DATA_TYPE: 'NVARCHAR' },
        { COLUMN_NAME: '_time_extracted', DATA_TYPE: 'DATETIME2' },
        { COLUMN_NAME: '_bobsled_loaded_at', DATA_TYPE: 'DATETIME2' },
      ],
    });
    const { dest } = await createDestination(createMockPool(connection));
    await dest.initialize();

    await expect(dest.ensureTable('analytics', 'issues', issueColumns)).rejects.toThrow(
      /Schema change conflict.*id.*NVARCHAR.*BIGINT/i
    );
  });

  it('loadAndFinalize("append") inserts records with SYSDATETIME', async () => {
    const connection = createMockConnection();
    const { dest } = await createDestination(createMockPool(connection));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    const result = await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'append',
      []
    );

    const insertCall = connection.execute.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain('SYSDATETIME()');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize("full_refresh") truncates once per table', async () => {
    const connection = createMockConnection();
    const { dest } = await createDestination(createMockPool(connection));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'full_refresh',
      []
    );
    await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const truncateCalls = connection.execute.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.startsWith('TRUNCATE TABLE')
    );
    expect(truncateCalls).toHaveLength(1);
  });

  it('loadAndFinalize("merge") uses MERGE statement with staging table', async () => {
    const connection = createMockConnection();
    const { dest } = await createDestination(createMockPool(connection));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    const result = await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    const mergeCall = connection.execute.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('MERGE')
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0]).toContain('MERGE');
    expect(mergeCall![0]).toContain('WITH (HOLDLOCK)');
    expect(mergeCall![0]).toContain('WHEN MATCHED THEN UPDATE');
    expect(mergeCall![0]).toContain('WHEN NOT MATCHED THEN INSERT');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize("merge") requires key columns', async () => {
    const { dest } = await createDestination();
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await expect(
      dest.loadAndFinalize('analytics', 'issues', '/tmp/issues.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow(/merge strategy requires at least one key column/);
  });

  it('close() shuts down the pool', async () => {
    const pool = createMockPool();
    const { dest } = await createDestination(pool);

    await dest.close();

    expect(pool.close).toHaveBeenCalled();
  });

  it('throws a helpful error when tedious is unavailable', async () => {
    vi.doMock('tedious', () => {
      throw new Error('Cannot find package tedious');
    });
    const { MsSqlDestination } = await import('../../../src/runtime/destinations/mssql.js');
    const dest = new MsSqlDestination({
      host: 'localhost',
      database: 'analytics',
    });

    await expect(dest.initialize()).rejects.toThrow(/Failed to load tedious/);
  });

  it('getTruncatedTables() and setTruncatedTables() work correctly', async () => {
    const { dest } = await createDestination();

    const tables = dest.getTruncatedTables();
    expect(tables.size).toBe(0);

    const newTables = new Set<string>(['dbo.issues']);
    dest.setTruncatedTables(newTables);
    expect(dest.getTruncatedTables()).toEqual(newTables);
  });

  describe('deleteRows()', () => {
    function connectionWithTable(exists: boolean, deleteError?: Error) {
      const execute = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          return Promise.resolve([exists ? [{ 1: 1 }] : [], {}]);
        }
        if (deleteError && sql.startsWith('DELETE')) return Promise.reject(deleteError);
        return Promise.resolve([[], {}]);
      });
      return { execute, close: vi.fn().mockResolvedValue(undefined) };
    }

    it('deletes matching rows with bound IN-list placeholders', async () => {
      const connection = connectionWithTable(true);
      const { dest } = await createDestination(createMockPool(connection));

      await dest.deleteRows('analytics', 'documents', 'document_id', ['a', "b'); DROP TABLE x;--"]);

      expect(connection.execute).toHaveBeenCalledWith(
        'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1',
        ['analytics', 'documents']
      );
      expect(connection.execute).toHaveBeenCalledWith(
        'DELETE FROM [analytics].[documents] WHERE [document_id] IN (@p0, @p1)',
        ['a', "b'); DROP TABLE x;--"]
      );
    });

    it('batches values over 500 per statement', async () => {
      const connection = connectionWithTable(true);
      const { dest } = await createDestination(createMockPool(connection));
      const values = Array.from({ length: 1001 }, (_, i) => `doc-${i}`);

      await dest.deleteRows('analytics', 'documents', 'document_id', values);

      const deletes = connection.execute.mock.calls.filter(([sql]) =>
        String(sql).startsWith('DELETE')
      );
      expect(deletes.map(([, params]) => (params as string[]).length)).toEqual([500, 500, 1]);
      expect(deletes.flatMap(([, params]) => params as string[])).toEqual(values);
      expect(String(deletes[2]![0])).toContain('IN (@p0)');
    });

    it('is a no-op when the table does not exist', async () => {
      const connection = connectionWithTable(false);
      const { dest } = await createDestination(createMockPool(connection));

      await expect(
        dest.deleteRows('analytics', 'documents', 'document_id', ['a'])
      ).resolves.toBeUndefined();

      expect(connection.execute).toHaveBeenCalledTimes(1);
    });

    it('propagates delete errors', async () => {
      const connection = connectionWithTable(true, new Error('Permission denied'));
      const { dest } = await createDestination(createMockPool(connection));

      await expect(dest.deleteRows('analytics', 'documents', 'document_id', ['a'])).rejects.toThrow(
        'Permission denied'
      );
    });
  });
});
