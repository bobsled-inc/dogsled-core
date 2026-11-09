import { createAgenticRowCursorStore, type AgenticLegacyCursorReader } from './row-cursors.js';
import { openAgenticRowSession } from './row-state.js';
import type { AgenticRowBackend } from './row-state-tables.js';
import type { AgenticStateStore } from './state.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from './store-limits.js';

/** Shared tables behind a fenced lease: what every SQL engine needs beyond its dialect. */
export function createAgenticRowStore(
  backend: AgenticRowBackend,
  options: {
    leaseMs: number;
    retentionMs: number;
    signal?: AbortSignal;
    legacyCursors?: AgenticLegacyCursorReader;
    /** Experimental: commit waiting commands together. Off by default. */
    groupCommit?: boolean;
  }
): AgenticStateStore {
  const { leaseMs, retentionMs, signal, legacyCursors, groupCommit } = options;
  const limits = AGENTIC_DEFAULT_STORE_LIMITS;
  const cancellation = signal ? { signal } : {};
  return {
    limits,
    expiresRuns: true,
    cursors: createAgenticRowCursorStore({
      backend,
      ...cancellation,
      ...(legacyCursors ? { legacy: legacyCursors } : {}),
    }),
    acquire: (key) =>
      openAgenticRowSession(backend, key, {
        ownership: { mode: 'lease', leaseMs },
        limits,
        retentionMs,
        ...cancellation,
        ...(groupCommit ? { groupCommit } : {}),
      }),
  };
}
