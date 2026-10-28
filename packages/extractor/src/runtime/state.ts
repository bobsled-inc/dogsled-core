import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ExtractorStateSchema } from '../schemas/state.js';
import type { ExtractorState } from '../types/index.js';
import type { CursorKind } from '../constants.js';
import { compareCursors, resolveCursorKind } from './cursor.js';

export type StreamBookmark = ExtractorState['streams'][string];
export interface StateStore {
  load(): Promise<ExtractorState>;
  save(state: ExtractorState): Promise<void>;
}

const STATE_FILE = 'state.json';

export class FileStateStore implements StateStore {
  private readonly filePath: string;

  constructor(private readonly stateDir: string) {
    this.filePath = path.join(stateDir, STATE_FILE);
  }

  async load(): Promise<ExtractorState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { streams: {} };
      }
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupted state file ${this.filePath}: invalid JSON`);
    }

    const parsed = ExtractorStateSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Corrupted state file ${this.filePath}: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`
      );
    }
    return parsed.data;
  }

  async save(state: ExtractorState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }
}

export async function loadState(stateDir: string): Promise<ExtractorState> {
  return new FileStateStore(stateDir).load();
}

export async function saveState(stateDir: string, state: ExtractorState): Promise<void> {
  await new FileStateStore(stateDir).save(state);
}

/**
 * Build a deterministic partition string from a map of binding values. Keys
 * are sorted alphabetically and values are URL-encoded so embedded delimiters
 * (`=`, `#`, `::`) in input values cannot collide with the format separators.
 * Returns `undefined` when no bindings are supplied so callers can fall back
 * to the bare resource key.
 */
export function buildBookmarkPartition(
  bindings: Record<string, unknown> | undefined
): string | undefined {
  if (!bindings) {
    return undefined;
  }
  const entries = Object.entries(bindings)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('::');
}

/**
 * Compose the state-file key for a stream. When a `partition` is provided
 * (i.e. the stream is being extracted as one iteration of a `for_each` loop),
 * the key includes the partition suffix so each iteration carries its own
 * cursor. Without a partition, the key shape is unchanged from v1
 * (`integration/resource`) so existing state files keep resolving.
 */
function buildStreamKey(integration: string, resource: string, partition?: string): string {
  const base = `${integration}/${resource}`;
  return partition ? `${base}#${partition}` : base;
}

/**
 * Get bookmark for a stream. When `partition` is provided the lookup is
 * scoped to that iteration's slot — different `for_each` iterations of the
 * same resource carry independent cursors and never poison each other.
 */
export function getStreamBookmark(
  state: ExtractorState,
  integration: string,
  resource: string,
  partition?: string
): StreamBookmark | undefined {
  return state.streams[buildStreamKey(integration, resource, partition)];
}

/**
 * Set bookmark for a stream. See `getStreamBookmark` for partition semantics.
 */
export function setStreamBookmark(
  state: ExtractorState,
  integration: string,
  resource: string,
  bookmark: StreamBookmark,
  partition?: string
): void {
  state.streams[buildStreamKey(integration, resource, partition)] = bookmark;
}

export function mergeDurableBookmark(
  existing: StreamBookmark | undefined,
  candidate: StreamBookmark,
  cursorKind?: CursorKind,
  runAt = candidate.last_run_at
): StreamBookmark | undefined {
  if (!candidate.cursor_field) {
    return undefined;
  }

  if (!existing) {
    if (!candidate.cursor_value) {
      return undefined;
    }
    return {
      ...candidate,
      cursor_type: cursorKind ?? candidate.cursor_type,
      last_run_at: runAt,
    };
  }

  if (!candidate.cursor_value) {
    return {
      ...existing,
      last_run_at: runAt,
    };
  }

  const resolvedKind =
    cursorKind ??
    resolveCursorKind({
      specCursorType: candidate.cursor_type ?? existing.cursor_type,
      hintValue: candidate.cursor_value ?? existing.cursor_value,
    });

  if (!resolvedKind || !existing.cursor_value) {
    return {
      ...candidate,
      cursor_type: resolvedKind ?? candidate.cursor_type ?? existing.cursor_type,
      last_run_at: runAt,
    };
  }

  if (compareCursors(candidate.cursor_value, existing.cursor_value, resolvedKind) > 0) {
    return {
      ...candidate,
      cursor_type: resolvedKind,
      last_run_at: runAt,
    };
  }

  return {
    ...existing,
    cursor_type: resolvedKind,
    last_run_at: runAt,
  };
}
