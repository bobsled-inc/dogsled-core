/**
 * Stable, machine-readable error codes for Model Spec validation/compilation failures.
 *
 * The host agent (and any consumer that wants to auto-recover from a
 * compile error) branches on these. Each message is prefixed with `[CODE]`
 * so a regex over the error text yields the code without extra plumbing
 * through Zod's `params`.
 *
 * When adding a new code: keep it SCREAMING_SNAKE_CASE, document the
 * symptom one line below, and make the message fix-suggesting.
 */

/** Stable error codes emitted as `[CODE] message` so agents can branch on them. */
export const MODEL_SPEC_ERROR_CODES = {
  JSON_PATH_DOUBLE_ROOT: 'JSON_PATH_DOUBLE_ROOT',
  LEGACY_TYPE_LITERAL: 'LEGACY_TYPE_LITERAL',
  BACKTICK_IDENT: 'BACKTICK_IDENT',
  MISPLACED_TARGET_SCHEMA: 'MISPLACED_TARGET_SCHEMA',
  UNKNOWN_MODEL_SPEC_CONFIG_KEY: 'UNKNOWN_MODEL_SPEC_CONFIG_KEY',
  VQ_TYPE_LITERAL_MISMATCH: 'VQ_TYPE_LITERAL_MISMATCH',
  UNKNOWN_PIPELINE_TYPE: 'UNKNOWN_PIPELINE_TYPE',
  FQN_IN_RESOURCE_TABLE: 'FQN_IN_RESOURCE_TABLE',
  BQ_USES_DATASET: 'BQ_USES_DATASET',
  UNRESOLVED_REF_WITH_HINT: 'UNRESOLVED_REF_WITH_HINT',
} as const;

export type ModelSpecErrorCode =
  (typeof MODEL_SPEC_ERROR_CODES)[keyof typeof MODEL_SPEC_ERROR_CODES];

/** Prefix a message with the stable error code so agents can regex on `[CODE]`. */
export function modelSpecHint(code: ModelSpecErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

/**
 * Damerau-Levenshtein-style edit distance, capped at `max` for early exit.
 * Used for "did you mean" hints; we don't need the exact distance past the cap.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Single-row DP to keep memory minimal.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = Math.min(del, ins, sub);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Return the single best fuzzy match for `needle` from `candidates`, or
 * `undefined` if nothing is within `maxDistance` edits. Case-insensitive.
 */
export function didYouMean(
  needle: string,
  candidates: Iterable<string>,
  maxDistance = 2
): string | undefined {
  const lower = needle.toLowerCase();
  let best: string | undefined;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    const dist = editDistance(lower, candidate.toLowerCase(), maxDistance);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
      if (bestDist === 0) break;
    }
  }
  return best;
}
