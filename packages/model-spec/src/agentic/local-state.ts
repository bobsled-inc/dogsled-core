import { createLocalAgenticCursorStore } from './local-cursors.js';
import * as fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadState, updateLocalState } from '../compiler/state.js';
import {
  acquireFileOwnership,
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
import type { AgenticRunSnapshot, AgenticStateStore, AgenticStateSession } from './state.js';

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

/** Retains up to 100 runs. Each snapshot is at most 16 MiB. No cross-run reuse or expiry. */
export function createLocalAgenticStateStore(project: string): AgenticStateStore {
  return {
    cursors: createLocalAgenticCursorStore(project),
    async acquire(rawKey): Promise<AgenticStateSession> {
      const key = AgenticRunKeySchema.parse(rawKey);
      const hash = digestAgenticState(key);
      let directory: string;
      let ownership: ReturnType<typeof acquireFileOwnership>;
      try {
        directory = ensureStateDirectory(project);
        ownership = acquireFileOwnership(path.join(directory, `agentic-${hash}.lock`));
      } catch {
        throw new AgenticStateError('unavailable');
      }
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
          } catch {
            throw new AgenticStateError('unavailable');
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
          throw new AgenticStateError('unavailable');
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

/** Bound enumeration and disk use even after repeated interrupted writes. */
function assertArtifactCapacity(directory: string, incoming: number): void {
  const dir = fs.opendirSync(directory);
  let entries = 0;
  let bytes = incoming + 1024 * 1024; // Include room for the shared index replacement.
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++entries > 2000) throw new AgenticStateError('limit');
      bytes += fs.lstatSync(path.join(directory, entry.name)).size;
      if (bytes > 256 * 1024 * 1024) throw new AgenticStateError('limit');
    }
  } finally {
    dir.closeSync();
  }
}
