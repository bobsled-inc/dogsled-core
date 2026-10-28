export interface EntityGraphReviewPairSqlRow {
  pair_id: string;
  record_a_id: string | null;
  record_b_id: string | null;
  source_a: string | null;
  source_b: string | null;
  composite_score: number;
  threshold_band: string;
  blocking_rules: string | null;
  field_diffs: string | null;
  recommended_action: string | null;
  [key: string]: unknown;
}

export interface EntityGraphQueueDecisionMetadata {
  decision: string | null;
  decision_confidence: number | null;
  decision_reason: string | null;
  decision_reviewer: string | null;
  decided_at: string | null;
  decision_status: string | null;
  proposed_decision: string | null;
  proposed_confidence: number | null;
  decision_source: string | null;
  decision_batch_id: string | null;
  human_decision: string | null;
  human_decision_confidence: number | null;
  human_decision_reason: string | null;
  human_decision_reviewer: string | null;
  human_decided_at: string | null;
  human_decision_status: string | null;
}
