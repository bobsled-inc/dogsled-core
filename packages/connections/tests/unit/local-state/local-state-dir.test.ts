import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_DATABASE_FILE,
  LOCAL_STATE_DIR,
  localDatabaseFile,
  localStateDir,
  prepareLocalStateDir,
  resetLocalStateDirForTests,
} from '../../../src/local-state/local-state-dir.js';
import { duckDbLakeDataPathStore } from '../../../src/local-state/duckdb-lake.js';

// Generic tests: an earlier folder name stands in, so they pass before and after the
// Dogsled -> Bobsled rename changes the current one.
vi.mock('../../../src/local-state/legacy-names.js', () => ({
  LEGACY_LOCAL_STATE_DIRS: ['.legacy'],
  LEGACY_LOCAL_DATABASE_FILES: ['legacy.duckdb'],
}));

let root: string;
const notices: string[] = [];
const notice = (message: string) => void notices.push(message);
const write = (relative: string, text = '') => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const has = (relative: string) => fs.existsSync(path.join(root, relative));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-state-')));
  notices.length = 0;
  resetLocalStateDirForTests();
});
afterEach(() => {
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local state folder takeover', () => {
  it('uses the current folder in a fresh project and says nothing', async () => {
    expect(await prepareLocalStateDir(root, { notice })).toBe(path.join(root, LOCAL_STATE_DIR));
    expect(notices).toEqual([]);
  });

  it('moves an earlier folder once, renames the database and rewrites its own settings', async () => {
    write(
      '.legacy/config.yml',
      'duckdb:\n  dbPath: .legacy/legacy.duckdb\nlake: ducklake:.legacy/lake/c.ducklake\n'
    );
    write('.legacy/legacy.duckdb', 'db');
    write('.legacy/model-spec/state.json', '{}');
    write('.gitignore', '.legacy/*\n');
    expect(localStateDir(root)).toBe(path.join(root, '.legacy'));
    expect(await prepareLocalStateDir(root, { notice })).toBe(path.join(root, LOCAL_STATE_DIR));
    expect(has('.legacy')).toBe(false);
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe(
      `duckdb:\n  dbPath: ${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}\nlake: ducklake:${LOCAL_STATE_DIR}/lake/c.ducklake\n`
    );
    expect(read(`${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}`)).toBe('db');
    expect(read(`${LOCAL_STATE_DIR}/model-spec/state.json`)).toBe('{}');
    expect(read('.gitignore')).toBe('.legacy/*\n');
    expect(localDatabaseFile(root)).toBe(path.join(root, LOCAL_STATE_DIR, LOCAL_DATABASE_FILE));
    expect(notices).toEqual([
      expect.stringMatching(/^Moved \.legacy\/ to .+ \(one time\)\. Update your \.gitignore/),
    ]);
    resetLocalStateDirForTests();
    await prepareLocalStateDir(root, { notice });
    expect(notices).toHaveLength(1);
  });

  it('uses the current folder when both exist, never merges or deletes, and says so once', async () => {
    write('.legacy/config.yml', 'old');
    write(`${LOCAL_STATE_DIR}/config.yml`, 'new');
    expect(await prepareLocalStateDir(root, { notice })).toBe(path.join(root, LOCAL_STATE_DIR));
    resetLocalStateDirForTests();
    await prepareLocalStateDir(root, { notice });
    expect(read('.legacy/config.yml')).toBe('old');
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe('new');
    expect(notices).toEqual([expect.stringMatching(/\.legacy\/ is ignored/)]);
  });

  it('finishes a takeover that stopped after the folder moved', async () => {
    write('.legacy/keep.txt', 'x');
    write(`${LOCAL_STATE_DIR}/legacy.duckdb`, 'db');
    write(`${LOCAL_STATE_DIR}/config.yml`, 'old settings');
    write(`${LOCAL_STATE_DIR}/config.yml.takeover`, 'new settings');
    write(`${LOCAL_STATE_DIR}/.takeover.json`, '{"from":".legacy","lake":[]}');
    await prepareLocalStateDir(root, { notice });
    expect(read(`${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}`)).toBe('db');
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe('new settings');
    expect(has(`${LOCAL_STATE_DIR}/.takeover.json`)).toBe(false);
  });

  it('undoes a preparation that stopped before the move, then moves', async () => {
    write('.legacy/config.yml', 'dbPath: .legacy/legacy.duckdb\n');
    write('.legacy/config.yml.takeover', 'stale');
    write('.legacy/.takeover.json', '{"from":".legacy","lake":[]}');
    await prepareLocalStateDir(root, { notice });
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe(
      `dbPath: ${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}\n`
    );
  });

  it('lets one of two concurrent runs move the folder and the other use the result', async () => {
    write('.legacy/config.yml', 'x');
    const [first, second] = await Promise.all([
      prepareLocalStateDir(root, { notice }),
      (async () => {
        resetLocalStateDirForTests();
        return prepareLocalStateDir(root, { notice });
      })(),
    ]);
    expect(first).toBe(path.join(root, LOCAL_STATE_DIR));
    expect(second).toBe(path.join(root, LOCAL_STATE_DIR));
    expect(has('.legacy')).toBe(false);
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe('x');
  });

  it.skipIf(process.getuid?.() === 0)(
    'falls back to the earlier folder, untouched, when the project folder is read-only',
    async () => {
      write('.legacy/config.yml', 'dbPath: .legacy/legacy.duckdb\n');
      fs.chmodSync(root, 0o555);
      expect(await prepareLocalStateDir(root, { notice })).toBe(path.join(root, '.legacy'));
      expect(read('.legacy/config.yml')).toBe('dbPath: .legacy/legacy.duckdb\n');
      expect(fs.readdirSync(path.join(root, '.legacy'))).toEqual(['config.yml']);
      expect(notices).toEqual([expect.stringMatching(/using \.legacy\/ for this run/)]);
    }
  );
});

const ducklake = await (async () => {
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const db = await DuckDBInstance.create(':memory:');
    const c = await db.connect();
    await c.run('INSTALL ducklake; LOAD ducklake;');
    return DuckDBInstance;
  } catch {
    return undefined;
  }
})();

describe.skipIf(!ducklake)('a DuckLake catalog inside the folder', () => {
  it.each(['relative', 'absolute'])(
    'still reads its data after the move (%s data path)',
    async (kind) => {
      const cwd = process.cwd();
      process.chdir(root);
      try {
        const catalog =
          kind === 'relative'
            ? '.legacy/lake/c.ducklake'
            : path.join(root, '.legacy/lake/c.ducklake');
        fs.mkdirSync(path.join(root, '.legacy/lake'), { recursive: true });
        const attach = async (file: string, sql: string) => {
          const db = await ducklake!.create(':memory:');
          const c = await db.connect();
          await c.run('LOAD ducklake');
          await c.run(`ATTACH 'ducklake:${file}' AS lake`);
          const rows = (await c.runAndReadAll(sql)).getRowObjectsJson();
          c.closeSync();
          db.closeSync();
          return rows;
        };
        await attach(catalog, 'CREATE TABLE lake.t AS SELECT 7 AS x');
        await prepareLocalStateDir(root, { notice, lake: duckDbLakeDataPathStore() });
        const moved = catalog.replace('.legacy', LOCAL_STATE_DIR);
        expect(await attach(moved, 'SELECT x FROM lake.t')).toEqual([{ x: 7 }]);
      } finally {
        process.chdir(cwd);
      }
    }
  );
});
