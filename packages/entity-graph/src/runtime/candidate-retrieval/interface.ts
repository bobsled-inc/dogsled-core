/**
 * Cross-warehouse candidate retrieval.
 *
 * Returns the top-K entity candidates for a mention surface form. Each
 * dialect uses its native fuzzy-match function:
 *  - DuckDB: jaro_winkler_similarity
 *  - Postgres: pg_trgm % operator + GIN index
 *  - Snowflake: JAROWINKLER_SIMILARITY (returns 0-100, normalized)
 *  - BigQuery: pre-computed shingle table + JOIN
 *
 * Results normalized to typed candidates regardless of dialect. Ordering
 * tolerance: top-K identity by *set* equality on
 * entity_type/entity_id (not ranked sequence); tie-break on entity_type,
 * entity_id lexicographic; similarity scores compared with Math.abs(a-b) <
 * 1e-3.
 */

import { CommandError } from '@bobsled-inc/protocol';

export interface Candidate {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  matched_text: string;
  match_source: string;
  profile_attrs: string | null;
  sim: number;
}

/**
 * Validated row shape produced by every dialect's `entity_id / canonical_name /
 * sim` projection. Runner adapters declare this as their return type so
 * `Record<string, unknown>` never leaks across the strategy boundary, and
 * `validateCandidateRetrievalRow` defends the invariant at runtime when a
 * driver returns a loosely-typed bag.
 */
export interface CandidateRetrievalRow {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  matched_text: string;
  match_source: string;
  profile_attrs: string | null;
  sim: number;
}

interface CandidateRetrievalRawRow {
  entity_id?: unknown;
  entity_type?: unknown;
  canonical_name?: unknown;
  matched_text?: unknown;
  match_source?: unknown;
  profile_attrs?: unknown;
  sim?: unknown;
}

export interface CandidateRetrievalInput {
  mention_text: string;
  k: number;
  /** Lower bound; candidates below are excluded. */
  min_sim: number;
  /** Optional domain entity type filter for single- or multi-entity specs. */
  entity_types?: readonly string[];
}

export interface CandidateRetrievalStrategy {
  readonly dialect: 'duckdb' | 'postgres' | 'snowflake' | 'bigquery';
  retrieve(input: CandidateRetrievalInput): Promise<Candidate[]>;
}

function coerceSimilarity(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim().length > 0) return Number(value);
  return undefined;
}

/**
 * Narrow an unknown candidate row into the typed contract or throw
 * `CommandError(1)` with the offending row index. Used by every strategy so
 * malformed driver output fails fast instead of poisoning retrieval with
 * `"undefined"` entity_ids or zero-score candidates.
 */
export function validateCandidateRetrievalRow(row: unknown, index: number): CandidateRetrievalRow {
  if (typeof row !== 'object' || row === null) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} is not an object (received ${typeof row}).`,
      1
    );
  }
  const r = row as CandidateRetrievalRawRow;
  const entityId = r.entity_id;
  const entityType = r.entity_type;
  const canonicalName = r.canonical_name;
  const matchedText = r.matched_text;
  const matchSource = r.match_source;
  const profileAttrs = r.profile_attrs;
  const sim = r.sim;
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid entity_id (expected non-empty string).`,
      1
    );
  }
  if (typeof entityType !== 'string' || entityType.length === 0) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid entity_type (expected non-empty string).`,
      1
    );
  }
  if (typeof canonicalName !== 'string') {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid canonical_name (expected string).`,
      1
    );
  }
  if (typeof matchedText !== 'string' || matchedText.length === 0) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid matched_text (expected non-empty string).`,
      1
    );
  }
  if (typeof matchSource !== 'string' || matchSource.length === 0) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid match_source (expected non-empty string).`,
      1
    );
  }
  if (profileAttrs !== null && profileAttrs !== undefined && typeof profileAttrs !== 'string') {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid profile_attrs (expected string or null).`,
      1
    );
  }
  const simNum = coerceSimilarity(sim);
  if (simNum === undefined || !Number.isFinite(simNum)) {
    throw new CommandError(
      `Candidate retrieval row at index ${index} has invalid sim (expected finite number).`,
      1
    );
  }
  return {
    entity_id: entityId,
    entity_type: entityType,
    canonical_name: canonicalName,
    matched_text: matchedText,
    match_source: matchSource,
    profile_attrs: profileAttrs ?? null,
    sim: simNum,
  };
}

/**
 * Compare two top-K result sets for cross-warehouse parity. Returns true
 * when the sets are equivalent under the tolerance spec.
 */
export function topKEquivalent(
  a: readonly Candidate[],
  b: readonly Candidate[],
  tolerance = 1e-3
): boolean {
  if (a.length !== b.length) return false;
  const idsA = new Set(a.map((c) => candidateKey(c)));
  const idsB = new Set(b.map((c) => candidateKey(c)));
  // Duplicate entity_id rows would otherwise be silently collapsed by the
  // Set/Map normalization below, hiding a real candidate-set bug. Fail closed
  // when either input has duplicates.
  if (idsA.size !== a.length || idsB.size !== b.length) return false;
  if (idsA.size !== idsB.size) return false;
  for (const id of idsA) if (!idsB.has(id)) return false;
  // Per-entity similarity within tolerance. Use -Infinity (not NaN) for
  // missing-side fallback so the abs(diff) check fails closed instead of
  // silently passing.
  const byIdA = new Map(a.map((c) => [candidateKey(c), c.sim] as const));
  const byIdB = new Map(b.map((c) => [candidateKey(c), c.sim] as const));
  for (const id of idsA) {
    const sa = byIdA.get(id) ?? Number.NEGATIVE_INFINITY;
    const sb = byIdB.get(id) ?? Number.NEGATIVE_INFINITY;
    if (Math.abs(sa - sb) > tolerance) return false;
  }
  return true;
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.entity_type}\u0000${candidate.entity_id}`;
}
