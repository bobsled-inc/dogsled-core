/**
 * The store used when a host supplies none and no checkpoint_store is configured. New runs
 * use a DuckDB file each when the optional driver is available, and otherwise the file store.
 * A run stays in the store that created it. Both share one lock file per run, so a run has
 * one owner however the two are installed.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { buildDuckDbRunner, isDuckDbAvailable, throwIfCancelled } from '@bobsled-inc/connections';
import { ensureStateDirectory, acquireFileOwnership } from '../compiler/durable-file.js';
import { duckDbHeldBackend, duckDbOperationBackend, duckDbStateFile } from './duckdb-state.js';
import { readLocalAgenticCursor } from './local-cursors.js';
import {
  acquireLocalRunOwnership,
  createLocalAgenticStateStore,
  localAgenticRunExists,
  localAgenticStateStore,
  type LocalAgenticOwnership,
} from './local-state.js';
import { createAgenticRowCursorStore, readAgenticRowCursor } from './row-cursors.js';
import { agenticRowDb, duckDbRowDialect } from './row-state-dialect.js';
import { openAgenticRowSession } from './row-state.js';
import {
  AGENTIC_ROW_RETENTION_MS,
  AGENTIC_RUNS_TABLE,
  agenticRowTable,
  prepareAgenticRowTables,
} from './row-state-tables.js';
import {
  AgenticRunKeySchema,
  AgenticStateError,
  digestAgenticState,
  type AgenticRunKey,
  type AgenticStateSession,
  type AgenticStateStore,
} from './state.js';
import type { AgenticCursorKey, AgenticCursorStore, CursorRecord } from './cursor.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from './store-limits.js';

export interface DefaultAgenticStateOptions {
  /** How long a finished run stays after its last write. Default: 30 days. */
  retentionMs?: number;
  signal?: AbortSignal;
}

const STATE_DIRECTORY = 'agentic-state';
const CURSOR_FILE = 'cursors.duckdb';
const RUN_FILE = /^run-([a-f0-9]{64})\.duckdb$/;
/** Files inspected per acquisition, so a large backlog cannot delay a run. */
const maxSweptFiles = 8;

/** A private directory: DuckDB creates its files with the default permissions. */
function ensureRunDirectory(project: string): string {
  const directory = path.join(ensureStateDirectory(project), STATE_DIRECTORY);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('State directory must remain inside the project');
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

/** State files must be real files in the state directory, like the file store's snapshots. */
function assertPlainFile(file: string): void {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('State file must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const removeRunFile = (file: string): void => {
  for (const name of [file, `${file}.wal`]) fs.rmSync(name, { force: true });
};

function duckDbRequired(key?: AgenticRunKey): AgenticStateError {
  return new AgenticStateError('unavailable', {
    reason: 'duckdb_required',
    message: key
      ? `Run "${key.id}" is saved in a DuckDB state file, but @duckdb/node-api is not available.`
      : 'Incremental progress is saved in a DuckDB state file, but @duckdb/node-api is not available.',
    hint: 'Install @duckdb/node-api, then resume. Dogsled will not start this work again from older state.',
  });
}

/**
 * Removes expired run files. Best effort: a run file that cannot be locked or read is left.
 * The file's modification time only selects candidates; the header decides.
 */
async function sweepExpiredRuns(
  stateDirectory: string,
  directory: string,
  retentionMs: number
): Promise<void> {
  const cutoff = Date.now() - retentionMs;
  let inspected = 0;
  for (const name of fs.readdirSync(directory)) {
    const match = RUN_FILE.exec(name);
    if (!match || inspected >= maxSweptFiles) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      inspected++;
      const lock = acquireFileOwnership(path.join(stateDirectory, `agentic-${match[1]}.lock`));
      try {
        const runner = await buildDuckDbRunner(duckDbStateFile(file), { isolated: true });
        let expired: boolean;
        try {
          const db = agenticRowDb(runner);
          const namespace = duckDbRowDialect.identifier('main');
          await prepareAgenticRowTables(db, duckDbRowDialect, namespace);
          const table = agenticRowTable(duckDbRowDialect, namespace, AGENTIC_RUNS_TABLE);
          const q = duckDbRowDialect.identifier;
          const rows = await db.query(
            `SELECT ${q('retain_until')} <= ${duckDbRowDialect.clock} AND ${q('reclaimable')} AS ${q('expired')} FROM ${table} LIMIT 2`
          );
          expired = rows.length === 0 || (rows.length === 1 && rows[0]!.expired === true);
        } finally {
          await runner.close?.();
        }
        if (expired) removeRunFile(file);
        // Still owed recovery: do not inspect it again for another retention period.
        else fs.utimesSync(file, new Date(), new Date());
      } finally {
        lock.release();
      }
    } catch {
      // A live owner holds the lock, or the file is unreadable. Leave it for its owner.
    }
  }
}

async function openRunFile(
  project: string,
  key: AgenticRunKey,
  { directory: stateDirectory, ownership }: LocalAgenticOwnership,
  options: DefaultAgenticStateOptions
): Promise<AgenticStateSession> {
  const retentionMs = options.retentionMs ?? AGENTIC_ROW_RETENTION_MS;
  const directory = ensureRunDirectory(project);
  const file = path.join(directory, `run-${digestAgenticState(key)}.duckdb`);
  assertPlainFile(file);
  assertPlainFile(`${file}.wal`);
  const existed = fs.existsSync(file);
  await sweepExpiredRuns(stateDirectory, directory, retentionMs);
  let session: AgenticStateSession;
  try {
    // No signal after this point. A stopping run still saves answers it has paid for, and a
    // local commit takes about a millisecond, so there is nothing to cancel.
    session = await openAgenticRowSession(duckDbHeldBackend(file), key, {
      ownership: { mode: 'exclusive', assert: ownership.assert },
      limits: AGENTIC_DEFAULT_STORE_LIMITS,
      retentionMs,
    });
  } catch (error) {
    if (error instanceof AgenticStateError) throw error;
    throw new AgenticStateError(
      'unavailable',
      {
        reason: 'state_file',
        message: 'Cannot open the DuckDB state file for this run.',
        hint: 'Check that nothing else has the file open and that it is not damaged.',
      },
      { cause: error }
    );
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // The directory is already private; a file system without modes must not stop the run.
  }
  // Opening a run that was never created must leave nothing behind.
  let stored = existed;
  let released = false;
  return {
    read: async () => {
      const value = await session.read();
      stored ||= value !== null;
      return value;
    },
    create: (snapshot) => {
      stored = true;
      return session.create(snapshot);
    },
    checkpoint: (command) => session.checkpoint(command),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await session.release();
        if (!stored) removeRunFile(file);
      } finally {
        ownership.release();
      }
    },
  };
}

/** The progress this store holds for a key, wherever it is, for a store that takes over. */
export async function readDefaultAgenticCursor(
  project: string,
  key: AgenticCursorKey
): Promise<CursorRecord | null> {
  const file = path.join(ensureStateDirectory(project), STATE_DIRECTORY, CURSOR_FILE);
  const moved = fs.existsSync(file)
    ? await readAgenticRowCursor(duckDbOperationBackend(file, 'main'), key)
    : null;
  return moved ?? readLocalAgenticCursor(project, key);
}

export function createDefaultAgenticStateStore(
  project: string,
  options: DefaultAgenticStateOptions = {}
): AgenticStateStore {
  const { signal } = options;
  const fileStore = createLocalAgenticStateStore(project);
  let resolvedCursors: Promise<AgenticCursorStore> | undefined;
  const resolveCursors = (): Promise<AgenticCursorStore> =>
    (resolvedCursors ??= (async () => {
      const directory = path.join(ensureStateDirectory(project), STATE_DIRECTORY);
      const file = path.join(directory, CURSOR_FILE);
      if (await isDuckDbAvailable()) {
        ensureRunDirectory(project);
        assertPlainFile(file);
        return createAgenticRowCursorStore({
          backend: duckDbOperationBackend(file, 'main', signal),
          legacy: async (key) => readLocalAgenticCursor(project, key),
          // This store can also open the old run, so takeover still works.
          carryLegacyOwner: true,
          ...(signal ? { signal } : {}),
        });
      }
      // Progress moved to this file. Older values would process rows a second time.
      if (fs.existsSync(file)) throw duckDbRequired();
      return fileStore.cursors!;
    })());
  return {
    limits: AGENTIC_DEFAULT_STORE_LIMITS,
    expiresRuns: true,
    cursors: {
      supersede: async (key, signature, previousRunId, runId) =>
        (await resolveCursors()).supersede!(key, signature, previousRunId, runId),
      begin: async (key, signature, runId) => (await resolveCursors()).begin(key, signature, runId),
      commit: async (key, signature, runId, values) =>
        (await resolveCursors()).commit(key, signature, runId, values),
    },
    async acquire(rawKey) {
      throwIfCancelled(signal);
      const key = AgenticRunKeySchema.parse(rawKey);
      const available = await isDuckDbAvailable();
      // Decide where a run lives only as its owner: another process could be creating it.
      const held = acquireLocalRunOwnership(project, key);
      try {
        const file = path.join(
          held.directory,
          STATE_DIRECTORY,
          `run-${digestAgenticState(key)}.duckdb`
        );
        let inFileStore: boolean;
        try {
          inFileStore = localAgenticRunExists(project, key);
        } catch {
          throw new AgenticStateError('corrupt');
        }
        if (!inFileStore && fs.existsSync(file) && !available) throw duckDbRequired(key);
        if (inFileStore || !available) {
          return await localAgenticStateStore(project, held).acquire(key);
        }
        return await openRunFile(project, key, held, options);
      } catch (error) {
        held.ownership.release();
        throw error;
      }
    },
  };
}
