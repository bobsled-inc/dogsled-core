import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_DATABASE_FILE,
  LOCAL_STATE_DIR,
  LOCAL_STATE_GITIGNORE,
  localDatabaseFile,
  localStateDir,
  localStateTakeoverRoot,
  prepareLocalStateDir,
  resetLocalStateDirForTests,
  type LakeDataPathStore,
} from '../../../src/local-state/local-state-dir.js';
import { duckDbFileInUse, duckDbLakeDataPathStore } from '../../../src/local-state/duckdb-lake.js';

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
    expect(notices).toEqual([
      expect.stringMatching(
        /\(last changed [\d-]+\); \.legacy\/ \(last changed [\d-]+\) is ignored/
      ),
    ]);
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

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe("Core's ignore file in the moved folder", () => {
  it('writes one that keeps config.yml and never overwrites one that exists', async () => {
    write('.legacy/config.yml', 'x');
    await prepareLocalStateDir(root, { notice });
    expect(read(`${LOCAL_STATE_DIR}/.gitignore`)).toBe(LOCAL_STATE_GITIGNORE);
    fs.rmSync(path.join(root, LOCAL_STATE_DIR), { recursive: true });
    resetLocalStateDirForTests();
    write('.legacy/config.yml', 'x');
    write('.legacy/.gitignore', 'mine\n');
    await prepareLocalStateDir(root, { notice });
    expect(read(`${LOCAL_STATE_DIR}/.gitignore`)).toBe('mine\n');
  });

  it.skipIf(!hasGit)('lets git stage config.yml but not local data after the move', async () => {
    write('.gitignore', 'output/\n');
    write('.legacy/config.yml', 'x');
    write('.legacy/legacy.duckdb', 'db');
    write('.legacy/sync-state/s/checkpoint.json', '{}');
    write('.legacy/lake/c.ducklake', '');
    await prepareLocalStateDir(root, { notice });
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...gitEnv } = process.env;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: gitEnv,
      });
    git('init', '-q');
    git('add', '.');
    expect(git('diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(
      ['.gitignore', `${LOCAL_STATE_DIR}/.gitignore`, `${LOCAL_STATE_DIR}/config.yml`].sort()
    );
  });
});

describe('only Core state at a project root moves', () => {
  const current = () => path.join(root, LOCAL_STATE_DIR);
  const earlier = () => path.join(root, '.legacy');

  it('leaves an installer folder (with bin/) and a folder without Core state where they are', async () => {
    write('.legacy/bin/tool', '#!/bin/sh');
    expect(await prepareLocalStateDir(root, { notice })).toBe(earlier());
    resetLocalStateDirForTests();
    fs.rmSync(path.join(root, '.legacy/bin'), { recursive: true });
    write('.legacy/notes.txt', 'mine');
    expect(await prepareLocalStateDir(root, { notice })).toBe(earlier());
    expect(has(LOCAL_STATE_DIR)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('finds the takeover root at the nearest folder and stops at a current folder', () => {
    write('.legacy/config.yml', 'x');
    write('sub/deeper/file.txt', '');
    expect(localStateTakeoverRoot(path.join(root, 'sub/deeper'))).toBe(root);
    write(`sub/${LOCAL_STATE_DIR}/config.yml`, 'y');
    expect(localStateTakeoverRoot(path.join(root, 'sub/deeper'))).toBeUndefined();
  });

  it('keeps the folder in place while project files name it, and says so once', async () => {
    write('.legacy/config.yml', 'x');
    const referencedBy = (folder: string) => (folder === '.legacy' ? ['integrations/w.yml'] : []);
    expect(await prepareLocalStateDir(root, { notice, referencedBy })).toBe(earlier());
    resetLocalStateDirForTests();
    expect(await prepareLocalStateDir(root, { notice, referencedBy })).toBe(earlier());
    expect(read('.legacy/config.yml')).toBe('x');
    expect(notices).toEqual([
      expect.stringMatching(/^Kept \.legacy\/: integrations\/w\.yml names it/),
    ]);
    resetLocalStateDirForTests();
    expect(await prepareLocalStateDir(root, { notice, referencedBy: () => [] })).toBe(current());
  });

  it('keeps a folder another process is using: a WAL file or a live run lock', async () => {
    write('.legacy/legacy.duckdb', 'db');
    write('.legacy/legacy.duckdb.wal', 'wal');
    expect(await prepareLocalStateDir(root, { notice })).toBe(earlier());
    expect(notices).toEqual([
      expect.stringMatching(/legacy\.duckdb\.wal shows a process is using/),
    ]);
    fs.rmSync(path.join(root, '.legacy/legacy.duckdb.wal'));
    fs.mkdirSync(path.join(root, '.legacy/model-spec'));
    const lock = path.join(root, '.legacy/model-spec/agentic-a.lock');
    fs.symlinkSync(`${os.hostname()}:${process.pid}:token`, lock);
    resetLocalStateDirForTests();
    expect(await prepareLocalStateDir(root, { notice })).toBe(earlier());
    fs.unlinkSync(lock);
    fs.symlinkSync(`${os.hostname()}:999999999:token`, lock);
    resetLocalStateDirForTests();
    expect(await prepareLocalStateDir(root, { notice })).toBe(current());
  });

  it('keeps a folder whose DuckDB file another process holds open', async () => {
    fs.mkdirSync(earlier());
    const file = path.join(earlier(), 'legacy.duckdb');
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { DuckDBInstance } = await import('@duckdb/node-api');
         const db = await DuckDBInstance.create(${JSON.stringify(file)});
         const c = await db.connect();
         await c.run('CREATE TABLE t AS SELECT 1 AS x');
         await c.run('CHECKPOINT');
         process.stdout.write('ready\\n');
         setInterval(() => {}, 1000);`,
      ],
      { cwd: path.resolve(__dirname, '../../..'), stdio: ['ignore', 'pipe', 'inherit'] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.on(
          'data',
          (chunk: Buffer) => chunk.toString().includes('ready') && resolve()
        );
        holder.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
      });
      const options = { notice, databaseInUse: duckDbFileInUse() };
      expect(await prepareLocalStateDir(root, options)).toBe(earlier());
      expect(notices).toEqual([expect.stringMatching(/legacy\.duckdb is open in another process/)]);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 30_000);

  it('rewrites only paths into the folder in its own settings', async () => {
    write(
      '.legacy/config.yml',
      `a: .legacy/legacy.duckdb\nb: ../shared/legacy.duckdb\nc: other.legacy/x\nd: ${root}/.legacy/lake/c.ducklake\n`
    );
    await prepareLocalStateDir(root, { notice });
    expect(read(`${LOCAL_STATE_DIR}/config.yml`)).toBe(
      `a: ${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}\nb: ../shared/legacy.duckdb\nc: other.legacy/x\nd: ${root}/${LOCAL_STATE_DIR}/lake/c.ducklake\n`
    );
  });

  it('maps a lake data path through a link to the project, and stops on one it cannot map', async () => {
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    try {
      const paths = new Map<string, string>();
      const lake: LakeDataPathStore = {
        read: async (catalog) => paths.get(path.basename(catalog)),
        write: async (catalog, value) => void paths.set(path.basename(catalog), value),
      };
      write('.legacy/lake/c.ducklake', '');
      paths.set('c.ducklake', `${link}/.legacy/lake/c.ducklake.files/`);
      expect(await prepareLocalStateDir(root, { notice, lake })).toBe(current());
      expect(paths.get('c.ducklake')).toBe(`${link}/${LOCAL_STATE_DIR}/lake/c.ducklake.files/`);

      fs.renameSync(current(), earlier());
      resetLocalStateDirForTests();
      notices.length = 0;
      paths.set('c.ducklake', '/elsewhere/.legacy/lake/c.ducklake.files/');
      expect(await prepareLocalStateDir(root, { notice, lake })).toBe(earlier());
      expect(paths.get('c.ducklake')).toBe('/elsewhere/.legacy/lake/c.ducklake.files/');
      expect(notices).toEqual([expect.stringMatching(/outside this project/)]);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('finishes a stopped takeover only when its journal says so, and survives a failed finish', async () => {
    write(`${LOCAL_STATE_DIR}/legacy.duckdb`, 'a user file');
    await prepareLocalStateDir(root, { notice });
    expect(has(`${LOCAL_STATE_DIR}/legacy.duckdb`)).toBe(true);
    resetLocalStateDirForTests();
    write(`${LOCAL_STATE_DIR}/.takeover.json`, '{"from":".legacy","lake":[]}');
    fs.mkdirSync(path.join(current(), 'config.yml.takeover'));
    write(`${LOCAL_STATE_DIR}/config.yml`, 'settings');
    expect(await prepareLocalStateDir(root, { notice })).toBe(current());
    expect(has(`${LOCAL_STATE_DIR}/.takeover.json`)).toBe(true);
  });

  it('takes over a lock whose owner process is gone', async () => {
    write('.legacy/config.yml', 'x');
    const lock = path.join(root, `${LOCAL_STATE_DIR}.takeover.lock`);
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: 999999999, host: os.hostname(), token: 'gone' })
    );
    expect(await prepareLocalStateDir(root, { notice })).toBe(current());
    expect(fs.existsSync(lock)).toBe(false);
  });
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

// CI installs the DuckLake extension, so there a missing one fails rather than skips.
describe.skipIf(!ducklake && !process.env['CI'])('a DuckLake catalog inside the folder', () => {
  beforeAll(() => {
    if (!ducklake) throw new Error('The DuckLake extension could not be installed.');
  });

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
