export const AGENTIC_MAX_CHECKPOINT_VALUES = 262144;
/** The most any store can declare for one run's snapshot. Raising this also raises
 * `maxStoredChars` in row-state-rows.ts, which is derived from it. */
export const AGENTIC_MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 32;

export interface CheckpointMeasure {
  values: number;
  textBytes: number;
}

/**
 * Size a checkpoint or one part of it. Returns undefined as soon as the value breaks a limit or
 * is not plain JSON, before recursive parsing or serialization can run.
 */
export function measureCheckpoint(value: unknown): CheckpointMeasure | undefined {
  const pending: Array<{ value: unknown; depth: number; leave?: boolean }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.leave) {
      seen.delete(item.value as object);
      continue;
    }
    if (++nodes > AGENTIC_MAX_CHECKPOINT_VALUES || item.depth > MAX_DEPTH) return undefined;
    const data = item.value;
    if (typeof data === 'string') bytes += Buffer.byteLength(data);
    else if (typeof data === 'number') {
      if (!Number.isFinite(data)) return undefined;
    } else if (data !== null && typeof data !== 'boolean') {
      if (typeof data !== 'object' || seen.has(data)) return undefined;
      if (
        !Array.isArray(data) &&
        Object.getPrototypeOf(data) !== Object.prototype &&
        Object.getPrototypeOf(data) !== null
      ) {
        return undefined;
      }
      seen.add(data);
      pending.push({ value: data, depth: item.depth, leave: true });
      const entries = Object.entries(data);
      if (entries.length > AGENTIC_MAX_CHECKPOINT_VALUES - nodes) return undefined;
      for (const [key, child] of entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
        bytes += Buffer.byteLength(key);
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    if (bytes > AGENTIC_MAX_CHECKPOINT_BYTES) return undefined;
  }
  return { values: nodes, textBytes: bytes };
}

/** Bound a whole checkpoint before recursive schema parsing or serialization. */
export function isBoundedCheckpoint(value: unknown): boolean {
  return (
    measureCheckpoint(value) !== undefined &&
    Buffer.byteLength(JSON.stringify(value)) <= AGENTIC_MAX_CHECKPOINT_BYTES
  );
}
