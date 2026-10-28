import type { OutputTableDef } from './index.js';

export const RELATIONSHIP_OUTPUT_TABLES = (
  [
    {
      suffix: '__relationship_candidates',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'edge_id', type: 'STRING' },
        { name: 'relation_name', type: 'STRING' },
        { name: 'left_entity_type', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_type', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING', nullable: true },
        { name: 'join_values_json', type: 'STRING' },
        { name: 'candidate_status', type: 'STRING' },
        { name: 'candidate_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__relationship_evidence',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'edge_id', type: 'STRING' },
        { name: 'relation_name', type: 'STRING' },
        { name: 'evidence_type', type: 'STRING' },
        { name: 'evidence_json', type: 'STRING' },
        { name: 'score', type: 'FLOAT' },
        { name: 'evaluated_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__relationship_edges',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'edge_id', type: 'STRING' },
        { name: 'relation_name', type: 'STRING' },
        { name: 'left_entity_type', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_type', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'status', type: 'STRING' },
        { name: 'valid_from', type: 'TIMESTAMP', nullable: true },
        { name: 'valid_to', type: 'TIMESTAMP', nullable: true },
        { name: 'decided_at', type: 'TIMESTAMP', nullable: true },
      ],
    },
    {
      suffix: '__relationship_review_queue',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'edge_id', type: 'STRING' },
        { name: 'relation_name', type: 'STRING' },
        { name: 'left_entity_id', type: 'STRING' },
        { name: 'right_entity_id', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'threshold_band', type: 'STRING' },
        { name: 'evidence_json', type: 'STRING' },
        { name: 'recommended_action', type: 'STRING' },
        { name: 'queued_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__relationship_decisions',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'edge_id', type: 'STRING' },
        { name: 'decision', type: 'STRING' },
        { name: 'reviewer', type: 'STRING', nullable: true },
        { name: 'reason', type: 'STRING', nullable: true },
        { name: 'decision_batch_id', type: 'STRING' },
        { name: 'content_hash', type: 'STRING', nullable: true },
        { name: 'decision_source', type: 'STRING' },
        { name: 'decided_at', type: 'TIMESTAMP' },
        { name: 'applied_at', type: 'TIMESTAMP' },
        { name: 'confidence', type: 'FLOAT', nullable: true },
      ],
    },
  ] as const
).map((table) => ({
  ...table,
  stage: 'relationship' as const,
})) satisfies readonly OutputTableDef[];
