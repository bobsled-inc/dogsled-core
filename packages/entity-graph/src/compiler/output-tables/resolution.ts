import type { OutputTableDef } from './index.js';

/**
 * Output table definitions for the identity mastering pipeline.
 *
 * These suffixes are the coordination API between pipeline commands
 * and any UI (CLI, Explorer, host application, third-party tools).
 */

export const RESOLUTION_OUTPUT_TABLES = (
  [
    {
      suffix: '__standardized',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'record_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: '_source_system', type: 'STRING' },
        { name: '_source_entity_id', type: 'STRING' },
        { name: '_standardized_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__resolve_state',
      ddlStrategy: 'create_if_not_exists',
      visibility: 'internal',
      columns: [
        { name: 'source_ref', type: 'STRING' },
        { name: 'watermark_kind', type: 'STRING' },
        { name: 'watermark_value', type: 'STRING', nullable: true },
        { name: 'spec_fingerprint', type: 'STRING' },
        { name: 'run_id', type: 'STRING' },
        { name: 'updated_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__match_inbox',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'idempotency_key', type: 'STRING' },
        { name: 'record_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'source_entity_id', type: 'STRING' },
        { name: 'record_json', type: 'STRING' },
        { name: 'standardized_json', type: 'STRING' },
        { name: 'status', type: 'STRING' },
        { name: 'received_at', type: 'TIMESTAMP' },
        { name: 'drained_run_id', type: 'STRING', nullable: true },
        { name: 'drained_at', type: 'TIMESTAMP', nullable: true },
        { name: 'content_hash', type: 'STRING' },
      ],
    },
    {
      suffix: '__candidate_pairs',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'record_a_id', type: 'STRING' },
        { name: 'record_b_id', type: 'STRING' },
        { name: 'source_a', type: 'STRING' },
        { name: 'source_b', type: 'STRING' },
        { name: 'blocking_rules', type: 'STRING' },
      ],
    },
    {
      suffix: '__pair_scores',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'pair_id', type: 'STRING' },
        { name: 'record_a_id', type: 'STRING' },
        { name: 'record_b_id', type: 'STRING' },
        { name: 'source_a', type: 'STRING' },
        { name: 'source_b', type: 'STRING' },
        { name: 'composite_score', type: 'FLOAT' },
        { name: 'match_type', type: 'STRING' },
        { name: 'rule_name', type: 'STRING', nullable: true },
        { name: 'blocking_rules', type: 'STRING' },
        { name: 'field_scores', type: 'STRING' },
        { name: 'scored_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__review_queue',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'pair_id', type: 'STRING' },
        { name: 'record_a_id', type: 'STRING' },
        { name: 'record_b_id', type: 'STRING' },
        { name: 'source_a', type: 'STRING' },
        { name: 'source_b', type: 'STRING' },
        { name: 'composite_score', type: 'FLOAT' },
        { name: 'threshold_band', type: 'STRING' },
        { name: 'blocking_rules', type: 'STRING' },
        { name: 'field_diffs', type: 'STRING' },
        { name: 'recommended_action', type: 'STRING' },
        { name: 'semantic_score', type: 'FLOAT', nullable: true },
        { name: 'semantic_decision', type: 'STRING', nullable: true },
        { name: 'rule_name', type: 'STRING', nullable: true },
      ],
    },
    {
      suffix: '__review_decisions',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'pair_id', type: 'STRING' },
        { name: 'decision', type: 'STRING' },
        { name: 'reviewer', type: 'STRING', nullable: true },
        { name: 'reason', type: 'STRING', nullable: true },
        { name: 'decision_batch_id', type: 'STRING' },
        { name: 'content_hash', type: 'STRING', nullable: true },
        { name: 'decision_source', type: 'STRING' },
        { name: 'decided_at', type: 'TIMESTAMP' },
        { name: 'applied_at', type: 'TIMESTAMP' },
        { name: 'confidence', type: 'FLOAT', nullable: true },
        { name: 'proposed_decision', type: 'STRING', nullable: true },
        { name: 'proposed_confidence', type: 'FLOAT', nullable: true },
        { name: 'status', type: 'STRING', nullable: true },
        { name: 'human_feedback_outcome', type: 'STRING', nullable: true },
        { name: 'human_feedback_reason', type: 'STRING', nullable: true },
        { name: 'feedback_timestamp', type: 'TIMESTAMP', nullable: true },
      ],
    },
    {
      suffix: '__components',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'component_id', type: 'STRING' },
        { name: 'record_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'source_entity_id', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'confidence_score', type: 'FLOAT' },
        { name: 'clustered_at', type: 'TIMESTAMP' },
      ],
    },
    // Append-only event log — never rebuilt, only inserted into.
    {
      suffix: '__entity_id_events',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'event_id', type: 'STRING' },
        { name: 'event_type', type: 'STRING' },
        { name: 'entity_id', type: 'STRING' },
        { name: 'previous_entity_id', type: 'STRING', nullable: true },
        { name: 'record_id', type: 'STRING', nullable: true },
        { name: 'component_id', type: 'STRING', nullable: true },
        { name: 'source_ref', type: 'STRING', nullable: true },
        { name: 'source_pk_json', type: 'STRING', nullable: true },
        { name: 'source_system', type: 'STRING', nullable: true },
        { name: 'source_entity_id', type: 'STRING', nullable: true },
        { name: 'reason', type: 'STRING' },
        { name: 'created_at', type: 'TIMESTAMP' },
      ],
    },
    // Bootstrapped as empty shell, then rebuilt with CREATE OR REPLACE each run.
    {
      suffix: '__entity_id_record_map',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'record_id', type: 'STRING' },
        { name: 'entity_id', type: 'STRING' },
        { name: 'previous_entity_id', type: 'STRING', nullable: true },
        { name: 'component_id', type: 'STRING', nullable: true },
        { name: 'source_ref', type: 'STRING', nullable: true },
        { name: 'source_pk_json', type: 'STRING', nullable: true },
        { name: 'source_system', type: 'STRING', nullable: true },
        { name: 'source_entity_id', type: 'STRING', nullable: true },
        { name: 'assigned_at', type: 'TIMESTAMP' },
        { name: 'assignment_reason', type: 'STRING' },
      ],
    },
    // Bootstrapped as empty shell, then rebuilt with CREATE OR REPLACE each run.
    {
      suffix: '__entity_id_current',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'record_id', type: 'STRING' },
        { name: 'component_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'source_entity_id', type: 'STRING' },
        { name: 'confidence_score', type: 'FLOAT' },
        { name: 'clustered_at', type: 'TIMESTAMP' },
        { name: 'assigned_at', type: 'TIMESTAMP' },
        { name: 'assignment_reason', type: 'STRING' },
      ],
    },
    // Bootstrapped as empty shell, then rebuilt with CREATE OR REPLACE each run.
    {
      suffix: '__entity_id_aliases',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'alias_entity_id', type: 'STRING' },
        { name: 'alias_reason', type: 'STRING' },
        { name: 'created_at', type: 'TIMESTAMP' },
        { name: 'superseded_at', type: 'TIMESTAMP', nullable: true },
      ],
    },
    {
      suffix: '__clusters',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'component_id', type: 'STRING' },
        { name: 'record_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'source_entity_id', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'confidence_score', type: 'FLOAT' },
        { name: 'clustered_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__crosswalks',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'record_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'source_entity_id', type: 'STRING' },
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'component_id', type: 'STRING' },
        { name: 'confidence_score', type: 'FLOAT' },
        { name: 'matched_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__entity_profile',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'entity_type', type: 'STRING' },
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'canonical_name', type: 'STRING', nullable: true },
        { name: 'display_name', type: 'STRING', nullable: true },
        { name: 'profile_attrs', type: 'STRING' },
        { name: 'confidence', type: 'FLOAT' },
        { name: 'freshness_age_seconds', type: 'INTEGER' },
        { name: 'source_diversity', type: 'INTEGER' },
        { name: 'profile_coverage', type: 'FLOAT' },
        { name: 'last_seen_at', type: 'TIMESTAMP' },
        { name: 'lineage_run_id', type: 'STRING' },
        { name: 'version', type: 'INTEGER' },
      ],
    },
    {
      suffix: '__entity_quality',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'entity_type', type: 'STRING' },
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'identity_confidence', type: 'FLOAT' },
        { name: 'freshness_score', type: 'FLOAT' },
        { name: 'source_diversity_score', type: 'FLOAT' },
        { name: 'profile_attribute_coverage', type: 'FLOAT' },
        { name: 'entity_trust_score', type: 'FLOAT' },
        { name: 'trust_tier', type: 'STRING' },
        { name: 'scored_at', type: 'TIMESTAMP' },
      ],
    },
    // Internal EAV representation (one row per entity × attribute). Populated by
    // default from profile.attributes on every resolve+cluster run; the wide
    // `__golden` below is a query-ready pivot of it.
    {
      suffix: '__golden_record',
      ddlStrategy: 'create_if_not_exists',
      visibility: 'internal',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'attribute_name', type: 'STRING' },
        { name: 'attribute_value', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'updated_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__forgotten_records',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'tombstone_id', type: 'STRING' },
        { name: 'source_ref', type: 'STRING' },
        { name: 'source_pk_json', type: 'STRING' },
        { name: 'requested_at', type: 'TIMESTAMP' },
        { name: 'reason', type: 'STRING', nullable: true },
        { name: 'content_hash', type: 'STRING' },
      ],
    },
    // Wide, human-consumable golden record: one row per entity_id. The attribute
    // columns and per-source `<tail>_id` / `has_<tail>` columns are dynamic
    // (derived from profile.attributes + inputs) and produced by the SELECT;
    // only the fixed columns are declared here as the output contract.
    {
      suffix: '__golden',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_size', type: 'INTEGER' },
        { name: 'trust_score', type: 'FLOAT' },
        { name: 'trust_band', type: 'STRING' },
      ],
    },
    {
      suffix: '__golden_masked',
      ddlStrategy: 'create_or_replace',
      kind: 'view',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_size', type: 'INTEGER' },
        { name: 'trust_score', type: 'FLOAT' },
        { name: 'trust_band', type: 'STRING' },
      ],
    },
    {
      suffix: '__not_match_edges',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'pair_id', type: 'STRING' },
        { name: 'record_a_id', type: 'STRING' },
        { name: 'record_b_id', type: 'STRING' },
        { name: 'reviewer', type: 'STRING' },
        { name: 'reason', type: 'STRING', nullable: true },
        { name: 'decision_batch_id', type: 'STRING' },
        { name: 'decision_source', type: 'STRING' },
        { name: 'decided_at', type: 'TIMESTAMP' },
        { name: 'applied_at', type: 'TIMESTAMP' },
        { name: 'confidence', type: 'FLOAT', nullable: true },
      ],
    },
    {
      suffix: '__survivorship_audit',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'entity_id', type: 'STRING' },
        { name: 'cluster_id', type: 'STRING' },
        { name: 'attribute_name', type: 'STRING' },
        { name: 'chosen_value', type: 'STRING' },
        { name: 'source_system', type: 'STRING' },
        { name: 'strategy', type: 'STRING' },
        { name: 'decided_at', type: 'TIMESTAMP' },
      ],
    },
    {
      suffix: '__split_events',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'original_cluster_id', type: 'STRING' },
        { name: 'new_cluster_id', type: 'STRING' },
        { name: 'record_id', type: 'STRING' },
        { name: 'reason', type: 'STRING', nullable: true },
        { name: 'split_at', type: 'TIMESTAMP' },
      ],
    },
  ] as const
).map((table) => ({
  ...table,
  stage: 'identity' as const,
})) satisfies readonly OutputTableDef[];

export const OUTPUT_TABLE_SUFFIXES = RESOLUTION_OUTPUT_TABLES.map((table) => table.suffix);

export type OutputTableSuffix = (typeof RESOLUTION_OUTPUT_TABLES)[number]['suffix'];
