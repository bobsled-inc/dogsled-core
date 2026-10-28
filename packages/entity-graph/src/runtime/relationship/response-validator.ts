import type { RelationshipCandidatePair } from './candidate-pairs.js';

export interface RelationshipExtractionItem {
  relation_type: string;
  left_entity_id: string;
  right_entity_id: string;
  span_start?: number;
  span_end?: number;
  evidence_excerpt?: string;
  confidence: number;
}

export interface RelationshipExtractionResponse {
  extractions: RelationshipExtractionItem[];
}

export interface ValidatedRelationshipExtraction extends RelationshipExtractionItem {
  pair_id: string;
}

export interface RejectedRelationshipExtraction {
  item: unknown;
  reason: string;
}

export interface RelationshipValidationResult {
  accepted: ValidatedRelationshipExtraction[];
  rejected: RejectedRelationshipExtraction[];
}

function isExtractionObject(value: unknown): value is RelationshipExtractionItem {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.relation_type === 'string' &&
    typeof row.left_entity_id === 'string' &&
    typeof row.right_entity_id === 'string' &&
    typeof row.confidence === 'number' &&
    (row.span_start === undefined || typeof row.span_start === 'number') &&
    (row.span_end === undefined || typeof row.span_end === 'number') &&
    (row.evidence_excerpt === undefined || typeof row.evidence_excerpt === 'string')
  );
}

function findPair(
  item: RelationshipExtractionItem,
  pairs: readonly RelationshipCandidatePair[]
): RelationshipCandidatePair | undefined {
  return pairs.find(
    (pair) =>
      pair.left_entity_id === item.left_entity_id &&
      pair.right_entity_id === item.right_entity_id &&
      pair.allowed_relation_types.includes(item.relation_type)
  );
}

export function validateRelationshipResponse(
  response: unknown,
  options: {
    chunk_text: string;
    pairs: readonly RelationshipCandidatePair[];
    require_span_evidence?: boolean;
  }
): RelationshipValidationResult {
  const accepted: ValidatedRelationshipExtraction[] = [];
  const rejected: RejectedRelationshipExtraction[] = [];

  const rows =
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { extractions?: unknown }).extractions)
      ? (response as { extractions: unknown[] }).extractions
      : null;

  if (!rows) {
    return { accepted, rejected: [{ item: response, reason: 'missing_extractions_array' }] };
  }

  for (const item of rows) {
    if (!isExtractionObject(item)) {
      rejected.push({ item, reason: 'schema_violation' });
      continue;
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      rejected.push({ item, reason: 'invalid_confidence' });
      continue;
    }
    if (item.left_entity_id === item.right_entity_id) {
      rejected.push({ item, reason: 'self_relationship' });
      continue;
    }

    const pair = findPair(item, options.pairs);
    if (!pair) {
      rejected.push({ item, reason: 'candidate_pair_mismatch' });
      continue;
    }

    if (options.require_span_evidence ?? true) {
      if (
        typeof item.span_start !== 'number' ||
        typeof item.span_end !== 'number' ||
        typeof item.evidence_excerpt !== 'string' ||
        !Number.isInteger(item.span_start) ||
        !Number.isInteger(item.span_end) ||
        item.span_start < 0 ||
        item.span_end <= item.span_start ||
        item.span_end > options.chunk_text.length
      ) {
        rejected.push({ item, reason: 'invalid_span' });
        continue;
      }
      if (options.chunk_text.slice(item.span_start, item.span_end) !== item.evidence_excerpt) {
        rejected.push({ item, reason: 'evidence_excerpt_mismatch' });
        continue;
      }
    }

    accepted.push({ ...item, pair_id: pair.pair_id });
  }

  return { accepted, rejected };
}
