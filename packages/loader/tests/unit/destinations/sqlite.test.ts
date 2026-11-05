import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDestination } from '../../../src/runtime/destinations/sqlite.js';
import { makeIssueRecord, issueColumns } from '../../helpers/fixtures.js';
import { writeJsonl } from '../../helpers/jsonl.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

type BetterSqlite3Module = typeof import('better-sqlite3');

const hasSqlite = await (async () => {
  try {
    const module = await import('better-sqlite3');
    new module.default(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

let Database: BetterSqlite3Module['default'];

function queryDb(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new Database(dbPath);
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe.skipIf(!hasSqlite)('SqliteDestination', () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(async () => {
    Database = (await import('better-sqlite3')).default;
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-dest-'));
    dbPath = path.join(tempDir, 'test.sqlite');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initialize() creates database file with WAL mode', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.close();

    const stat = await fs.stat(dbPath);
    expect(stat.isFile()).toBe(true);

    // Verify WAL mode was set
    const db = new Database(dbPath);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0]?.journal_mode).toBe('wal');
    db.close();
  });

  it('ensureTable() creates table with correct column types including system columns', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);
    await dest.close();

    const rows = queryDb(dbPath, `PRAGMA table_info(issues)`);
    const columnNames = rows.map((r) => r['name']);
    const columnTypes = rows.map((r) => r['type']);

    expect(columnNames).toEqual(['id', 'title', '_time_extracted', '_dogsled_loaded_at']);
    expect(columnTypes).toEqual(['INTEGER', 'TEXT', 'TEXT', 'TEXT']);
  });

  it('ensureTable() on existing table with new columns adds them via ALTER TABLE', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);

    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];
    await dest.ensureTable('main', 'issues', extendedColumns);
    await dest.close();

    const rows = queryDb(dbPath, `PRAGMA table_info(issues)`);
    const columnNames = rows.map((r) => r['name']);
    expect(columnNames).toEqual(['id', 'title', '_time_extracted', '_dogsled_loaded_at', 'status']);
  });

  it('ensureTable() on type change throws error for non-widenable types', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);

    // Change title from string to integer (narrowing)
    const changedColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'integer' },
    ];

    await expect(dest.ensureTable('main', 'issues', changedColumns)).rejects.toThrow(
      /schema change conflict/i
    );
    await dest.close();
  });

  it('ensureTable() with strict schemaBehavior rejects new columns', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);

    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];
    await expect(
      dest.ensureTable('main', 'issues', extendedColumns, { schemaBehavior: 'strict' })
    ).rejects.toThrow(/schema contract violation.*strict/i);
    await dest.close();
  });

  it('ensureTable() returns a structured error for unsupported vector columns', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();

    try {
      await dest.ensureTable('main', 'embeddings', [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'embedding', type: 'vector', dimension: 3 },
      ]);
      throw new Error('expected ensureTable to reject vector columns');
    } catch (error) {
      const payload = JSON.parse((error as Error).message) as Record<string, unknown>;
      expect(payload).toMatchObject({
        code: 'UNSUPPORTED_COLUMN_TYPE',
        destination: 'sqlite',
        columnType: 'vector',
      });
    } finally {
      await dest.close();
    }
  });

  it('loadAndFinalize() append inserts records', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [
      makeIssueRecord(1, 'First', '2026-01-01T00:00:00Z'),
      makeIssueRecord(2, 'Second', '2026-01-01T00:00:00Z'),
    ]);

    const result = await dest.loadAndFinalize(
      'main',
      'issues',
      jsonlPath,
      issueColumns,
      'append',
      []
    );
    expect(result.rowsAffected).toBe(2);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ]);
  });

  it('loadAndFinalize() append sets _time_extracted and _dogsled_loaded_at', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [makeIssueRecord(1, 'First', '2026-01-01T12:00:00Z')]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT _time_extracted, _dogsled_loaded_at FROM issues`);
    expect(rows[0]?.['_time_extracted']).toBe('2026-01-01T12:00:00Z');
    expect(rows[0]?.['_dogsled_loaded_at']).toBeTruthy();
  });

  it('loadAndFinalize() full_refresh truncates and reloads', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // Insert initial data
    const jsonl1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(jsonl1, [makeIssueRecord(1, 'Old', '2026-01-01T00:00:00Z')]);
    await dest.loadAndFinalize('main', 'issues', jsonl1, issueColumns, 'append', []);

    // Full refresh replaces everything
    const jsonl2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(jsonl2, [makeIssueRecord(2, 'New', '2026-01-02T00:00:00Z')]);
    await dest.loadAndFinalize('main', 'issues', jsonl2, issueColumns, 'full_refresh', []);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues`);
    expect(rows).toEqual([{ id: 2, title: 'New' }]);
  });

  it('loadAndFinalize() full_refresh only truncates once per table', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonl1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(jsonl1, [makeIssueRecord(1, 'First', '2026-01-01T00:00:00Z')]);
    await dest.loadAndFinalize('main', 'issues', jsonl1, issueColumns, 'full_refresh', []);

    // Second full_refresh batch appends (doesn't truncate again)
    const jsonl2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(jsonl2, [makeIssueRecord(2, 'Second', '2026-01-02T00:00:00Z')]);
    await dest.loadAndFinalize('main', 'issues', jsonl2, issueColumns, 'full_refresh', []);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ]);
  });

  it('loadAndFinalize() merge upserts by key columns', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns, { keyProperties: ['id'] });

    // Insert initial
    const jsonl1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(jsonl1, [
      makeIssueRecord(1, 'Original', '2026-01-01T00:00:00Z'),
      makeIssueRecord(2, 'Keep', '2026-01-01T00:00:00Z'),
    ]);
    await dest.loadAndFinalize('main', 'issues', jsonl1, issueColumns, 'append', []);

    // Merge: update id=1, insert id=3
    const jsonl2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(jsonl2, [
      makeIssueRecord(1, 'Updated', '2026-01-02T00:00:00Z'),
      makeIssueRecord(3, 'New', '2026-01-02T00:00:00Z'),
    ]);
    const result = await dest.loadAndFinalize('main', 'issues', jsonl2, issueColumns, 'merge', [
      'id',
    ]);
    expect(result.rowsAffected).toBeGreaterThan(0);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, title: 'Updated' },
      { id: 2, title: 'Keep' },
      { id: 3, title: 'New' },
    ]);
  });

  it('loadAndFinalize() merge deduplicates staging records', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns, { keyProperties: ['id'] });

    // Two records with same key — latest _time_extracted wins
    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [
      makeIssueRecord(1, 'Old', '2026-01-01T00:00:00Z'),
      makeIssueRecord(1, 'New', '2026-01-02T00:00:00Z'),
    ]);
    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues`);
    expect(rows).toEqual([{ id: 1, title: 'New' }]);
  });

  it('loadAndFinalize() merge breaks timestamp ties by latest rowid', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns, { keyProperties: ['id'] });

    const jsonlPath = path.join(tempDir, 'ties.jsonl');
    await writeJsonl(jsonlPath, [
      makeIssueRecord(1, 'First', '2026-01-02T00:00:00Z'),
      makeIssueRecord(1, 'Second', '2026-01-02T00:00:00Z'),
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, title FROM issues`);
    expect(rows).toEqual([{ id: 1, title: 'Second' }]);
  });

  it('loadAndFinalize() merge requires key columns', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, title: 'Test', _time_extracted: '2026-01-01T00:00:00Z' },
    ]);

    await expect(
      dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', [])
    ).rejects.toThrow(/merge strategy requires at least one key column/);
    await dest.close();
  });

  it('loadAndFinalize() handles empty file gracefully', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'empty.jsonl');
    await fs.writeFile(jsonlPath, '\n');

    const result = await dest.loadAndFinalize(
      'main',
      'issues',
      jsonlPath,
      issueColumns,
      'append',
      []
    );
    expect(result.rowsAffected).toBe(0);
    await dest.close();
  });

  it('loadAndFinalize() handles boolean values as integers', async () => {
    const boolColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'active', type: 'boolean' },
    ];
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'flags', boolColumns);

    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, active: true, _time_extracted: '2026-01-01T00:00:00Z' },
      { id: 2, active: false, _time_extracted: '2026-01-01T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'flags', jsonlPath, boolColumns, 'append', []);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, active FROM flags ORDER BY id`);
    expect(rows).toEqual([
      { id: 1, active: 1 },
      { id: 2, active: 0 },
    ]);
  });

  it('loadAndFinalize() handles array and object types as JSON text', async () => {
    const complexColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'tags', type: 'array' },
      { name: 'metadata', type: 'object' },
    ];
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'items', complexColumns);

    const jsonlPath = path.join(tempDir, 'data.jsonl');
    await writeJsonl(jsonlPath, [
      {
        id: 1,
        tags: ['a', 'b'],
        metadata: { key: 'val' },
        _time_extracted: '2026-01-01T00:00:00Z',
      },
    ]);
    await dest.loadAndFinalize('main', 'items', jsonlPath, complexColumns, 'append', []);
    await dest.close();

    const rows = queryDb(dbPath, `SELECT id, tags, metadata FROM items`);
    expect(rows[0]?.['tags']).toBe('["a","b"]');
    expect(rows[0]?.['metadata']).toBe('{"key":"val"}');
  });

  it('close() handles double close gracefully', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.close();
    // Second close should not throw
    await dest.close();
  });

  it('getTruncatedTables() and setTruncatedTables() manage checkpoint state', async () => {
    const dest = new SqliteDestination({ dbPath });
    expect(dest.getTruncatedTables().size).toBe(0);

    const tables = new Set(['main.issues', 'main.users']);
    dest.setTruncatedTables(tables);
    expect(dest.getTruncatedTables()).toEqual(tables);

    // Returns a copy, not the original
    dest.getTruncatedTables().add('main.extra');
    expect(dest.getTruncatedTables().size).toBe(2);
  });

  it('staging table is cleaned up even on error', async () => {
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns, { keyProperties: ['id'] });

    // Write malformed JSONL to trigger error during merge
    const jsonlPath = path.join(tempDir, 'bad.jsonl');
    await fs.writeFile(jsonlPath, 'not valid json\n');

    await expect(
      dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', ['id'])
    ).rejects.toThrow();
    await dest.close();

    // Verify no staging tables remain
    const tables = queryDb(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_dogsled_stg_%'`
    );
    expect(tables).toEqual([]);
  });

  describe('deleteRows()', () => {
    const docColumns: SchemaColumn[] = [
      { name: 'document_id', type: 'string' },
      { name: 'chunk', type: 'string' },
    ];

    async function seed(dest: SqliteDestination, ids: string[]): Promise<void> {
      await dest.ensureTable('main', 'documents', docColumns);
      const file = path.join(tempDir, 'docs.jsonl');
      await writeJsonl(
        file,
        ids.map((id, i) => ({ document_id: id, chunk: `c${i}` }))
      );
      await dest.loadAndFinalize('main', 'documents', file, docColumns, 'append', []);
    }

    it('deletes only rows whose column matches a bound value', async () => {
      const dest = new SqliteDestination({ dbPath });
      await dest.initialize();
      const tricky = "b'); DROP TABLE documents;--";
      await seed(dest, ['a', tricky, 'keep']);

      await dest.deleteRows('main', 'documents', 'document_id', ['a', tricky]);
      await dest.close();

      const rows = queryDb(dbPath, 'SELECT document_id FROM documents');
      expect(rows).toEqual([{ document_id: 'keep' }]);
    });

    it('batches values over 500 per statement', async () => {
      const dest = new SqliteDestination({ dbPath });
      await dest.initialize();
      const ids = Array.from({ length: 1001 }, (_, i) => `doc-${i}`);
      await seed(dest, [...ids, 'keep']);

      await dest.deleteRows('main', 'documents', 'document_id', ids);
      await dest.close();

      expect(queryDb(dbPath, 'SELECT document_id FROM documents')).toEqual([
        { document_id: 'keep' },
      ]);
    });

    it('is a no-op when the table does not exist', async () => {
      const dest = new SqliteDestination({ dbPath });
      await dest.initialize();

      await expect(
        dest.deleteRows('main', 'documents', 'document_id', ['a'])
      ).resolves.toBeUndefined();
      await dest.close();
    });

    it('propagates errors such as an unknown column', async () => {
      const dest = new SqliteDestination({ dbPath });
      await dest.initialize();
      await seed(dest, ['a']);

      await expect(dest.deleteRows('main', 'documents', 'missing_col', ['a'])).rejects.toThrow(
        /no such column/
      );
      await dest.close();
    });
  });
});
