import { createLocalAgenticCursorStore } from './local-cursors.js';
import * as fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadState, updateLocalState } from '../compiler/state.js';
import {
  acquireFileOwnership,
  FileOwnershipError,
  ensureStateDirectory,
  readBoundedFile,
  writeDurableFile,
  syncDirectory,
} from '../compiler/durable-file.js';
import {
  AgenticRunKeySchema,
  AgenticRunSnapshotSchema,
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
} from './state.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from './store-limits.js';
import type {
  AgenticRunKey,
  AgenticRunSnapshot,
  AgenticStateStore,
  AgenticStateSession,
} from './state.js';

const IndexSchema = z
  .object({
    version: z.literal(2),
    runs: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.string().regex(/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/)
    ),
  })
  .passthrough()
  .refine((index) => Object.keys(index.runs).length <= 100, 'Too many retained runs');

export interface LocalAgenticOwnership {
  directory: string;
  ownership: ReturnType<typeof acquireFileOwnership>;
}

/** Takes the run's lock. Every local store uses this lock, so a run has one owner whichever
 * store holds it. */
export function acquireLocalRunOwnership(
  project: string,
  key: AgenticRunKey
): LocalAgenticOwnership {
  try {
    const directory = ensureStateDirectory(project);
    const name = `agentic-${digestAgenticState(key)}.lock`;
    return { directory, ownership: acquireFileOwnership(path.join(directory, name)) };
  } catch (error) {
    if (error instanceof AgenticStateError) throw error;
    if (error instanceof FileOwnershipError) throw lockError(error, key.id);
    throw new AgenticStateError(
      'unavailable',
      {
        reason: 'state_directory',
        message: 'Cannot open or lock the local agentic state directory (.dogsled/model-spec).',
        hint: 'Check that the directory is writable and that no other run holds the lock.',
      },
      { cause: error }
    );
  }
}

/** Whether the file store holds this run. */
export function localAgenticRunExists(project: string, key: AgenticRunKey): boolean {
  const index = IndexSchema.parse(loadState(project).agentic ?? { version: 2, runs: {} });
  return index.runs[digestAgenticState(key)] !== undefined;
}

/** Retains up to 100 runs. Each snapshot is at most 16 MiB. No cross-run reuse or expiry. */
export function createLocalAgenticStateStore(project: string): AgenticStateStore {
  return localAgenticStateStore(project);
}

/** `held` is a lock the caller already took for the one run it will acquire. */
export function localAgenticStateStore(
  project: string,
  held?: LocalAgenticOwnership
): AgenticStateStore {
  return {
    cursors: createLocalAgenticCursorStore(project),
    limits: AGENTIC_DEFAULT_STORE_LIMITS,
    async acquire(rawKey): Promise<AgenticStateSession> {
      const key = AgenticRunKeySchema.parse(rawKey);
      const hash = digestAgenticState(key);
      const { directory, ownership } = held ?? acquireLocalRunOwnership(project, key);
      let closed = false;
      const guard = (): void => {
        if (closed) throw new AgenticStateError('conflict');
        try {
          ownership.assert();
        } catch {
          throw new AgenticStateError('conflict');
        }
      };
      const read = (): AgenticRunSnapshot | null => {
        guard();
        try {
          // A prior rename may be visible despite an interrupted/failed directory sync.
          // Confirm the directory before treating any reference as a durable receipt.
          try {
            syncDirectory(directory);
          } catch (error) {
            throw new AgenticStateError(
              'unavailable',
              {
                reason: 'state_sync',
                message: 'Cannot sync the local agentic state directory to disk.',
              },
              { cause: error }
            );
          }
          const state = loadState(project);
          const index = IndexSchema.parse(state.agentic ?? { version: 2, runs: {} });
          const ref = index.runs[hash];
          if (!ref) return null;
          if (!ref.startsWith(`${hash}-`)) throw new AgenticStateError('corrupt');
          const raw = readBoundedFile(path.join(directory, ref));
          const parsed = JSON.parse(raw);
          if (ref !== `${hash}-${digestAgenticState(parsed)}.json`) {
            throw new AgenticStateError('corrupt');
          }
          const snapshot = AgenticRunSnapshotSchema.parse(parsed);
          if (digestAgenticState(snapshot.key) !== hash) throw new AgenticStateError('corrupt');
          return snapshot;
        } catch (error) {
          if (error instanceof AgenticStateError) throw error;
          throw new AgenticStateError('corrupt');
        }
      };
      const write = (snapshot: AgenticRunSnapshot, expected: number | null): AgenticRunSnapshot => {
        guard();
        const validated = AgenticRunSnapshotSchema.parse(snapshot);
        if (digestAgenticState(validated.key) !== hash) throw new AgenticStateError('conflict');
        const ref = `${hash}-${digestAgenticState(validated)}.json`;
        let previous: string | undefined;
        try {
          guard();
          updateLocalState(project, (state) => {
            guard();
            const index = IndexSchema.parse(state.agentic ?? { version: 2, runs: {} });
            previous = index.runs[hash];
            if (
              (expected === null && previous) ||
              (expected !== null && read()?.revision !== expected)
            ) {
              throw new AgenticStateError('conflict');
            }
            const runs = { ...index.runs, [hash]: ref };
            const next = IndexSchema.parse({ ...index, runs });
            assertArtifactCapacity(directory, Buffer.byteLength(JSON.stringify(validated)));
            writeDurableFile(path.join(directory, ref), JSON.stringify(validated));
            if (
              digestAgenticState(JSON.parse(readBoundedFile(path.join(directory, ref)))) !==
              digestAgenticState(validated)
            ) {
              throw new AgenticStateError('corrupt');
            }
            return { ...state, agentic: next };
          });
        } catch (error) {
          if (error instanceof AgenticStateError) throw error;
          throw new AgenticStateError(
            'unavailable',
            { reason: 'state_write', message: 'Cannot save the local agentic checkpoint.' },
            { cause: error }
          );
        }
        // A crash before this cleanup leaves an unreferenced snapshot. Never remove the current one.
        if (previous && previous !== ref) {
          try {
            fs.unlinkSync(path.join(directory, previous));
          } catch {
            /* Safe orphan; retained for manual cleanup. */
          }
        }
        return validated;
      };
      return {
        async read() {
          return read();
        },
        async create(snapshot) {
          guard();
          if (
            snapshot.revision !== 0 ||
            snapshot.status !== 'preparing' ||
            snapshot.work.length ||
            snapshot.charged
          ) {
            throw new AgenticStateError('conflict');
          }
          return write(snapshot, null);
        },
        async checkpoint(command) {
          const current = read();
          if (!current) throw new AgenticStateError('missing');
          const next = applyAgenticCheckpoint(current, command);
          return next.revision === current.revision ? current : write(next, current.revision);
        },
        async release() {
          if (closed) return;
          closed = true;
          ownership.release();
        },
      };
    },
  };
}

/** A held lock is a busy run, not a disk problem; say which. */
function lockError(error: FileOwnershipError, runId: string): AgenticStateError {
  if (error.reason === 'busy') {
    return new AgenticStateError('conflict', {
      reason: 'run_in_progress',
      message: `Run "${runId}" is still active in another Dogsled process${error.ownerPid ? ` (pid ${error.ownerPid})` : ''}.`,
      hint: 'Wait for that process to finish or stop it, then resume.',
    });
  }
  if (error.reason === 'recovery') {
    return new AgenticStateError('unavailable', {
      reason: 'lock_recovery_pending',
      message: `A crash interrupted lock recovery for run "${runId}".`,
      hint: 'Confirm that no Dogsled process is using this project, then delete the agentic-*.lock.recovery file in .dogsled/model-spec.',
    });
  }
  return new AgenticStateError('unavailable', {
    reason: 'lock_foreign_host',
    message: `Run "${runId}" is locked by a Dogsled process on another host or in an unknown format.`,
    hint: 'Local checkpoints support one host. Use a warehouse checkpoint_store for multiple hosts.',
  });
}

function stateDirectoryFull(amount: string): AgenticStateError {
  return new AgenticStateError('limit', {
    reason: 'state_directory_full',
    message: `The local agentic state directory (.dogsled/model-spec) holds ${amount}.`,
    hint: 'Stop all runs, back up the directory, then remove snapshot files that run-state.json no longer references.',
  });
}

/** Bound enumeration and disk use even after repeated interrupted writes. */
function assertArtifactCapacity(directory: string, incoming: number): void {
  const dir = fs.opendirSync(directory);
  let entries = 0;
  let bytes = incoming + 1024 * 1024; // Include room for the shared index replacement.
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++entries > 2000) throw stateDirectoryFull('more than 2,000 files');
      bytes += fs.lstatSync(path.join(directory, entry.name)).size;
      if (bytes > 256 * 1024 * 1024) throw stateDirectoryFull('more than 256 MiB');
    }
  } finally {
    dir.closeSync();
  }
}
