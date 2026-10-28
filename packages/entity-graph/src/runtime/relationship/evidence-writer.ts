export type RelationshipReviewFlag =
  | 'auto_merge'
  | 'agent_applied'
  | 'agent_review'
  | 'eval_sample'
  | 'human_review'
  | 'unresolved';
export const RELATIONSHIP_AGENT_REVIEW_THRESHOLD = 0.75;

export interface RelationshipEvidenceRow {
  evidence_id: string;
  relationship_id: string;
  relation_type: string;
  left_entity_id: string;
  right_entity_id: string;
  evidence_kind:
    | 'profile_join'
    | 'mention_link'
    | 'llm_extraction'
    | 'review_decision'
    | 'truthset';
  evidence_ref: string | null;
  source_document_id: string | null;
  source_document_version_id: string | null;
  source_chunk_id: string | null;
  span_start: number | null;
  span_end: number | null;
  evidence_excerpt: string | null;
  confidence: number;
  extraction_role: string | null;
  prompt_version: string | null;
  ontology_version: string | null;
  model_metadata: string | null;
  injection_markers: string | null;
  review_flag: RelationshipReviewFlag | null;
  observed_at: string | null;
  recorded_at: string;
}

export interface RelationshipEvidenceStore {
  hasEvidenceBatch(evidenceIds: readonly string[]): Promise<Set<string>>;
  appendEvidence(row: RelationshipEvidenceRow): Promise<void>;
}

export function reviewFlagForConfidence(
  confidence: number,
  thresholds: { auto_confirm: number; review: number; auto_reject: number }
): RelationshipReviewFlag {
  if (thresholds.review > RELATIONSHIP_AGENT_REVIEW_THRESHOLD) {
    throw new Error(
      `thresholds.review must be <= ${RELATIONSHIP_AGENT_REVIEW_THRESHOLD} for agent review routing.`
    );
  }
  if (confidence >= thresholds.auto_confirm) return 'auto_merge';
  if (confidence >= RELATIONSHIP_AGENT_REVIEW_THRESHOLD) return 'agent_applied';
  if (confidence >= thresholds.review) return 'agent_review';
  if (confidence >= thresholds.auto_reject) return 'eval_sample';
  return 'unresolved';
}

export async function writeRelationshipEvidence(
  rows: readonly RelationshipEvidenceRow[],
  store: RelationshipEvidenceStore
): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  let inserted = 0;
  let skipped = 0;
  const existing = await store.hasEvidenceBatch([...new Set(rows.map((row) => row.evidence_id))]);
  const seen = new Set(existing);
  for (const row of rows) {
    if (seen.has(row.evidence_id)) {
      skipped += 1;
      continue;
    }
    await store.appendEvidence(row);
    seen.add(row.evidence_id);
    inserted += 1;
  }
  return { inserted, skipped };
}
