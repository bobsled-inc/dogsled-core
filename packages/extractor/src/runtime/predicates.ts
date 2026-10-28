import {
  isRelativeDurationLiteral,
  predicateOperator,
  type Predicate,
} from '../framework/extractor/predicate.js';

export type { Predicate };

/**
 * Resolve a predicate value at run start. Relative durations like `-6mo` are
 * materialized into ISO 8601 strings against `now`, so subsequent per-record
 * evaluation is a plain compare. ISO strings, numbers, booleans, and arrays
 * pass through untouched.
 *
 * Relative durations are **always** interpreted as N units into the past —
 * the leading `-` is purely conventional sugar (so `-6mo` and `6mo` resolve
 * identically). Positive durations into the future have no meaning for the
 * filtering use cases that motivated this primitive, and accepting them
 * here would silently shift cutoffs in the wrong direction.
 */
export function resolvePredicateValue(value: unknown, now: Date): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolvePredicateValue(entry, now));
  }
  if (typeof value !== 'string' || !isRelativeDurationLiteral(value)) {
    return value;
  }
  // Optional leading `-` is intentional sugar — see jsdoc above. Strip it
  // explicitly so the parse is obviously sign-agnostic to future readers.
  const match = value.replace(/^-/, '').match(/^(\d+)(m|h|d|w|mo|y)$/)!;
  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const unitMs: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 86_400_000 * 7,
    mo: 86_400_000 * 30,
    y: 86_400_000 * 365,
  };
  const offset = amount * unitMs[unit]!;
  return new Date(now.getTime() - offset).toISOString();
}

/**
 * Compare two scalar values, returning -1/0/1. Strings are compared with
 * `<`/`>` (so ISO 8601 ordering works), numbers numerically, booleans by
 * stringifying. Mixed types: coerce to string. Returns undefined when either
 * side is null/undefined.
 */
function compareScalar(a: unknown, b: unknown): number | undefined {
  if (a === null || a === undefined || b === null || b === undefined) return undefined;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.sign(a - b);
  }
  const aStr = String(a);
  const bStr = String(b);
  if (aStr < bStr) return -1;
  if (aStr > bStr) return 1;
  return 0;
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }
  if (typeof a === typeof b) return a === b;
  return String(a) === String(b);
}

export interface ResolvedPredicate {
  field: string;
  operator: string;
  /** Pre-resolved against `now` so per-record evaluation is allocation-free. */
  value: unknown;
}

export function resolvePredicate(predicate: Predicate, now: Date): ResolvedPredicate {
  const operator = predicateOperator(predicate);
  const rawValue = (predicate as Record<string, unknown>)[operator];
  return { field: predicate.field, operator, value: resolvePredicateValue(rawValue, now) };
}

/**
 * Evaluate a resolved predicate against a record. Records that don't carry
 * the named field are treated as failing. The comparison operators
 * (`gt`/`gte`/`lt`/`lte`) require both sides to be comparable; a missing or
 * non-scalar field fails.
 */
export function evaluateResolvedPredicate(
  record: Record<string, unknown>,
  predicate: ResolvedPredicate
): boolean {
  const recordValue = record[predicate.field];
  // A missing parent field must fail closed for every operator. In particular,
  // `neq` must not turn an absent provider field into a match. Preserve the
  // existing null behavior so a declared-but-null binding still reports the
  // dedicated null-binding error at fan-out execution time.
  if (recordValue === undefined) return false;
  switch (predicate.operator) {
    case 'eq':
      return scalarEquals(recordValue, predicate.value);
    case 'neq':
      return !scalarEquals(recordValue, predicate.value);
    case 'gt': {
      const cmp = compareScalar(recordValue, predicate.value);
      return cmp !== undefined && cmp > 0;
    }
    case 'gte': {
      const cmp = compareScalar(recordValue, predicate.value);
      return cmp !== undefined && cmp >= 0;
    }
    case 'lt': {
      const cmp = compareScalar(recordValue, predicate.value);
      return cmp !== undefined && cmp < 0;
    }
    case 'lte': {
      const cmp = compareScalar(recordValue, predicate.value);
      return cmp !== undefined && cmp <= 0;
    }
    case 'in': {
      const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
      return values.some((candidate) => scalarEquals(recordValue, candidate));
    }
    case 'contains': {
      if (typeof recordValue !== 'string' || typeof predicate.value !== 'string') return false;
      return recordValue.includes(predicate.value);
    }
    default:
      return false;
  }
}

/** Convenience: resolve then evaluate. Use the precompiled form in hot paths. */
export function evaluatePredicate(
  record: Record<string, unknown>,
  predicate: Predicate,
  now: Date
): boolean {
  return evaluateResolvedPredicate(record, resolvePredicate(predicate, now));
}
