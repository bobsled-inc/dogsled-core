import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MySqlConnectionLike,
  MySqlPoolLike,
} from '../../../src/runtime/destinations/mysql.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockConnection(
  options: { existingColumns?: Array<{ COLUMN_NAME: string; DATA_TYPE: string }> } = {}
): MySqlConnectionLike & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return Promise.resolve([options.existingColumns ?? [], []]);
    }
    return Promise.resolve([[], []]);
  });

  return {
    execute,
    release: vi.fn(),
  };
}

function createMockPool(connection?: MySqlConnectionLike): MySqlPoolLike & {
  getConnection: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const conn = connection ?? createMockConnection();
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

async function createDestination(pool?: MySqlPoolLike) {
  const p = pool ?? createMockPool();
  const { MySqlDestination } = await import('../../../src/runtime/destinations/mysql.js');
  return {
    dest: new MySqlDestination({
      host: 'localhost',
      port: 3306,
      database: 'analytics',
      user: 'test-user',
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
  vi.doUnmock('mysql2/promise');
});

describe('MySqlDestination', () => {
  it('initialize() verifies connectivity and releases the connection', async () => {
    const connection = createMockConnection();
    const pool = createMockPool(connection);
    const { dest } = await createDestination(pool);

    await dest.initialize();

    expect(connection.execute).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(connection.release).toHaveBeenCalled();
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
    expect(createStatement).toContain('`id` BIGINT');
    expect(createStatement).toContain('`title` TEXT');
    expect(createStatement).toContain('`_time_extracted` DATETIME(6)');
    expect(createStatement).toContain(
      '`_dogsled_loaded_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)'
    );
  });

  it('ensureTable() adds missing columns with ALTER TABLE', async () => {
    const connection = createMockConnection({
      existingColumns: [
        { COLUMN_NAME: 'id', DATA_TYPE: 'BIGINT' },
        { COLUMN_NAME: '_time_extracted', DATA_TYPE: 'DATETIME' },
        { COLUMN_NAME: '_dogsled_loaded_at', DATA_TYPE: 'DATETIME' },
      ],
    });
    const { dest } = await createDestination(createMockPool(connection));
    await dest.initialize();

    await dest.ensureTable('analytics', 'issues', issueColumns);

    const statements = connection.execute.mock.calls.map(([sql]) => sql as string);
    const alterStatement = statements.find((sql) => sql.startsWith('ALTER TABLE'));
    expect(alterStatement).toBeDefined();
    expect(alterStatement).toContain('ADD COLUMN `title` TEXT');
  });

  it('ensureTable() rejects incompatible type changes', async () => {
    const connection = createMockConnection({
      existingColumns: [
        { COLUMN_NAME: 'id', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'title', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_time_extracted', DATA_TYPE: 'DATETIME' },
        { COLUMN_NAME: '_dogsled_loaded_at', DATA_TYPE: 'DATETIME' },
      ],
    });
    const { dest } = await createDestination(createMockPool(connection));
    await dest.initialize();

    await expect(dest.ensureTable('analytics', 'issues', issueColumns)).rejects.toThrow(
      /Schema change conflict.*id.*TEXT.*BIGINT/i
    );
  });

  it('ensureTable() returns a structured error for unsupported vector columns', async () => {
    const { dest } = await createDestination(createMockPool(createMockConnection()));
    await dest.initialize();

    try {
      await dest.ensureTable('analytics', 'embeddings', [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'embedding', type: 'vector', dimension: 3 },
      ]);
      throw new Error('expected ensureTable to reject vector columns');
    } catch (error) {
      const payload = JSON.parse((error as Error).message) as Record<string, unknown>;
      expect(payload).toMatchObject({
        code: 'UNSUPPORTED_COLUMN_TYPE',
        destination: 'mysql',
        columnType: 'vector',
      });
    }
  });

  it('loadAndFinalize(\"append\") inserts records and keeps CURRENT_TIMESTAMP in SQL', async () => {
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
    expect(insertCall![0]).toContain('CURRENT_TIMESTAMP(6)');
    expect(insertCall![1]).not.toContain('CURRENT_TIMESTAMP(6)');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize(\"full_refresh\") truncates once per table', async () => {
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

  it('loadAndFinalize(\"merge\") uses ON DUPLICATE KEY UPDATE with the time guard', async () => {
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
      ([sql]) => typeof sql === 'string' && sql.includes('ON DUPLICATE KEY UPDATE')
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0]).toContain('VALUES(`_time_extracted`) >= `_time_extracted`');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize(\"merge\") requires key columns', async () => {
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

    expect(pool.end).toHaveBeenCalled();
  });

  it('throws a helpful error when mysql2 is unavailable', async () => {
    vi.doMock('mysql2/promise', () => {
      throw new Error('Cannot find package mysql2');
    });
    const { MySqlDestination } = await import('../../../src/runtime/destinations/mysql.js');
    const dest = new MySqlDestination({
      host: 'localhost',
      database: 'analytics',
      user: 'test-user',
      password: 'test-pass',
    });

    await expect(dest.initialize()).rejects.toThrow(/Failed to load mysql2/);
  });

  describe('deleteRows()', () => {
    function connectionWithTable(exists: boolean, deleteError?: Error) {
      const execute = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          return Promise.resolve([exists ? [{ 1: 1 }] : [], []]);
        }
        if (deleteError && sql.startsWith('DELETE')) return Promise.reject(deleteError);
        return Promise.resolve([[], []]);
      });
      return { execute, release: vi.fn() };
    }

    it('deletes matching rows with bound IN-list placeholders', async () => {
      const connection = connectionWithTable(true);
      const { dest } = await createDestination(createMockPool(connection));

      await dest.deleteRows('analytics', 'documents', 'document_id', ['a', "b'); DROP TABLE x;--"]);

      expect(connection.execute).toHaveBeenCalledWith(
        'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        ['analytics', 'documents']
      );
      expect(connection.execute).toHaveBeenCalledWith(
        'DELETE FROM `analytics`.`documents` WHERE `document_id` IN (?, ?)',
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
      const connection = connectionWithTable(true, new Error('Access denied'));
      const { dest } = await createDestination(createMockPool(connection));

      await expect(dest.deleteRows('analytics', 'documents', 'document_id', ['a'])).rejects.toThrow(
        'Access denied'
      );
    });
  });
});
