import { z } from 'zod';

export const AUDIT_CATEGORIES = ['mutation', 'decision', 'dispatch'] as const;
export const AUDIT_ACTOR_TYPES = ['human', 'agent', 'system'] as const;
export const AUDIT_PAYLOAD_KINDS = [
  'merge',
  'not_match',
  'unmerge',
  'split',
  'survivorship_choose',
  'semantic_promote_merge',
  'semantic_promote_reject',
  'semantic_triage_skipped',
  'relate_confirm',
  'relate_reject',
  'review_apply',
  'erasure',
  'incremental_run',
  'match_assign',
  'policy_block',
  'agent_escalate',
  'activation_dispatch',
  'activation_receipt',
  'expect_pass',
  'expect_fail',
  'clean_apply',
  'lineage_refresh',
] as const;

export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

const ReviewApplyPayloadSchema = z
  .object({
    kind: z.literal('review_apply'),
    decision_batch_id: z.string(),
    content_hash: z.string().optional(),
    skipped: z.boolean(),
    decision_count: z.number().int().nonnegative().optional(),
    merge_count: z.number().int().nonnegative().optional(),
    not_match_count: z.number().int().nonnegative().optional(),
    deferred_count: z.number().int().nonnegative().optional(),
    escalated_count: z.number().int().nonnegative().optional(),
    // Decision-trace ("why") fields. Persisted ONLY in the warehouse audit_log
    // payload — never in any metadata DB. All optional for back-compat with
    // rows written before the context-graph trace landed.
    policy_version: z.string().optional(),
    config_snapshot: z.record(z.string(), z.unknown()).optional(),
    langsmith_trace_id: z.string().optional(),
    precedent_refs: z.array(z.string()).optional(),
  })
  .strict();

const ErasurePayloadSchema = z
  .object({
    kind: z.literal('erasure'),
    tombstone_id: z.string(),
    tables: z.array(z.string()),
    row_counts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

const IncrementalRunPayloadSchema = z
  .object({
    kind: z.literal('incremental_run'),
    entity: z.string(),
    mode: z.enum(['full', 'incremental']),
    mode_reason: z.string(),
    source_count: z.number().int().nonnegative(),
    spec_fingerprint: z.string(),
  })
  .strict();

const MatchAssignPayloadSchema = z
  .object({
    kind: z.literal('match_assign'),
    entity: z.string(),
    mode: z.enum(['assign', 'stage']),
    idempotency_key: z.string(),
    record_id: z.string(),
    source_ref: z.string(),
    outcome: z.enum(['assigned', 'staged', 'pending_review', 'already_assigned']),
    matched_entity_id: z.string().optional(),
  })
  .strict()
  .refine(
    (payload) =>
      !(payload.outcome === 'assigned' || payload.outcome === 'already_assigned') ||
      payload.matched_entity_id !== undefined,
    { message: 'matched_entity_id is required when outcome is assigned or already_assigned.' }
  );

const SplitPayloadSchema = z
  .object({
    kind: z.literal('split'),
    original_cluster_id: z.string(),
    new_cluster_id: z.string().optional(),
    kept_record_ids: z.array(z.string()).optional(),
    moved_record_ids: z.array(z.string()).optional(),
  })
  .strict();

const UnmergePayloadSchema = z
  .object({
    kind: z.literal('unmerge'),
    cluster_id: z.string(),
    kept_record_ids: z.array(z.string()),
    affected_pair_count: z.number().int().nonnegative().optional(),
  })
  .strict();

const SurvivorshipChoosePayloadSchema = z
  .object({
    kind: z.literal('survivorship_choose'),
    attribute_name: z.string(),
    chosen_value: z.unknown().optional(),
    source_system: z.string().optional(),
    strategy: z.string().optional(),
  })
  .strict();

const SemanticPromotionPayloadSchema = z
  .object({
    kind: z.enum(['semantic_promote_merge', 'semantic_promote_reject']),
    semantic_score: z.number().min(-1).max(1),
    threshold: z.number().min(0).max(1),
    provider: z.string(),
  })
  .strict();

const SemanticTriageSkippedPayloadSchema = z
  .object({
    kind: z.literal('semantic_triage_skipped'),
    estimated_embedding_cost_usd: z.number().nonnegative().optional(),
    max_embedding_cost_usd: z.number().nonnegative().optional(),
    candidate_count: z.number().int().nonnegative().optional(),
    reason: z.string(),
  })
  .strict();

const RelationshipPayloadSchema = z
  .object({
    kind: z.enum(['relate_confirm', 'relate_reject']),
    relationship_name: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const ActivationDispatchPayloadSchema = z
  .object({
    kind: z.literal('activation_dispatch'),
    sync_name: z.string(),
    projection_version: z.string().optional(),
    action: z.string(),
    status: z.string().optional(),
  })
  .strict();

const ActivationReceiptPayloadSchema = z
  .object({
    kind: z.literal('activation_receipt'),
    sync_name: z.string(),
    projection_version: z.string().optional(),
    action: z.string(),
    status: z.string().optional(),
    duration_ms: z.number().nonnegative(),
    error_code: z.string().optional(),
  })
  .strict();

const ExpectPayloadSchema = z
  .object({
    kind: z.enum(['expect_pass', 'expect_fail']),
    expectation: z.string(),
    model: z.string().optional(),
    row_count: z.number().int().nonnegative().optional(),
  })
  .strict();

const CleanApplyPayloadSchema = z
  .object({
    kind: z.literal('clean_apply'),
    spec_ref: z.string(),
    steps: z.array(z.string()).optional(),
    row_count: z.number().int().nonnegative().optional(),
  })
  .strict();

const LineageRefreshPayloadSchema = z
  .object({
    kind: z.literal('lineage_refresh'),
    entity_type: z.string(),
    attribute_count: z.number().int().nonnegative(),
    complete_count: z.number().int().nonnegative(),
    incomplete_count: z.number().int().nonnegative(),
  })
  .strict();

const AgentEscalatePayloadSchema = z
  .object({
    kind: z.literal('agent_escalate'),
    reason: z.string().optional(),
    pair_id: z.string().optional(),
  })
  .strict();

const PolicyBlockPayloadSchema = z
  .object({
    kind: z.literal('policy_block'),
    policy: z.string(),
    reason: z.string().optional(),
  })
  .strict();

const PairDecisionPayloadSchema = z
  .object({
    kind: z.enum(['merge', 'not_match']),
    pair_id: z.string().optional(),
    record_a_id: z.string().optional(),
    record_b_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const AuditPayloadSchema = z.discriminatedUnion('kind', [
  PairDecisionPayloadSchema,
  UnmergePayloadSchema,
  SplitPayloadSchema,
  SurvivorshipChoosePayloadSchema,
  SemanticPromotionPayloadSchema,
  SemanticTriageSkippedPayloadSchema,
  RelationshipPayloadSchema,
  ReviewApplyPayloadSchema,
  ErasurePayloadSchema,
  IncrementalRunPayloadSchema,
  MatchAssignPayloadSchema,
  PolicyBlockPayloadSchema,
  AgentEscalatePayloadSchema,
  ActivationDispatchPayloadSchema,
  ActivationReceiptPayloadSchema,
  ExpectPayloadSchema,
  CleanApplyPayloadSchema,
  LineageRefreshPayloadSchema,
]);

export type AuditCategory = z.infer<typeof AuditCategorySchema>;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
export type AuditPayloadKind = (typeof AUDIT_PAYLOAD_KINDS)[number];
export type AuditPayload = z.infer<typeof AuditPayloadSchema>;
