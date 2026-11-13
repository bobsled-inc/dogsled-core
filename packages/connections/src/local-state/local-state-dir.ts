import * as fs from 'node:fs';
import * as path from 'node:path';

import { LEGACY_LOCAL_DATABASE_FILES, LEGACY_LOCAL_STATE_DIRS } from './legacy-names.js';

/** The project's local state folder (settings, local data, run state). */
export const LOCAL_STATE_DIR = '.dogsled';
/** The default local DuckDB file inside it. */
export const LOCAL_DATABASE_FILE = 'dogsled.duckdb';

const NEXT_CONFIG = 'config.yml.takeover';
const JOURNAL = '.takeover.json';
const NOTICED = '.earlier-folder-noticed';
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 30_000;

type Notice = (message: string) => void;
/** Reads and writes the data path a DuckLake catalog file stores. */
export interface LakeDataPathStore {
  read(catalog: string): Promise<string | undefined>;
  write(catalog: string, value: string): Promise<void>;
}
interface Options {
  /** Where notices go; defaults to stderr. */
  notice?: Notice;
  /** DuckLake catalogs store their data path, which names the folder; it moves with it. */
  lake?: LakeDataPathStore;
}
interface Journal {
  from: string;
  lake: { catalog: string; dataPath: string }[];
}

const outcomes = new Map<string, string>();
const earlierDirs = () => LEGACY_LOCAL_STATE_DIRS.filter((name) => name !== LOCAL_STATE_DIR);
const exists = (file: string) => fs.existsSync(file);
const defaultNotice: Notice = (message) => process.stderr.write(`${message}\n`);

/**
 * The name of the project's local state folder. Before `prepareLocalStateDir` ran for this
 * project, an earlier folder (for example `.dogsled/` once Core uses `.bobsled/`) is read in
 * place.
 */
export function localStateDirName(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const known = outcomes.get(root);
  if (known) return path.basename(known);
  if (exists(path.join(root, LOCAL_STATE_DIR))) return LOCAL_STATE_DIR;
  return earlierDirs().find((name) => exists(path.join(root, name))) ?? LOCAL_STATE_DIR;
}

/** The project's local state folder, joined to `projectRoot` as given (relative stays relative). */
export function localStateDir(projectRoot: string): string {
  return path.join(projectRoot, localStateDirName(projectRoot));
}

/** The default local DuckDB file, under its earlier name if the folder still uses it. */
export function localDatabaseFile(projectRoot: string): string {
  const dir = localStateDir(projectRoot);
  const current = path.join(dir, LOCAL_DATABASE_FILE);
  if (exists(current)) return current;
  for (const name of LEGACY_LOCAL_DATABASE_FILES) {
    if (exists(path.join(dir, name))) return path.join(dir, name);
  }
  return current;
}

function replacePaths(text: string, from: string): string {
  let next = text.replaceAll(`${from}/`, `${LOCAL_STATE_DIR}/`);
  for (const name of LEGACY_LOCAL_DATABASE_FILES) {
    if (name !== LOCAL_DATABASE_FILE) next = next.replaceAll(name, LOCAL_DATABASE_FILE);
  }
  return next;
}

function lakeCatalogs(dir: string): string[] {
  const lake = path.join(dir, 'lake');
  if (!exists(lake)) return [];
  return fs
    .readdirSync(lake)
    .filter((name) => name.endsWith('.ducklake'))
    .map((name) => path.join(lake, name));
}

/** The data path after the folder moves, or undefined when it lies elsewhere. */
function movedDataPath(value: string, root: string, from: string): string | undefined {
  if (value.startsWith(`${from}/`)) return `${LOCAL_STATE_DIR}/${value.slice(from.length + 1)}`;
  const absolute = `${path.join(root, from)}${path.sep}`;
  if (value.startsWith(absolute)) {
    return `${path.join(root, LOCAL_STATE_DIR)}${path.sep}${value.slice(absolute.length)}`;
  }
  return undefined;
}

/** Finishes a takeover that stopped after the folder moved: file name and settings. */
function finish(dir: string): void {
  for (const name of LEGACY_LOCAL_DATABASE_FILES) {
    if (name === LOCAL_DATABASE_FILE) continue;
    for (const suffix of ['', '.wal']) {
      const from = path.join(dir, `${name}${suffix}`);
      const to = path.join(dir, `${LOCAL_DATABASE_FILE}${suffix}`);
      if (exists(from) && !exists(to)) fs.renameSync(from, to);
    }
  }
  const next = path.join(dir, NEXT_CONFIG);
  if (exists(next)) fs.renameSync(next, path.join(dir, 'config.yml'));
  fs.rmSync(path.join(dir, JOURNAL), { force: true });
}

/** Undoes the preparation in a folder that did not move: lake data paths and settings. */
async function rollback(dir: string, options: Options): Promise<void> {
  const journalFile = path.join(dir, JOURNAL);
  if (exists(journalFile)) {
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Journal;
    for (const entry of journal.lake) await options.lake?.write(entry.catalog, entry.dataPath);
  }
  fs.rmSync(path.join(dir, NEXT_CONFIG), { force: true });
  fs.rmSync(journalFile, { force: true });
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = path.join(root, `${LOCAL_STATE_DIR}.takeover.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Moves the earlier folder under the lock; returns the folder to use for this run. */
async function move(root: string, from: string, notice: Notice, options: Options) {
  const current = path.join(root, LOCAL_STATE_DIR);
  const fromName = path.basename(from);
  if (exists(current)) return current;
  // A preparation that stopped before the move is undone first, then redone.
  await rollback(from, options);
  try {
    const config = path.join(from, 'config.yml');
    if (exists(config)) {
      fs.writeFileSync(
        path.join(from, NEXT_CONFIG),
        replacePaths(fs.readFileSync(config, 'utf8'), fromName)
      );
    }
    const lake: Journal['lake'] = [];
    const journal = () =>
      fs.writeFileSync(path.join(from, JOURNAL), JSON.stringify({ from: fromName, lake }));
    for (const catalog of options.lake ? lakeCatalogs(from) : []) {
      const dataPath = await options.lake!.read(catalog);
      const next = dataPath === undefined ? undefined : movedDataPath(dataPath, root, fromName);
      if (dataPath === undefined || next === undefined) continue;
      lake.push({ catalog, dataPath });
      journal();
      await options.lake!.write(catalog, next);
    }
    journal();
    fs.renameSync(from, current);
  } catch (error) {
    await rollback(from, options).catch(() => undefined);
    notice(
      `Could not move ${fromName}/ to ${LOCAL_STATE_DIR}/ (${(error as Error).message}); using ${fromName}/ for this run.`
    );
    return from;
  }
  finish(current);
  notice(
    `Moved ${fromName}/ to ${LOCAL_STATE_DIR}/ (one time). Update your .gitignore: ${fromName}/* becomes ${LOCAL_STATE_DIR}/*.`
  );
  return current;
}

/**
 * Takes over an earlier local state folder once (`.dogsled/` once Core uses `.bobsled/`), with
 * a notice. Under a lock: settings and the lake catalog's data path are prepared, the folder is
 * renamed in one step, then the DuckDB file name and settings are finished. If any step fails
 * the earlier folder is left as it was and used for this run, with a warning. A takeover that
 * stopped half way is finished (or undone and redone) on the next run. When both folders exist
 * the current one is used and the earlier one is never merged or deleted; that is said once.
 * Core changes only its own state inside the folder, never `.gitignore` or project files.
 */
export async function prepareLocalStateDir(
  projectRoot: string,
  options: Options = {}
): Promise<string> {
  const root = path.resolve(projectRoot);
  const known = outcomes.get(root);
  if (known) return known;
  const notice = options.notice ?? defaultNotice;
  const current = path.join(root, LOCAL_STATE_DIR);
  const earlier = earlierDirs()
    .map((name) => path.join(root, name))
    .filter(exists);
  const settle = (dir: string) => {
    outcomes.set(root, dir);
    return dir;
  };
  if (exists(current)) {
    finish(current);
    if (earlier.length && !exists(path.join(current, NOTICED))) {
      const names = earlier.map((dir) => `${path.basename(dir)}/`).join(', ');
      notice(`Using ${LOCAL_STATE_DIR}/; ${names} is ignored and left as it is.`);
      try {
        fs.writeFileSync(path.join(current, NOTICED), '');
      } catch {
        // Read-only: it is said again next time.
      }
    }
    return settle(current);
  }
  if (!earlier.length) return settle(current);
  const from = earlier[0]!;
  const fromName = path.basename(from);
  const moved = await withLock(root, () => move(root, from, notice, options)).catch(
    (error: Error) => {
      notice(
        `Could not move ${fromName}/ to ${LOCAL_STATE_DIR}/ (${error.message}); using ${fromName}/ for this run.`
      );
      return from;
    }
  );
  if (moved === undefined) {
    notice(`Another process is moving ${fromName}/; using ${fromName}/ for this run.`);
    return settle(exists(current) ? current : from);
  }
  return settle(moved);
}

/** The nearest directory at or above `start` that holds a current or earlier state folder. */
export function findLocalStateRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if ([LOCAL_STATE_DIR, ...earlierDirs()].some((name) => exists(path.join(dir, name)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Forget what this process decided (tests only). */
export function resetLocalStateDirForTests(): void {
  outcomes.clear();
}
