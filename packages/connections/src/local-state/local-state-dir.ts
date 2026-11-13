import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LEGACY_LOCAL_DATABASE_FILES, LEGACY_LOCAL_STATE_DIRS } from './legacy-names.js';

/** The project's local state folder (settings, local data, run state). */
export const LOCAL_STATE_DIR = '.dogsled';
/** The default local DuckDB file inside it. */
export const LOCAL_DATABASE_FILE = 'dogsled.duckdb';

const NEXT_CONFIG = 'config.yml.takeover';
const JOURNAL = '.takeover.json';
const NOTICED = '.earlier-folder-noticed';
const KEPT_NOTICED = '.kept-in-place-noticed';
const LOCK_OWNER = 'owner.json';
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 30_000;
/** What Core keeps in the folder; a folder with none of these is not Core's state. */
const CORE_STATE_ENTRIES = new Set([
  'config.yml',
  'model-spec',
  'lake',
  'onboarding',
  'onboard',
  'sync-state',
  'tutor-lab',
  'tmp',
  JOURNAL,
]);
/** Files that mean a process was using the folder and has not finished: it is not moved. */
const BUSY_SUFFIXES = ['.wal', '.lock.recovery'];

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
  /** Whether a DuckDB file is open in another process; the folder then stays where it is. */
  databaseInUse?: (file: string) => Promise<boolean>;
  /**
   * Project files that name the earlier folder in a path. While any does, the earlier folder is
   * read in place, so a path the user wrote keeps working.
   */
  referencedBy?: (folderName: string) => string[];
}
interface Journal {
  from: string;
  lake: { catalog: string; dataPath: string }[];
}

const outcomes = new Map<string, string>();
const earlierDirs = () => LEGACY_LOCAL_STATE_DIRS.filter((name) => name !== LOCAL_STATE_DIR);
const exists = (file: string) => fs.existsSync(file);
const defaultNotice: Notice = (message) => process.stderr.write(`${message}\n`);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

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

/** Whether a folder holds Core's state: the installer's folder or a user's own does not. */
function isCoreState(dir: string): boolean {
  const entries = fs.readdirSync(dir);
  if (entries.includes('bin')) return false;
  return entries.some(
    (name) => CORE_STATE_ENTRIES.has(name) || name.endsWith('.duckdb') || name.endsWith('.ducklake')
  );
}

/** Every file and link under `dir`, to a small depth: Core's state is shallow. */
function filesUnder(dir: string, depth = 3): string[] {
  if (depth < 0) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(file, depth - 1);
    return entry.isFile() || entry.isSymbolicLink() ? [file] : [];
  });
}

/** Whether a process named by host and pid may still run: elsewhere it cannot be checked. */
const running = (host: string | undefined, pid: number | undefined) =>
  host !== os.hostname() || (typeof pid === 'number' && alive(pid));

/** Whether a run lock (a link naming `host:pid:token`) or a sync lease has a live holder. */
function held(file: string): boolean {
  try {
    if (file.endsWith('.lock')) {
      const [host, pid] = fs.readlinkSync(file).split(':');
      return running(host, Number(pid));
    }
    if (path.basename(file) === 'lease.json') {
      const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const until = Date.parse(String(lease['acquired_at'])) + Number(lease['ttl_seconds']) * 1000;
      return Date.now() < until && running(lease['host'] as string, lease['pid'] as number);
    }
  } catch {
    return true;
  }
  return false;
}

/** Why the folder must not move now, if another process may be using it. */
async function busyReason(dir: string, options: Options): Promise<string | undefined> {
  const files = filesUnder(dir);
  const marker = files.find(
    (file) => BUSY_SUFFIXES.some((suffix) => file.endsWith(suffix)) || held(file)
  );
  if (marker) {
    return `${path.relative(dir, marker)} shows a process is using the folder or stopped mid-write`;
  }
  if (!options.databaseInUse) return undefined;
  for (const file of files.filter((name) => /\.(duckdb|ducklake)$/.test(name))) {
    if (await options.databaseInUse(file)) {
      return `${path.relative(dir, file)} is open in another process`;
    }
  }
  return undefined;
}

/**
 * Settings paths into the moved folder: `<from>/` at the start of a value or after a separator,
 * and `<root>/<from>/`. The DuckDB file is renamed only inside those paths.
 */
function replacePaths(text: string, root: string, from: string): string {
  let next = text;
  for (const base of new Set([root, realpath(root)])) {
    next = next.replaceAll(`${base}${path.sep}${from}/`, `${base}${path.sep}${LOCAL_STATE_DIR}/`);
  }
  next = next.replace(new RegExp(`(^|[\\s'":=,[])${escape(from)}/`, 'gm'), `$1${LOCAL_STATE_DIR}/`);
  for (const name of LEGACY_LOCAL_DATABASE_FILES) {
    if (name === LOCAL_DATABASE_FILE) continue;
    next = next.replace(
      new RegExp(`${escape(`${LOCAL_STATE_DIR}/${name}`)}(?![\\w.-])`, 'g'),
      `${LOCAL_STATE_DIR}/${LOCAL_DATABASE_FILE}`
    );
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

/**
 * The data path after the folder moves, undefined when it does not name the folder, and an
 * error when it names a folder of that name it cannot place: the move would strand its data.
 */
function movedDataPath(value: string, root: string, from: string): string | undefined {
  if (value.startsWith(`${from}/`)) return `${LOCAL_STATE_DIR}/${value.slice(from.length + 1)}`;
  const segment = `${path.sep}${from}${path.sep}`;
  const at = value.indexOf(segment);
  if (at < 0) return undefined;
  const base = value.slice(0, at);
  if (realpath(path.resolve(root, base)) === realpath(root)) {
    return `${base}${path.sep}${LOCAL_STATE_DIR}${path.sep}${value.slice(at + segment.length)}`;
  }
  throw new Error(`a lake's data path names ${from}/ outside this project`);
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

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

function readOwner(lock: string): LockOwner | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(lock, LOCK_OWNER), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock whose process on this host is gone, or that is older than any takeover takes. */
function isStale(lock: string, owner: LockOwner | undefined): boolean {
  if (owner && owner.host === os.hostname() && !alive(owner.pid)) return true;
  const stat = fs.statSync(lock, { throwIfNoEntry: false });
  return !!stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
}

/**
 * Removes a stale lock, and only that one: it is renamed aside first, and put back if another
 * waiter replaced it in the meantime.
 */
function removeStale(lock: string, owner: LockOwner | undefined): void {
  const aside = `${lock}.${randomUUID()}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return;
  }
  if (readOwner(aside)?.token !== owner?.token) {
    try {
      fs.renameSync(aside, lock);
      return;
    } catch {
      // The other waiter's lock is gone; it finishes under its own check that the folder moved.
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = path.join(root, `${LOCAL_STATE_DIR}.takeover.lock`);
  const owner: LockOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, LOCK_OWNER), JSON.stringify(owner));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readOwner(lock);
      if (isStale(lock, holder)) {
        removeStale(lock, holder);
        continue;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    if (readOwner(lock)?.token === owner.token) fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Moves the earlier folder under the lock; returns the folder to use for this run. */
async function move(root: string, from: string, notice: Notice, options: Options) {
  const current = path.join(root, LOCAL_STATE_DIR);
  const fromName = path.basename(from);
  if (exists(current)) return current;
  const busy = await busyReason(from, options);
  if (busy) {
    notice(`Kept ${fromName}/ for this run: ${busy}.`);
    return from;
  }
  // A preparation that stopped before the move is undone first, then redone.
  await rollback(from, options);
  try {
    const config = path.join(from, 'config.yml');
    if (exists(config)) {
      fs.writeFileSync(
        path.join(from, NEXT_CONFIG),
        replacePaths(fs.readFileSync(config, 'utf8'), root, fromName)
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
  try {
    finish(current);
  } catch (error) {
    // The journal stays, so the next run finishes the move.
    notice(
      `Moved ${fromName}/ to ${LOCAL_STATE_DIR}/; the rest is finished next run (${(error as Error).message}).`
    );
    return current;
  }
  notice(
    `Moved ${fromName}/ to ${LOCAL_STATE_DIR}/ (one time). Update your .gitignore: ${fromName}/* becomes ${LOCAL_STATE_DIR}/*.`
  );
  return current;
}

const modified = (dir: string) => {
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  return stat ? stat.mtime.toISOString().slice(0, 10) : 'unknown';
};

/**
 * Takes over an earlier local state folder once (`.dogsled/` once Core uses `.bobsled/`), with
 * a notice. Only Core's own state at this project root moves: a folder without Core's state, one
 * that project files name in a path, or one another process is using stays where it is and is
 * read in place. Under a lock: settings and the lake catalog's data path are prepared, the folder
 * is renamed in one step, then the DuckDB file name and settings are finished. If any step fails
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
    if (exists(path.join(current, JOURNAL))) {
      try {
        finish(current);
      } catch {
        // Finished on a later run; the journal stays until then.
      }
    }
    if (earlier.length && !exists(path.join(current, NOTICED))) {
      const names = earlier
        .map((dir) => `${path.basename(dir)}/ (last changed ${modified(dir)})`)
        .join(', ');
      notice(
        `Using ${LOCAL_STATE_DIR}/ (last changed ${modified(current)}); ${names} is ignored and left as it is.`
      );
      try {
        fs.writeFileSync(path.join(current, NOTICED), '');
      } catch {
        // Read-only: it is said again next time.
      }
    }
    return settle(current);
  }
  const from = earlier.find((dir) => isCoreState(dir));
  if (!from) return settle(earlier.length ? earlier[0]! : current);
  const fromName = path.basename(from);
  const references = options.referencedBy?.(fromName) ?? [];
  if (references.length) {
    if (!exists(path.join(from, KEPT_NOTICED))) {
      notice(
        `Kept ${fromName}/: ${references.join(', ')} ${references.length === 1 ? 'names' : 'name'} it in a path. Core moves it to ${LOCAL_STATE_DIR}/ once nothing does.`
      );
      try {
        fs.writeFileSync(path.join(from, KEPT_NOTICED), '');
      } catch {
        // Read-only: it is said again next time.
      }
    }
    return settle(from);
  }
  const moved = await withLock(root, () => move(root, from, notice, options)).catch(
    (error: Error) => {
      notice(
        `Could not move ${fromName}/ to ${LOCAL_STATE_DIR}/ (${error.message}); using ${fromName}/ for this run.`
      );
      return exists(from) ? from : current;
    }
  );
  if (moved === undefined) {
    notice(`Another process is moving ${fromName}/; using ${fromName}/ for this run.`);
    return settle(exists(current) ? current : from);
  }
  return settle(moved);
}

/**
 * The nearest folder at or above `start` with a takeover to do or finish: one holding an earlier
 * state folder, or a current one a takeover stopped in. A folder holding only a current state
 * folder ends the search. Cheap: it only checks names, so a command pays nothing when there is no
 * earlier folder.
 */
export function localStateTakeoverRoot(start: string): string | undefined {
  if (!earlierDirs().length) return undefined;
  let dir = path.resolve(start);
  for (;;) {
    if (earlierDirs().some((name) => exists(path.join(dir, name)))) return dir;
    if (exists(path.join(dir, LOCAL_STATE_DIR, JOURNAL))) return dir;
    if (exists(path.join(dir, LOCAL_STATE_DIR))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Forget what this process decided (tests only). */
export function resetLocalStateDirForTests(): void {
  outcomes.clear();
}
