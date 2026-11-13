import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_COLUMNS, SYSTEM_COLUMN_NAMES } from '../../../src/runtime/destinations/database.js';
import { DuckDbDestination } from '../../../src/runtime/destinations/duckdb.js';
import {
  fillLegacyLoadedAt,
  planLoadedAtTakeover,
  takeOverLegacyLoadedAt,
} from '../../../src/runtime/destinations/loaded-at-takeover.js';
import { queryPersistentDb } from '../../helpers/duckdb.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

// The takeover is generic: these tests stand in an earlier name, so they pass
// before and after the Dogsled -> Bobsled rename flips the current column.
vi.mock('../../../src/runtime/legacy-names.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LEGACY_LOADED_AT_COLUMNS: ['_legacy_loaded_at'],
}));

const CURRENT = SYSTEM_COLUMNS.LOADED_AT;
const LEGACY = '_legacy_loaded_at';
const columns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

describe('loaded-at takeover plan', () => {
  it('keeps the earlier name a system column so schema checks never drop or reject it', () => {
    expect(SYSTEM_COLUMN_NAMES).toEqual(['_time_extracted', CURRENT, LEGACY]);
  });

  it.each([
    [['id', CURRENT], { action: 'none' }],
    [['id', LEGACY], { action: 'rename', from: LEGACY }],
    [['id', CURRENT, LEGACY], { action: 'fill', from: LEGACY }],
    [['ID', LEGACY.toUpperCase()], { action: 'rename', from: LEGACY.toUpperCase() }],
    [['id', '_source_legacy_loaded_at_x'], { action: 'none' }],
  ])('plans %j as %j', (names, plan) => {
    expect(planLoadedAtTakeover(names, CURRENT)).toEqual(plan);
  });

  it('re-reads after a refused rename and falls back to copying into the current column', async () => {
    const warn = vi.fn();
    const existing = new Map([
      ['id', 'BIGINT'],
      [LEGACY, 'TIMESTAMP'],
    ]);
    const result = await takeOverLegacyLoadedAt({
      table: 't',
      existing,
      current: CURRENT,
      rename: () => Promise.reject(new Error('rename not supported on this table')),
      reread: async () => new Map(existing),
      logger: { info: vi.fn(), warn },
    });
    expect(result).toEqual({ fillFrom: LEGACY });
    expect(warn).toHaveBeenCalledWith(
      'loaded_at_column_rename_refused',
      expect.objectContaining({ from: LEGACY, to: CURRENT })
    );
  });

  it('accepts a rename done by another run in the meantime', async () => {
    const existing = new Map([[LEGACY, 'TIMESTAMP']]);
    const result = await takeOverLegacyLoadedAt({
      table: 't',
      existing,
      current: CURRENT,
      rename: () => Promise.reject(new Error('column does not exist')),
      reread: async () => new Map([[CURRENT, 'TIMESTAMP']]),
    });
    expect(result).toEqual({});
    expect([...existing.keys()]).toEqual([CURRENT]);
  });

  it('logs a failed fill instead of failing the load', async () => {
    const warn = vi.fn();
    await expect(
      fillLegacyLoadedAt(
        { fillFrom: LEGACY },
        {
          table: 't',
          current: CURRENT,
          fill: () => Promise.reject(new Error('streaming buffer')),
          logger: { info: vi.fn(), warn },
        }
      )
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('loaded_at_column_fill_failed', expect.anything());
  });
});

describe('loaded-at takeover on DuckDB', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loaded-at-takeover-'));
    dbPath = path.join(tempDir, 'test.duckdb');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function prepare(sql: string[]): Promise<void> {
    for (const statement of sql) await queryPersistentDb(dbPath, statement);
  }

  async function ensure(schemaBehavior: 'strict' | 'freeze' | 'evolve'): Promise<void> {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    try {
      await dest.ensureTable('main', 'issues', columns, { schemaBehavior });
    } finally {
      await dest.close();
    }
  }

  async function table(): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const info = await queryPersistentDb(
      dbPath,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' ORDER BY ordinal_position`
    );
    const rows = await queryPersistentDb(
      dbPath,
      `SELECT COLUMNS(*)::VARCHAR FROM main.issues ORDER BY id`
    );
    return { columns: info.map((row) => String(row['column_name'])), rows };
  }

  it.each(['strict', 'freeze', 'evolve'] as const)(
    'case B (%s): renames the earlier column in place and keeps its values',
    async (behavior) => {
      await prepare([
        `CREATE TABLE main.issues (id BIGINT, title VARCHAR, _time_extracted TIMESTAMP, ${LEGACY} TIMESTAMP)`,
        `INSERT INTO main.issues VALUES (1, 'a', TIMESTAMP '2026-01-01', TIMESTAMP '2026-01-02')`,
      ]);
      await ensure(behavior);
      await ensure(behavior);
      const result = await table();
      expect(result.columns).toEqual(['id', 'title', '_time_extracted', CURRENT]);
      expect(result.rows).toEqual([
        {
          id: '1',
          title: 'a',
          _time_extracted: '2026-01-01 00:00:00',
          [CURRENT]: '2026-01-02 00:00:00',
        },
      ]);
    }
  );

  it.each(['strict', 'freeze', 'evolve'] as const)(
    'case C (%s): fills empty current values once and never drops the earlier column',
    async (behavior) => {
      await prepare([
        `CREATE TABLE main.issues (id BIGINT, title VARCHAR, _time_extracted TIMESTAMP, ${CURRENT} TIMESTAMP, ${LEGACY} TIMESTAMP)`,
        `INSERT INTO main.issues VALUES (1, 'old', NULL, NULL, TIMESTAMP '2026-01-02')`,
        `INSERT INTO main.issues VALUES (2, 'new', NULL, TIMESTAMP '2026-03-01', NULL)`,
        `INSERT INTO main.issues VALUES (3, 'both', NULL, TIMESTAMP '2026-03-02', TIMESTAMP '2026-01-03')`,
      ]);
      await ensure(behavior);
      await ensure(behavior);
      const result = await table();
      expect(result.columns).toEqual(['id', 'title', '_time_extracted', CURRENT, LEGACY]);
      expect(result.rows.map((row) => [row['id'], row[CURRENT], row[LEGACY]])).toEqual([
        ['1', '2026-01-02 00:00:00', '2026-01-02 00:00:00'],
        ['2', '2026-03-01 00:00:00', null],
        ['3', '2026-03-02 00:00:00', '2026-01-03 00:00:00'],
      ]);
    }
  );

  it('case A: leaves a table with only the current column alone', async () => {
    await prepare([
      `CREATE TABLE main.issues (id BIGINT, title VARCHAR, _time_extracted TIMESTAMP, ${CURRENT} TIMESTAMP)`,
      `INSERT INTO main.issues VALUES (1, 'a', NULL, TIMESTAMP '2026-01-02')`,
    ]);
    await ensure('strict');
    expect((await table()).columns).toEqual(['id', 'title', '_time_extracted', CURRENT]);
  });
});

const hasSqlite = await (async () => {
  try {
    const module = await import('better-sqlite3');
    new module.default(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSqlite)('loaded-at takeover on SQLite', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loaded-at-sqlite-'));
    dbPath = path.join(tempDir, 'test.sqlite');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function sql(statement: string): Promise<Record<string, unknown>[]> {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    try {
      const prepared = db.prepare(statement);
      return prepared.reader ? (prepared.all() as Record<string, unknown>[]) : (prepared.run(), []);
    } finally {
      db.close();
    }
  }

  async function ensure(keys = false): Promise<void> {
    const { SqliteDestination } = await import('../../../src/runtime/destinations/sqlite.js');
    const dest = new SqliteDestination({ dbPath });
    await dest.initialize();
    try {
      await dest.ensureTable('main', 'issues', columns, {
        schemaBehavior: 'strict',
        ...(keys ? { keyProperties: ['id'] } : {}),
      });
    } finally {
      await dest.close();
    }
  }

  it('renames (case B) and fills (case C) under strict schema behavior', async () => {
    await sql(`CREATE TABLE issues (id INTEGER, title TEXT, _time_extracted TEXT, ${LEGACY} TEXT)`);
    await sql(`INSERT INTO issues VALUES (1, 'a', NULL, '2026-01-02')`);
    await ensure();
    expect((await sql(`PRAGMA table_info(issues)`)).map((row) => row['name'])).toEqual([
      'id',
      'title',
      '_time_extracted',
      CURRENT,
    ]);
    expect(await sql(`SELECT ${CURRENT} AS v FROM issues`)).toEqual([{ v: '2026-01-02' }]);

    await sql(`ALTER TABLE issues ADD COLUMN ${LEGACY} TEXT`);
    await sql(`INSERT INTO issues VALUES (2, 'b', NULL, NULL, '2026-01-03')`);
    await ensure();
    expect(await sql(`SELECT id, ${CURRENT} AS v FROM issues ORDER BY id`)).toEqual([
      { id: 1, v: '2026-01-02' },
      { id: 2, v: '2026-01-03' },
    ]);
  });

  it('keeps using an earlier unique merge index instead of adding a second one', async () => {
    vi.resetModules();
    vi.doMock('../../../src/runtime/legacy-names.js', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      LEGACY_LOADED_AT_COLUMNS: ['_legacy_loaded_at'],
      LEGACY_UNIQUE_INDEX_PREFIXES: ['_legacy_uq_'],
    }));
    try {
      await sql(
        `CREATE TABLE issues (id INTEGER, title TEXT, _time_extracted TEXT, ${CURRENT} TEXT)`
      );
      await sql(`CREATE UNIQUE INDEX _legacy_uq_issues ON issues (id)`);
      await ensure(true);
      expect((await sql(`PRAGMA index_list(issues)`)).map((row) => row['name'])).toEqual([
        '_legacy_uq_issues',
      ]);
    } finally {
      vi.doUnmock('../../../src/runtime/legacy-names.js');
      vi.resetModules();
    }
  });
});
