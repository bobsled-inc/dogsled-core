/**
 * Cross-entity link compiler.
 *
 * Sources edges from three places:
 *  1. `__document_mentions` — Document → mentions → entity. The most
 *     interesting cross-source edge for the acceptance demo.
 *  2. `__crosswalks` — Person → employed_at → Company etc., via shared
 *     identifier under existing identity-resolution pipeline.
 *  3. Explicit `entity_relationship` specs — declarative edges.
 *
 * Pure SQL builders only here; execution flows through the existing
 * runtime/execution.ts plan path.
 */

import { quoteLiteral, type SupportedDialect } from '@bobsled-inc/model-spec';

import { assertSafeIdentifier } from '../../runtime/candidate-retrieval/sql-utils.js';
import { nullOfType } from '../identity/sql.js';
import type { RelationshipCardinality } from '../output-tables/relationship-edge.js';

const ALLOWED_CARDINALITIES: ReadonlySet<RelationshipCardinality> = new Set([
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
]);

function assertCardinality(value: RelationshipCardinality): RelationshipCardinality {
  if (!ALLOWED_CARDINALITIES.has(value)) {
    throw new Error(`Invalid relationship cardinality '${String(value)}'`);
  }
  return value;
}

export interface MentionDerivedEdgeOptions {
  /** Fully qualified `__document_mentions` table name. */
  mentionsTable: string;
  /** The relationship name written into `relationship_id` derivation. */
  relationshipName: string;
  cardinality: RelationshipCardinality;
  /** Warehouse dialect — selects BigQuery-correct (\') vs ANSI ('') literal escaping. */
  dialect: SupportedDialect;
  /**
   * Lineage run identifier emitted into `lineage_run_id`. Required so
   * runs are distinguishable in `__entity_relationship_edge`.
   */
  lineageRunId: string;
  /**
   * Optional fully qualified `__entity_profile` table for the left endpoint
   * (typically the `document` profile). When supplied alongside
   * `rightProfileTable`, the builder emits a CTE that joins both endpoint
   * profiles and uses real endpoint confidences in the
   * `min(left, right) * link_match_quality` rule. When omitted, falls back
   * to `MIN(resolution_confidence)` so callers without compiled profiles
   * still get a valid SELECT.
   */
  leftProfileTable?: string;
  /** Optional fully qualified `__entity_profile` for the right endpoint. */
  rightProfileTable?: string;
}

/**
 * Build the SELECT portion of a Document → mentioned-entity edge upsert.
 * Caller wraps in CREATE OR REPLACE / MERGE INTO per dialect.
 *
 * `relationship_id` uses a length-prefixed encoding to avoid the `::`
 * separator collision: if `document_id` or `resolved_entity_id` themselves
 * contain `::`, naive CONCAT produces ambiguous IDs. Length-prefixing makes the encoding injective without
 * requiring a dialect-specific hash function.
 *
 * When both `leftProfileTable` and `rightProfileTable` are provided the
 * SELECT joins both endpoint `__entity_profile` rows and computes
 * `min(left.confidence, right.confidence) * MIN(resolution_confidence)`,
 * matching the documented edge-confidence rule end-to-end. Callers that
 * haven't yet compiled profile tables (e.g. early-stage projects) can
 * omit those options and get the legacy `MIN(resolution_confidence)`
 * fallback.
 */
export function buildMentionDerivedEdgeSelect(options: MentionDerivedEdgeOptions): string {
  const mentionsTable = assertSafeIdentifier(options.mentionsTable, 'mentionsTable');
  const relationshipName = quoteLiteral(options.relationshipName, options.dialect);
  // Validate cardinality even though the value isn't interpolated into the
  // SELECT — relation_type now holds the semantic relationship name.
  // assertCardinality rejects malformed input that would otherwise sneak
  // past schema validation.
  assertCardinality(options.cardinality);
  const lineageRunId = quoteLiteral(options.lineageRunId, options.dialect);
  const nullTimestampValue = nullOfType('TIMESTAMP', options.dialect);
  const leftProfileProvided = options.leftProfileTable != null;
  const rightProfileProvided = options.rightProfileTable != null;
  if (leftProfileProvided !== rightProfileProvided) {
    const missing = leftProfileProvided ? 'rightProfileTable' : 'leftProfileTable';
    throw new Error(
      `buildMentionDerivedEdgeSelect requires ${missing} when profile confidence joins are enabled.`
    );
  }
  const hasProfiles = leftProfileProvided && rightProfileProvided;
  if (hasProfiles) {
    const leftProfile = assertSafeIdentifier(options.leftProfileTable!, 'leftProfileTable');
    const rightProfile = assertSafeIdentifier(options.rightProfileTable!, 'rightProfileTable');
    return `WITH agg AS (
  SELECT
    document_id,
    entity_type,
    resolved_entity_id,
    MIN(resolution_confidence) AS link_match_quality,
    COUNT(*) AS evidence_count,
    COUNT(DISTINCT chunk_id) AS evidence_diversity,
    MAX(extracted_at) AS latest_extracted_at
  FROM ${mentionsTable}
  WHERE resolved_entity_id IS NOT NULL
    AND resolution_method IN ('exact_match', 'llm_disambiguation')
    AND superseded_at IS NULL
  GROUP BY document_id, entity_type, resolved_entity_id
)
SELECT
  CONCAT(
    CAST(LENGTH(agg.document_id) AS VARCHAR), ':', agg.document_id, '|',
    CAST(LENGTH(agg.resolved_entity_id) AS VARCHAR), ':', agg.resolved_entity_id, '|',
    CAST(LENGTH(${relationshipName}) AS VARCHAR), ':', ${relationshipName}
  ) AS relationship_id,
  agg.document_id AS left_entity_id,
  agg.resolved_entity_id AS right_entity_id,
  -- relation_type holds the semantic relationship name so distinct
  -- edges with the same multiplicity (e.g., two many_to_many edges)
  -- remain distinguishable. cardinality stays as a validated option that
  -- callers can persist into a separate column if they need multiplicity
  -- in their schema.
  ${relationshipName} AS relation_type,
  -- Documented edge-confidence rule: min(left, right) * link_match_quality.
  -- Missing endpoint profile defaults to 1.0 (full confidence) so the LEAST
  -- reduces to the present endpoint, and the multiply by link_match_quality
  -- yields exactly link_match_quality when both endpoints are absent.
  -- (Previously COALESCE'd to link_match_quality which produced
  -- link_match_quality² for missing-both.)
  LEAST(
    COALESCE(lp.confidence, 1.0),
    COALESCE(rp.confidence, 1.0)
  ) * agg.link_match_quality AS confidence,
  ${nullTimestampValue} AS valid_from,
  ${nullTimestampValue} AS valid_to,
  agg.evidence_count,
  agg.evidence_diversity,
  CAST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - agg.latest_extracted_at)) AS INTEGER) AS freshness_age_seconds,
  ${lineageRunId} AS lineage_run_id
FROM agg
LEFT JOIN ${leftProfile} lp ON lp.entity_id = agg.document_id
LEFT JOIN ${rightProfile} rp
  ON rp.entity_id = agg.resolved_entity_id
 AND rp.entity_type = agg.entity_type`;
  }
  return `SELECT
  -- Length-prefixed relationship_id is collision-free even when
  -- document_id / resolved_entity_id contain '|' or ':'.
  CONCAT(
    CAST(LENGTH(document_id) AS VARCHAR), ':', document_id, '|',
    CAST(LENGTH(resolved_entity_id) AS VARCHAR), ':', resolved_entity_id, '|',
    CAST(LENGTH(${relationshipName}) AS VARCHAR), ':', ${relationshipName}
  ) AS relationship_id,
  document_id AS left_entity_id,
  resolved_entity_id AS right_entity_id,
  ${relationshipName} AS relation_type,
  MIN(resolution_confidence) AS confidence,
  ${nullTimestampValue} AS valid_from,
  ${nullTimestampValue} AS valid_to,
  COUNT(*) AS evidence_count,
  COUNT(DISTINCT chunk_id) AS evidence_diversity,
  CAST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(extracted_at))) AS INTEGER) AS freshness_age_seconds,
  ${lineageRunId} AS lineage_run_id
FROM ${mentionsTable}
WHERE resolved_entity_id IS NOT NULL
  AND resolution_method IN ('exact_match', 'llm_disambiguation')
  AND superseded_at IS NULL
GROUP BY document_id, resolved_entity_id`;
}

/**
 * Subset of {@link MentionDerivedEdgeOptions} used by the evidence select
 * builder. Promoted to a named type so the public API doesn't duplicate
 * fields between the edge and evidence builders.
 */
export type MentionDerivedEvidenceOptions = Pick<
  MentionDerivedEdgeOptions,
  'mentionsTable' | 'relationshipName' | 'dialect'
>;

export function buildMentionDerivedEvidenceSelect(options: MentionDerivedEvidenceOptions): string {
  const mentionsTable = assertSafeIdentifier(options.mentionsTable, 'mentionsTable');
  const relationshipName = quoteLiteral(options.relationshipName, options.dialect);
  const nullVarchar = nullOfType('VARCHAR', options.dialect);
  const nullTimestampValue = nullOfType('TIMESTAMP', options.dialect);
  return `SELECT
  CONCAT(
    CAST(LENGTH(mention_id) AS VARCHAR), ':', mention_id, '|',
    ${relationshipName}, '|evidence'
  ) AS evidence_id,
  CONCAT(
    CAST(LENGTH(document_id) AS VARCHAR), ':', document_id, '|',
    CAST(LENGTH(resolved_entity_id) AS VARCHAR), ':', resolved_entity_id, '|',
    CAST(LENGTH(${relationshipName}) AS VARCHAR), ':', ${relationshipName}
  ) AS relationship_id,
  ${relationshipName} AS relation_type,
  document_id AS left_entity_id,
  resolved_entity_id AS right_entity_id,
  'mention_link' AS evidence_kind,
  mention_id AS evidence_ref,
  document_id AS source_document_id,
  document_version_id AS source_document_version_id,
  chunk_id AS source_chunk_id,
  span_start,
  span_end,
  ${nullVarchar} AS evidence_excerpt,
  COALESCE(resolution_confidence, confidence, 0) AS confidence,
  extraction_role,
  ${nullVarchar} AS prompt_version,
  ${nullVarchar} AS ontology_version,
  ${nullVarchar} AS model_metadata,
  ${nullVarchar} AS injection_markers,
  CASE
    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.92 THEN 'auto_merge'
    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.75 THEN 'agent_applied'
    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.55 THEN 'agent_review'
    ELSE 'unresolved'
  END AS review_flag,
  ${nullTimestampValue} AS observed_at,
  extracted_at AS recorded_at
FROM ${mentionsTable}
WHERE resolved_entity_id IS NOT NULL
  AND resolution_method IN ('exact_match', 'llm_disambiguation')
  AND superseded_at IS NULL`;
}
