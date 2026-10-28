/**
 * Cross-entity relationship tables.
 *
 * `__entity_relationship` is the compacted public surface the SDK and SQL
 * consumers traverse. `__entity_relationship_edge` remains as an internal
 * staging surface for profile-join compilation. `__entity_relationship_evidence`
 * is append-only provenance for joins, mention links, LLM extraction, review,
 * and truthset rows.
 *
 * Quality propagates: edge.confidence = min(left.confidence, right.confidence)
 * * link_match_quality. `freshness_age_seconds` = max of endpoints'.
 * `evidence_count` and `evidence_diversity` populated by the link compiler.
 */

import type { OutputTableDef } from './index.js';

export const RELATIONSHIP_EDGE_OUTPUT_TABLES = (
  [
    {
      suffix: '__entity_relationship_edge',
      stage: 'relationship',
      ddlStrategy: 'create_or_replace',
      visibility: 'internal',
      columns: [
        { name: 'relationship_id', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING' },
        { name: 'relation_type', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'valid_from', type: 'TIMESTAMP', nullable: true },
        { name: 'valid_to', type: 'TIMESTAMP', nullable: true },
        { name: 'evidence_count', type: 'INTEGER' },
        { name: 'evidence_diversity', type: 'INTEGER' },
        { name: 'freshness_age_seconds', type: 'INTEGER' },
        { name: 'lineage_run_id', type: 'STRING' },
      ],
    },
    {
      suffix: '__entity_relationship',
      stage: 'relationship',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'relationship_id', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING' },
        { name: 'relation_type', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'rank', type: 'STRING' },
        { name: 'valid_from', type: 'TIMESTAMP', nullable: true },
        { name: 'valid_to', type: 'TIMESTAMP', nullable: true },
        { name: 'evidence_count', type: 'INTEGER' },
        { name: 'evidence_diversity', type: 'INTEGER' },
        { name: 'freshness_age_seconds', type: 'INTEGER' },
        { name: 'lineage_run_id', type: 'STRING' },
      ],
    },
    {
      suffix: '__entity_relationship_evidence',
      stage: 'relationship',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'evidence_id', type: 'STRING' },
        { name: 'relationship_id', type: 'STRING' },
        { name: 'relation_type', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING' },
        { name: 'evidence_kind', type: 'STRING' },
        { name: 'evidence_ref', type: 'STRING', nullable: true },
        { name: 'source_document_id', type: 'STRING', nullable: true },
        { name: 'source_document_version_id', type: 'STRING', nullable: true },
        { name: 'source_chunk_id', type: 'STRING', nullable: true },
        { name: 'span_start', type: 'INTEGER', nullable: true },
        { name: 'span_end', type: 'INTEGER', nullable: true },
        { name: 'evidence_excerpt', type: 'STRING', nullable: true },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'extraction_role', type: 'STRING', nullable: true },
        { name: 'prompt_version', type: 'STRING', nullable: true },
        { name: 'ontology_version', type: 'STRING', nullable: true },
        { name: 'model_metadata', type: 'STRING', nullable: true },
        { name: 'injection_markers', type: 'STRING', nullable: true },
        { name: 'review_flag', type: 'STRING', nullable: true },
        { name: 'observed_at', type: 'TIMESTAMP', nullable: true },
        { name: 'recorded_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__entity_relationship_decisions',
      stage: 'relationship',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'decision_id', type: 'STRING' },
        { name: 'evidence_id', type: 'STRING', nullable: true },
        { name: 'relationship_id', type: 'STRING' },
        { name: 'decision', type: 'STRING' },
        { name: 'decided_by', type: 'STRING' },
        { name: 'rationale', type: 'STRING', nullable: true },
        { name: 'decided_at', type: 'TIMESTAMP' },
      ],
    },
  ] as const satisfies readonly OutputTableDef[]
).slice();

export type RelationshipCardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

export interface EdgeQualityInputs {
  left_confidence: number;
  right_confidence: number;
  link_match_quality: number;
  left_freshness_age_seconds: number;
  right_freshness_age_seconds: number;
}

/**
 * Pure function for the documented edge-quality propagation rule. Used by
 * the SQL codegen and unit tests both to guard against drift.
 */
export function computeEdgeQuality(input: EdgeQualityInputs): {
  confidence: number;
  freshness_age_seconds: number;
} {
  return {
    confidence: Math.min(input.left_confidence, input.right_confidence) * input.link_match_quality,
    freshness_age_seconds: Math.max(
      input.left_freshness_age_seconds,
      input.right_freshness_age_seconds
    ),
  };
}
