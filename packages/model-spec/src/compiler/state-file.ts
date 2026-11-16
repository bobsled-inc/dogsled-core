/** Shared local state persistence for regular models and agentic checkpoints. */
import * as path from 'node:path';
import { z } from 'zod';
import { CommandError } from '../errors.js';
import {
  acquireFileOwnership,
  ensureStateDirectory,
  readBoundedFile,
  writeDurableFile,
} from './durable-file.js';
import { nodeFs } from './node-fs.js';
import type { FileSystem } from './types.js';
import type { RunState } from './state.js';

const SelectStateColumnSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'timestamp', 'array', 'object']),
    primary_key: z.boolean().default(false),
    not_null: z.boolean().default(false),
  })
  // Same forward-compat rationale as `ModelRunStateSchema`: per-column fields
  // added by a newer Bobsled Core version (e.g. semantic tags, sensitivity flags)
  // must survive a round-trip through an older reader, not be silently
  // dropped on the next saveState().
  .passthrough();

const ModelRunStateSchema = z
  .object({
    lastRunAt: z.string(),
    materialization: z.string(),
    specChecksum: z.string(),
    selectSignature: z.string().optional(),
    columns: z.array(SelectStateColumnSchema).optional(),
    publishedSnapshotId: z.string().optional(),
    publishedAt: z.string().optional(),
    // ---- Config snapshot for transition-drift detection. -------------------
    // Optional so state written by older Bobsled Core versions still loads. A missing
    // field means "don't know" — `planConfigDrift` proceeds without recreating,
    // because forcing a destructive rebuild on an upgrade would be worse than
    // letting one drift slip through until the next legitimate change.
    strategy: z.string().optional(),
    uniqueKey: z.array(z.string()).optional(),
    incrementalFilter: z.string().optional(),
    onSchemaChange: z.string().optional(),
    targetSchema: z.string().optional(),
    targetDatabase: z.string().optional(),
    /**
     * Fully-qualified destination name as Bobsled Core materialized it on the last
     * successful run. Used to DROP the *prior* destination when target_schema
     * or target_database change, so the old table doesn't sit orphaned.
     */
    priorFqName: z.string().optional(),
  })
  // Pass through unknown fields rather than stripping them. State written by
  // a newer Bobsled Core version that adds further fields must still round-trip
  // cleanly through an older reader/writer pair (spec §3, "degrade gracefully").
  .passthrough();

const RunStateSchema = z
  .object({
    models: z.record(z.string(), ModelRunStateSchema),
  })
  // Root-level metadata added by a newer Bobsled Core version (envelope version,
  // run-context provenance, etc.) survives the load → save round-trip
  // instead of being silently stripped.
  .passthrough();

export const localBaselines = new WeakMap<RunState, RunState>();
const STATE_DIR = '.bobsled/model-spec';
const STATE_FILE = 'run-state.json';

export function loadState(dir: string, fsImpl: FileSystem = nodeFs): RunState {
  const current = readStateFile(path.join(dir, STATE_DIR, STATE_FILE), fsImpl);
  if (current !== undefined) {
    localBaselines.set(current, structuredClone(current));
    return current;
  }

  const empty = { models: {} };
  localBaselines.set(empty, { models: {} });
  return empty;
}

/**
 * Read and validate a run-state file. Returns `undefined` when the file does
 * not exist (`ENOENT`) so the caller can fall through to the next location.
 * Throws `CommandError` on every other failure mode — silently returning an
 * empty state on corruption masks data-loss-grade incidents because every
 * incremental/snapshot model would silently rebuild on the next run.
 */
function readStateFile(filePath: string, fsImpl: FileSystem): RunState | undefined {
  let raw: string;
  try {
    raw = fsImpl === nodeFs ? readBoundedFile(filePath) : fsImpl.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return undefined;
    throw new CommandError(
      [
        `Could not read run state at ${filePath}: ${err.message}.`,
        'Fix the file permissions or remove the file (and re-run with --full-refresh) to rebuild state.',
      ].join(' '),
      1
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CommandError(
      [
        `Run state at ${filePath} is not valid JSON: ${(error as Error).message}.`,
        'Delete the file and re-run with --full-refresh to rebuild state.',
      ].join(' '),
      2
    );
  }

  const validated = RunStateSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new CommandError(
      [
        `Run state at ${filePath} failed schema validation: ${issues}.`,
        'Delete the file and re-run with --full-refresh to rebuild state.',
      ].join(' '),
      2
    );
  }

  return validated.data;
}

export function saveState(dir: string, state: RunState, fsImpl: FileSystem = nodeFs): void {
  if (fsImpl !== nodeFs) {
    const stateDir = path.join(dir, STATE_DIR);
    fsImpl.mkdirSync(stateDir, { recursive: true });
    const filePath = path.join(stateDir, STATE_FILE);
    fsImpl.writeFileSync(`${filePath}.tmp`, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fsImpl.renameSync(`${filePath}.tmp`, filePath);
    return;
  }
  const baseline = localBaselines.get(state);
  const changed = new Set<string>();
  const saved = updateLocalState(dir, (current) => {
    const models = { ...current.models };
    for (const key of new Set([
      ...Object.keys(baseline?.models ?? {}),
      ...Object.keys(state.models),
    ])) {
      if (baseline && JSON.stringify(baseline.models[key]) === JSON.stringify(state.models[key])) {
        continue;
      }
      if (
        baseline &&
        JSON.stringify(baseline.models[key]) !== JSON.stringify(current.models[key])
      ) {
        throw new CommandError('Run state changed for the same model; reload before saving.', 1);
      }
      changed.add(key);
      if (state.models[key] === undefined) delete models[key];
      else {
        const unknown = Object.fromEntries(
          Object.entries(current.models[key] ?? {}).filter(
            ([field]) => !Object.hasOwn(ModelRunStateSchema.shape, field)
          )
        );
        models[key] = { ...unknown, ...state.models[key] };
      }
    }
    const next: RunState = { ...current, models };
    for (const key of Object.keys(state)) {
      if (key === 'models' || key === 'agentic') continue;
      if (!baseline || JSON.stringify(baseline[key]) !== JSON.stringify(state[key])) {
        next[key] = state[key];
      }
    }
    return next;
  });
  // Keep the caller's next baseline aligned with fields preserved in its own save.
  for (const key of changed) {
    if (saved.models[key] !== undefined) state.models[key] = structuredClone(saved.models[key]);
  }
  localBaselines.set(state, structuredClone(state));
}

/** Read-modify-write under the same lock used by regular and agentic saves. */
export function updateLocalState(dir: string, update: (state: RunState) => RunState): RunState {
  const directory = ensureStateDirectory(dir);
  const lock = acquireFileOwnership(path.join(directory, 'run-state.lock'));
  try {
    const next = RunStateSchema.parse(update(loadState(dir)));
    lock.assert();
    writeDurableFile(path.join(directory, STATE_FILE), JSON.stringify(next) + '\n');
    return next;
  } finally {
    lock.release();
  }
}
