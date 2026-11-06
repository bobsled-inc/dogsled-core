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
    own.every(
      ([key, item]) =>
        Object.prototype.propertyIsEnumerable.call(other, key) && sameJson(item, other[key])
    )
  );
}

/**
 * True only when `value` is `expected`, which must be plain JSON, in every way a validator could
 * notice: the same prototypes and the same own keys, including hidden and symbol keys. Anything
 * else is false, however its values compare, so a caller can send it to a check that decides.
 * `plain` skips that scrutiny for a value known to be plain JSON. Frozen objects the two share
 * compare equal without being read, which is what keeps a shared response cheap.
 */
export function isExactJson(expected: unknown, value: unknown, plain = false): boolean {
  if (expected === value) return true;
  if (
    typeof expected !== 'object' ||
    typeof value !== 'object' ||
    expected === null ||
    value === null ||
    Array.isArray(expected) !== Array.isArray(value) ||
    (!plain && Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected))
  ) {
    return false;
  }
  if (Array.isArray(expected)) {
    const items = value as unknown[];
    if (expected.length !== items.length) return false;
    // An array's own keys are its indexes and `length`.
    if (!plain && Reflect.ownKeys(items).length !== expected.length + 1) return false;
    for (let index = 0; index < expected.length; index++) {
      const item = items[index];
      if (expected[index] !== item && !isExactJson(expected[index], item, plain)) return false;
    }
    return true;
  }
  const keys = Object.keys(expected);
  const count = plain ? Object.keys(value).length : Reflect.ownKeys(value).length;
  if (keys.length !== count) return false;
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (!isExactJson((expected as Record<string, unknown>)[key], item, plain)) return false;
  }
  return true;
}

/** Equivalent to comparing digestAgenticState results for JSON data. Structurally equal
 * values, including copies that share unchanged branches, are compared without hashing. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return sameJson(left, right) || digestAgenticState(left) === digestAgenticState(right);
}
