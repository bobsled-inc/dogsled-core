import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DuckDbDestination } from '../../../src/runtime/destinations/duckdb.js';
import { sanitizeTableName } from '../../../src/runtime/destinations/database.js';
import { queryPersistentDb, queryRows } from '../../helpers/duckdb.js';
import { makeIssueRecord, issueColumns } from '../../helpers/fixtures.js';
import { writeJsonl } from '../../helpers/jsonl.js';

import type {
  DuckDbConnectionLike,
  DuckDbDatabaseLike,
} from '../../../src/runtime/duckdb-primitives.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

describe('DuckDbDestination', () => {
  it('latches cancellation before initialization without opening the database', async () => {
    const databaseFactory = vi.fn();
    const dest = new DuckDbDestination({ dbPath, databaseFactory });

    await expect(dest.cancel()).resolves.toBeUndefined();
    await expect(dest.initialize()).rejects.toThrow('DuckDB destination operation cancelled');
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it('closes resources when cancellation wins while connect is pending', async () => {
    let resolveConnect!: (connection: DuckDbConnectionLike) => void;
    const connectPending = new Promise<DuckDbConnectionLike>((resolve) => {
      resolveConnect = resolve;
    });
    const connection: DuckDbConnectionLike = {
      all: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
      run: vi.fn(),
    };
    const database: DuckDbDatabaseLike = {
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockReturnValue(connectPending),
    };
    const databaseFactory = vi.fn().mockResolvedValue(database);
    const dest = new DuckDbDestination({ dbPath, databaseFactory });

    const initializing = dest.initialize();
    await vi.waitFor(() => expect(database.connect).toHaveBeenCalledOnce());
    await dest.cancel();
    resolveConnect(connection);

    await expect(initializing).rejects.toThrow('DuckDB destination operation cancelled');
    expect(connection.interrupt).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    await expect(dest.close()).resolves.toBeUndefined();
  });

  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-dest-'));
    dbPath = path.join(tempDir, 'test.duckdb');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initialize() creates database file', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.close();

    const stat = await fs.stat(dbPath);
    expect(stat.isFile()).toBe(true);
  });

  it('ensureTable() creates table with correct column types including _time_extracted', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);
    await dest.close();

    const rows = await queryPersistentDb(
      dbPath,
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'issues' ORDER BY ordinal_position`
    );

    expect(rows).toEqual([
      { column_name: 'id', data_type: 'BIGINT' },
      { column_name: 'title', data_type: 'VARCHAR' },
      { column_name: '_time_extracted', data_type: 'TIMESTAMP' },
      { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP' },
    ]);
  });

  it('ensureTable() on existing table with new columns adds them via ALTER TABLE', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);

    // Add a new column
    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];
    await dest.ensureTable('main', 'issues', extendedColumns);
    await dest.close();

    const rows = await queryPersistentDb(
      dbPath,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' ORDER BY ordinal_position`
    );

    expect(rows.map((r) => r['column_name'])).toEqual([
      'id',
      'title',
      '_time_extracted',
      '_dogsled_loaded_at',
      'status',
    ]);
  });

  it('ensureTable() on type change throws error', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();

    await dest.ensureTable('main', 'issues', issueColumns);

    // Try to change title from string to integer (non-widenable narrowing)
    const changedColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'integer' },
    ];

    await expect(dest.ensureTable('main', 'issues', changedColumns)).rejects.toThrow(
      /Schema change conflict.*title.*VARCHAR.*BIGINT/
    );

    await dest.close();
  });

  it('loadAndFinalize("append") inserts rows directly', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'batch.jsonl');
    await writeJsonl(jsonlPath, [
      makeIssueRecord(1, 'alpha', '2026-03-26T00:00:00Z'),
      makeIssueRecord(2, 'beta', '2026-03-26T00:00:01Z'),
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha' },
      { id: BigInt(2), title: 'beta' },
    ]);
  });

  it('qualifies persistent tables when the database basename matches the target schema', async () => {
    dbPath = path.join(tempDir, 'github.duckdb');
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('github', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'catalog-schema-collision.jsonl');
    await writeJsonl(jsonlPath, [makeIssueRecord(1, 'alpha', '2026-03-26T00:00:00Z')]);

    await dest.loadAndFinalize('github', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, title FROM "github"."github"."issues"'
    );
    expect(rows).toEqual([{ id: BigInt(1), title: 'alpha' }]);

    const tableRows = await queryPersistentDb(
      dbPath,
      `SELECT table_catalog, table_schema, table_name FROM information_schema.tables WHERE table_catalog = 'github' AND table_schema = 'github' AND table_name = 'issues'`
    );
    expect(tableRows).toEqual([
      { table_catalog: 'github', table_schema: 'github', table_name: 'issues' },
    ]);
  });

  it('loadFromUri() replaces a table from Parquet URIs', async () => {
    const dest = new DuckDbDestination({ dbPath });
    const parquetPath = path.join(tempDir, 'issues.parquet');
    await queryRows(
      `COPY (SELECT 1::BIGINT AS id, 'alpha'::VARCHAR AS title) TO '${parquetPath}' (FORMAT PARQUET)`
    );

    await dest.initialize();
    await dest.loadFromUri('main', 'issues_from_uri', [parquetPath], issueColumns);
    await dest.close();

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, title FROM main.issues_from_uri ORDER BY id'
    );
    expect(rows).toEqual([{ id: 1n, title: 'alpha' }]);
  });

  it('loadAndFinalize("append") loads vector columns from JSONL batches', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();

    const embeddingColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'body', type: 'string' },
      { name: 'body_embedding', type: 'vector', dimension: 3 },
    ];
    await dest.ensureTable('main', 'embeddings', embeddingColumns);

    const jsonlPath = path.join(tempDir, 'embeddings.jsonl');
    await writeJsonl(jsonlPath, [
      {
        id: 1,
        body: 'alpha',
        body_embedding: [0.1, 0.2, 0.3],
        _time_extracted: '2026-03-26T00:00:00Z',
      },
    ]);

    await dest.loadAndFinalize('main', 'embeddings', jsonlPath, embeddingColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, body, body_embedding FROM main.embeddings'
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: BigInt(1),
      body: 'alpha',
    });
    expect(rows[0]?.['body_embedding']).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });

  it('ensureTable() preserves vector LIST type for existing tables', async () => {
    // Vectors are stored as DuckDB LIST (`FLOAT[]`) rather than fixed-size
    // ARRAY (`FLOAT[N]`) because DuckDB's ARRAY→Parquet encoder produces
    // malformed def/rep levels for null rows that BigQuery rejects. Dimension
    // is enforced upstream by the embedder schema.
    const embeddingColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'body_embedding', type: 'vector', dimension: 3 },
    ];

    const createDest = () => new DuckDbDestination({ dbPath });

    const first = createDest();
    await first.initialize();
    await first.ensureTable('main', 'embeddings', embeddingColumns);
    await first.close();

    const second = createDest();
    await second.initialize();
    await second.ensureTable('main', 'embeddings', embeddingColumns);
    await second.close();

    const rows = await queryPersistentDb(
      dbPath,
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'embeddings' AND column_name = 'body_embedding'`
    );

    expect(rows).toEqual([{ column_name: 'body_embedding', data_type: 'FLOAT[]' }]);
  });

  it('ensureTable() accepts vector dimension changes (DB-level dim constraint relaxed; enforced upstream)', async () => {
    // Pre-fix, this case rejected because the DB column was FLOAT[3] vs
    // FLOAT[5] — a type conflict. With the move to FLOAT[] (LIST) to fix the
    // BigQuery Parquet encoding bug, both map to the same DB type. Dimension
    // is enforced upstream by the embedder schema, so this is intentional.
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'embeddings', [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'body_embedding', type: 'vector', dimension: 3 },
    ]);

    await expect(
      dest.ensureTable('main', 'embeddings', [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'body_embedding', type: 'vector', dimension: 5 },
      ])
    ).resolves.toBeUndefined();

    await dest.close();
  });

  it('loadAndFinalize("merge") deduplicates by PK and merges into target', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // Initial load
    const batch1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(batch1, [
      makeIssueRecord(1, 'alpha', '2026-03-26T00:00:00Z'),
      makeIssueRecord(2, 'beta', '2026-03-26T00:00:01Z'),
    ]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'merge', ['id']);

    // Second load with overlapping PKs
    const batch2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(batch2, [
      makeIssueRecord(2, 'beta-updated', '2026-03-26T00:01:00Z'),
      makeIssueRecord(3, 'gamma', '2026-03-26T00:01:01Z'),
    ]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha' },
      { id: BigInt(2), title: 'beta-updated' },
      { id: BigInt(3), title: 'gamma' },
    ]);
  });

  it('loadAndFinalize("merge") deduplicates within a single flush — keeps latest by _time_extracted', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'dupes.jsonl');
    await writeJsonl(jsonlPath, [
      makeIssueRecord(1, 'first', '2026-03-26T00:00:00Z'),
      makeIssueRecord(1, 'second', '2026-03-26T00:00:01Z'),
      makeIssueRecord(1, 'latest', '2026-03-26T00:00:02Z'),
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: 'latest' }]);
  });

  it('loadAndFinalize("full_refresh") deletes existing rows and inserts new ones', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // Initial load via append
    const batch1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(batch1, [
      makeIssueRecord(1, 'alpha', '2026-03-26T00:00:00Z'),
      makeIssueRecord(2, 'beta', '2026-03-26T00:00:01Z'),
    ]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'append', []);

    // Full refresh replaces all data
    const batch2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(batch2, [makeIssueRecord(3, 'gamma', '2026-03-26T00:01:00Z')]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'full_refresh', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([{ id: BigInt(3), title: 'gamma' }]);
  });

  it('loadAndFinalize("full_refresh") on second flush appends without re-deleting', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // Initial data
    const batch0 = path.join(tempDir, 'batch0.jsonl');
    await writeJsonl(batch0, [makeIssueRecord(1, 'pre-existing', '2026-03-26T00:00:00Z')]);
    await dest.loadAndFinalize('main', 'issues', batch0, issueColumns, 'append', []);

    // First full_refresh flush — should delete then insert
    const batch1 = path.join(tempDir, 'batch1.jsonl');
    await writeJsonl(batch1, [makeIssueRecord(10, 'first-flush', '2026-03-26T00:01:00Z')]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'full_refresh', []);

    // Second full_refresh flush — should append (not re-delete)
    const batch2 = path.join(tempDir, 'batch2.jsonl');
    await writeJsonl(batch2, [makeIssueRecord(20, 'second-flush', '2026-03-26T00:02:00Z')]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'full_refresh', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([
      { id: BigInt(10), title: 'first-flush' },
      { id: BigInt(20), title: 'second-flush' },
    ]);
  });

  it('staging table is dropped even on error', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // Pass a non-existent file to trigger an error during load
    await expect(
      dest.loadAndFinalize('main', 'issues', '/nonexistent.jsonl', issueColumns, 'merge', ['id'])
    ).rejects.toThrow();

    // Verify no staging tables remain
    const tables = await queryPersistentDb(
      dbPath,
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE '_dogsled_stg_%'`
    );
    expect(tables).toEqual([]);

    await dest.close();
  });

  it('close() releases connection and database', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.close();

    // Should be able to close again without error (idempotent)
    await dest.close();
  });

  it('JSONL with missing fields results in NULL in target', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'partial.jsonl');
    await writeJsonl(jsonlPath, [{ id: 1, _time_extracted: '2026-03-26T00:00:00Z' }]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: null }]);
  });

  it('_dogsled_loaded_at is populated with a recent timestamp after loading', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'loaded-at.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, title: 'alpha', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT "_dogsled_loaded_at" FROM main.issues');
    expect(rows.length).toBe(1);
    const loadedAt = rows[0]!['_dogsled_loaded_at'];
    expect(loadedAt).toBeInstanceOf(Date);
    // Verify it's distinct from _time_extracted (it's set by the loader, not the extractor)
    const teRows = await queryPersistentDb(dbPath, 'SELECT "_time_extracted" FROM main.issues');
    const timeExtracted = teRows[0]!['_time_extracted'] as Date;
    expect((loadedAt as Date).getTime()).not.toBe(timeExtracted.getTime());
  });

  it('_dogsled_loaded_at is populated for merge strategy', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'merge-loaded-at.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, title: 'alpha', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT "_dogsled_loaded_at" FROM main.issues');
    expect(rows.length).toBe(1);
    expect(rows[0]!['_dogsled_loaded_at']).toBeInstanceOf(Date);
  });

  it('_time_extracted is populated correctly', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'ts.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, title: 'alpha', _time_extracted: '2026-03-26T12:34:56Z' },
    ]);

    await dest.loadAndFinalize('main', 'issues', jsonlPath, issueColumns, 'append', []);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT "_time_extracted" FROM main.issues');
    expect(rows.length).toBe(1);
    const ts = rows[0]!['_time_extracted'];
    expect(ts).toBeInstanceOf(Date);
    expect((ts as Date).toISOString()).toBe('2026-03-26T12:34:56.000Z');
  });

  // WI-1: Cross-flush merge ordering
  it('merge: flush with OLDER timestamp does not overwrite newer data', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // First flush: newer timestamp
    const batch1 = path.join(tempDir, 'newer.jsonl');
    await writeJsonl(batch1, [
      { id: 1, title: 'newer-title', _time_extracted: '2026-03-26T00:01:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'merge', ['id']);

    // Second flush: OLDER timestamp for same key
    const batch2 = path.join(tempDir, 'older.jsonl');
    await writeJsonl(batch2, [
      { id: 1, title: 'older-title', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: 'newer-title' }]);
  });

  it('merge: flush with NEWER timestamp updates existing data', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    // First flush: older timestamp
    const batch1 = path.join(tempDir, 'old.jsonl');
    await writeJsonl(batch1, [
      { id: 1, title: 'old-title', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'merge', ['id']);

    // Second flush: NEWER timestamp for same key
    const batch2 = path.join(tempDir, 'new.jsonl');
    await writeJsonl(batch2, [
      { id: 1, title: 'new-title', _time_extracted: '2026-03-26T00:01:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: 'new-title' }]);
  });

  it('merge: flush with equal timestamps is idempotent', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const batch1 = path.join(tempDir, 'eq1.jsonl');
    await writeJsonl(batch1, [{ id: 1, title: 'same', _time_extracted: '2026-03-26T00:00:00Z' }]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'merge', ['id']);

    const batch2 = path.join(tempDir, 'eq2.jsonl');
    await writeJsonl(batch2, [
      { id: 1, title: 'same-again', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'merge', ['id']);
    await dest.close();

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: 'same-again' }]);
  });

  // WI-3: NULL key handling
  it('merge: NULL in single key column always inserts (never updates)', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const batch1 = path.join(tempDir, 'null-key1.jsonl');
    await writeJsonl(batch1, [
      { id: null, title: 'first-null', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch1, issueColumns, 'merge', ['id']);

    const batch2 = path.join(tempDir, 'null-key2.jsonl');
    await writeJsonl(batch2, [
      { id: null, title: 'second-null', _time_extracted: '2026-03-26T00:01:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch2, issueColumns, 'merge', ['id']);
    await dest.close();

    // NULL != NULL in SQL, so both rows should exist (no dedup)
    const rows = await queryPersistentDb(dbPath, 'SELECT title FROM main.issues ORDER BY title');
    expect(rows).toEqual([{ title: 'first-null' }, { title: 'second-null' }]);
  });

  it('merge: two records with NULL key in same batch — PARTITION BY groups NULLs, keeps latest', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const batch = path.join(tempDir, 'null-same-batch.jsonl');
    await writeJsonl(batch, [
      { id: null, title: 'a-null', _time_extracted: '2026-03-26T00:00:00Z' },
      { id: null, title: 'b-null', _time_extracted: '2026-03-26T00:00:01Z' },
    ]);
    await dest.loadAndFinalize('main', 'issues', batch, issueColumns, 'merge', ['id']);
    await dest.close();

    // Within a batch, PARTITION BY groups NULLs together (unlike JOIN where NULL != NULL).
    // The ROW_NUMBER dedup keeps only the latest _time_extracted per partition.
    const rows = await queryPersistentDb(dbPath, 'SELECT title FROM main.issues');
    expect(rows).toEqual([{ title: 'b-null' }]);
  });

  it('merge: NULL in one of two composite key columns always inserts', async () => {
    const compositeColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'region', type: 'string', primary_key: true },
      { name: 'value', type: 'integer' },
    ];

    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'items', compositeColumns);

    const batch1 = path.join(tempDir, 'comp-null1.jsonl');
    await writeJsonl(batch1, [
      { id: 1, region: null, value: 10, _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'items', batch1, compositeColumns, 'merge', [
      'id',
      'region',
    ]);

    const batch2 = path.join(tempDir, 'comp-null2.jsonl');
    await writeJsonl(batch2, [
      { id: 1, region: null, value: 20, _time_extracted: '2026-03-26T00:01:00Z' },
    ]);
    await dest.loadAndFinalize('main', 'items', batch2, compositeColumns, 'merge', [
      'id',
      'region',
    ]);
    await dest.close();

    // NULL in composite key means no match, so both rows exist
    const rows = await queryPersistentDb(dbPath, 'SELECT value FROM main.items ORDER BY value');
    expect(rows).toEqual([{ value: BigInt(10) }, { value: BigInt(20) }]);
  });

  it('constructor rejects invalid memoryLimit values', () => {
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: 'not-a-size' })).toThrow(
      /Invalid memoryLimit/
    );
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: '512' })).toThrow(
      /Invalid memoryLimit/
    );
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: 'MB512' })).toThrow(
      /Invalid memoryLimit/
    );
  });

  it('constructor accepts valid memoryLimit values', () => {
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: '512MB' })).not.toThrow();
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: '2.5GiB' })).not.toThrow();
    expect(() => new DuckDbDestination({ dbPath, memoryLimit: '1TB' })).not.toThrow();
  });

  // WI-7: Memory limit + checkpoint
  it('initialize() sets memory_limit when configured', async () => {
    // Verify that SET memory_limit runs during initialize by testing the destination
    // works correctly with the limit set — loading data should succeed
    const dest = new DuckDbDestination({ dbPath, memoryLimit: '512MB' });
    await dest.initialize();
    await dest.ensureTable('main', 'issues', issueColumns);

    const jsonlPath = path.join(tempDir, 'mem-limit.jsonl');
    await writeJsonl(jsonlPath, [
      { id: 1, title: 'alpha', _time_extracted: '2026-03-26T00:00:00Z' },
    ]);
    const result = await dest.loadAndFinalize(
      'main',
      'issues',
      jsonlPath,
      issueColumns,
      'append',
      []
    );
    expect(result.rowsAffected).toBe(1);

    await dest.close();
  });

  it('initialize() skips memory_limit when not configured', async () => {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    // Should not throw — default memory limit applies
    await dest.close();
  });
});

describe('sanitizeTableName', () => {
  it('accepts valid table names', () => {
    expect(sanitizeTableName('issues')).toBe('issues');
    expect(sanitizeTableName('user_repos_2')).toBe('user_repos_2');
  });

  it('rejects names starting with digits', () => {
    expect(() => sanitizeTableName('123table')).toThrow(/must start with a letter or underscore/);
  });

  it('rejects names with dots', () => {
    expect(() => sanitizeTableName('foo.bar')).toThrow(/must start with a letter or underscore/);
  });

  it('rejects names with slashes', () => {
    expect(() => sanitizeTableName('foo/bar')).toThrow(/must start with a letter or underscore/);
  });

  it('rejects names with path traversal', () => {
    expect(() => sanitizeTableName('..')).toThrow(/must start with a letter or underscore/);
  });

  it('rejects reserved staging prefixes', () => {
    expect(() => sanitizeTableName('_dogsled_stg_test')).toThrow(/reserved prefix/);
  });
});
