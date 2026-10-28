import { maxCursor as resolveMaxCursor } from '@bobsled-inc/extractor';

import type { CursorType } from './metadata.js';

/**
 * Largest cursor value across fetched records, or undefined when the cursor
 * field is unset or any record is missing it (an absent cursor can't bound the
 * next incremental fetch safely).
 */
export function maxCursorInRecords(
  records: Array<Record<string, unknown>>,
  cursorField: string | undefined,
  cursorType: CursorType | undefined
): string | undefined {
  if (!cursorField || !cursorType || records.length === 0) return undefined;

  let maxSeen: string | undefined;
  for (const record of records) {
    const value = record[cursorField];
    if (value === null || value === undefined) {
      return undefined;
    }
    const text = String(value);
    maxSeen = maxSeen === undefined ? text : resolveMaxCursor(maxSeen, text, cursorType);
  }
  return maxSeen;
}

/**
 * Collapse records that share the same primary key down to one row, keeping the
 * last occurrence in fetch order.
 *
 * A live source has no durable table to reconcile against, so it always lands
 * via `full_refresh`, which inserts every fetched record verbatim (only the
 * `merge` path dedups by key). Cursor pagination over a mutable sort key (e.g.
 * Linear's `orderBy: updatedAt`) can re-serve a record on a later page when it
 * is edited mid-fetch, so the raw fetch can contain duplicate primary keys. A
 * live query must never return two rows with the same key, so collapse here
 * regardless of load strategy.
 *
 * Keeping the last occurrence retains the most-recently-observed copy: a record
 * re-served because its sort key advanced appears again later in the page
 * sequence. Records missing any key component cannot be identified, so they are
 * passed through untouched rather than collapsed together.
 */
export function dedupeByKey(
  records: Array<Record<string, unknown>>,
  keyProperties: string[]
): Array<Record<string, unknown>> {
  if (keyProperties.length === 0 || records.length === 0) return records;

  const byKey = new Map<string, Record<string, unknown>>();
  const passthrough: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const incomplete = keyProperties.some((key) => {
      const value = record[key];
      return value === null || value === undefined;
    });
    if (incomplete) {
      passthrough.push(record);
      continue;
    }
    const key = keyProperties.map((property) => String(record[property])).join('\0');
    byKey.set(key, record);
  }

  if (byKey.size + passthrough.length === records.length) return records;
  return [...byKey.values(), ...passthrough];
}
