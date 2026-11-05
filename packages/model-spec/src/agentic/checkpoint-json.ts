/** The most any store can declare for one run's snapshot. */
export const AGENTIC_MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

/** Bound a whole checkpoint before recursive schema parsing or serialization. */
export function isBoundedCheckpoint(value: unknown): boolean {
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
    if (++nodes > 262144 || item.depth > 32) return false;
    const data = item.value;
    if (typeof data === 'string') bytes += Buffer.byteLength(data);
    else if (typeof data === 'number') {
      if (!Number.isFinite(data)) return false;
    } else if (data !== null && typeof data !== 'boolean') {
      if (typeof data !== 'object' || seen.has(data)) return false;
      if (
        !Array.isArray(data) &&
        Object.getPrototypeOf(data) !== Object.prototype &&
        Object.getPrototypeOf(data) !== null
      ) {
        return false;
      }
      seen.add(data);
      pending.push({ value: data, depth: item.depth, leave: true });
      const entries = Object.entries(data);
      if (entries.length > 262144 - nodes) return false;
      for (const [key, child] of entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
        bytes += Buffer.byteLength(key);
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    if (bytes > AGENTIC_MAX_CHECKPOINT_BYTES) return false;
  }
  return Buffer.byteLength(JSON.stringify(value)) <= AGENTIC_MAX_CHECKPOINT_BYTES;
}
