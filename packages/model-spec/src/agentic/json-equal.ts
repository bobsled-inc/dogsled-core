import { digestAgenticState } from './state.js';

/** True only when both values have the same canonical JSON. False can be spurious, never wrong. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right) ||
    // Canonicalization serializes these with JSON.stringify instead of sorting keys.
    (left as { toJSON?: unknown }).toJSON != null ||
    (right as { toJSON?: unknown }).toJSON != null
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    const items = right as unknown[];
    if (left.length !== items.length) return false;
    for (let index = 0; index < left.length; index++) {
      // Canonicalization skips holes, so only dense arrays are compared here.
      if (!(index in left) || !(index in items) || !sameJson(left[index], items[index])) {
        return false;
      }
    }
    return true;
  }
  const fields = (value: object) => Object.entries(value).filter(([, item]) => item !== undefined);
  const own = fields(left);
  const other = right as Record<string, unknown>;
  return (
    own.length === fields(right).length &&
    own.every(([key, item]) => Object.hasOwn(other, key) && sameJson(item, other[key]))
  );
}

/** Equivalent to comparing digestAgenticState results for JSON data. Structurally equal
 * values, including copies that share unchanged branches, are compared without hashing. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return sameJson(left, right) || digestAgenticState(left) === digestAgenticState(right);
}
