/** Rules for opening a DuckDB file safely from one process. */
import { chmodSync } from 'node:fs';
import { mkdir, readlink, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { throwIfCancelled } from '@bobsled-inc/connections';
import { AgenticStateError } from './state-errors.js';

type Guards = Map<string, Promise<void>>;

/**
 * The package ships separate bundles for each entry point, so module state alone could be
 * duplicated in one process. Separate instances of a file must never overlap: the second
 * sees a stale catalog, and POSIX drops a process's file lock when any descriptor for the
 * file closes, which would let another process open it.
 */
const registry = globalThis as { [key: symbol]: Guards | undefined };
const key = Symbol.for('@bobsled-inc/model-spec/duckdb-file-guards');
const guards: Guards = (registry[key] ??= new Map());

/**
 * `links` is what is left of a limit shared by the whole resolution, because the text of a link
 * can name itself through a directory that does not exist, which no system call reports as a loop.
 */
async function followDuckDbPath(path: string, budget: { links: number }): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const directory = await followDuckDbPath(parent, budget);
    const text =
      (error as NodeJS.ErrnoException).code === 'ENOENT' && budget.links > 0
        ? await readlink(absolute).catch(() => undefined)
        : undefined;
    if (text === undefined) return resolve(directory, basename(absolute));
    budget.links--;
    // One part at a time: `..` after a part that is itself a link means that link's parent.
    let current = isAbsolute(text) ? parse(text).root : directory;
    for (const part of text.split(sep)) {
      if (part === '..') current = dirname(current);
      else if (part && part !== '.') current = await followDuckDbPath(join(current, part), budget);
    }
    return current;
  }
}

/**
 * Where a path really leads, following links as far as anything exists, and creating nothing.
 * A link to a file that does not exist yet names the place that file will have.
 */
export function realDuckDbPath(path: string): Promise<string> {
  return followDuckDbPath(path, { links: 32 });
}

/** The path a store opens, creating its parent directory if necessary. */
export async function canonicalDuckDbPath(path: string): Promise<string> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  return realDuckDbPath(path);
}

/**
 * DuckDB creates its files with the default permissions, and state holds frozen inputs and
 * results. A file system without modes must not stop the run.
 */
export function keepDuckDbFilePrivate(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Nothing more can be done here. The docs say to keep the directory private as well.
  }
}

/** Runs `operation` after every earlier operation on this file in this process has finished. */
export async function withDuckDbFile<T>(canonical: string, operation: () => Promise<T>) {
  const previous = guards.get(canonical) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  guards.set(canonical, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (guards.get(canonical) === current) guards.delete(canonical);
  }
}

function isDuckDbFileLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Could not set lock on file');
}

/**
 * Another process holding the file makes DuckDB fail at once rather than wait. Files opened
 * per operation are busy for milliseconds, so wait for them, within a bound.
 */
export async function openDuckDbWithRetry<T>(
  open: () => Promise<T>,
  options: { waitMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const waitMs = options.waitMs ?? 30_000;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await open();
    } catch (error) {
      if (!isDuckDbFileLocked(error)) throw error;
      if (Date.now() - started >= waitMs) {
        throw new AgenticStateError(
          'unavailable',
          {
            reason: 'state_file_locked',
            message: 'Another process is holding the DuckDB checkpoint file.',
            hint: 'Close other programs that have this file open, then resume.',
          },
          { cause: error }
        );
      }
      const cap = Math.min(250, 5 * 2 ** Math.min(attempt, 6));
      const wait = Math.floor(cap * (0.5 + Math.random() / 2));
      await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
    }
  }
}
