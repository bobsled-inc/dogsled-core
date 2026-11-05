/** Bound response sections by item count and encoded bytes; never truncate a definition. */
export function boundOntologyItems<T>(values: readonly T[], limit: number, maxBytes = 500_000) {
  const items: T[] = [];
  const omitted: T[] = [];
  let bytes = 0;
  let omittedCount = 0;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (items.length >= limit || bytes + size > maxBytes) {
      if (omitted.length < 200) omitted.push(value);
      omittedCount += 1;
    } else {
      items.push(value);
      bytes += size;
    }
  }
  return { items, omitted, omittedCount, truncated: omittedCount > 0 };
}
