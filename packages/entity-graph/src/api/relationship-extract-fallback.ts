import { type RelationshipExtractionSpec } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type { ResolvedRelationshipOntology } from '../compiler/ontology/types.js';
import {
  buildCandidatePairs,
  type CandidatePairRules,
  type ResolvedChunkMention,
} from '../runtime/relationship/candidate-pairs.js';
import {
  reviewFlagForConfidence,
  type RelationshipEvidenceRow,
} from '../runtime/relationship/evidence-writer.js';
import {
  relationshipId,
  relationshipIdempotencyHash,
} from '../runtime/relationship/idempotency.js';
import type { ChunkRecord } from './extract-project-utils.js';

export interface StoredRelationshipMention extends ResolvedChunkMention {
  document_id: string;
  document_version_id: string;
  confidence: number;
  resolution_confidence: number;
}

function evidenceExcerpt(
  chunk: ChunkRecord | undefined,
  start: number | undefined,
  end: number | undefined
): { span_start: number | null; span_end: number | null; evidence_excerpt: string | null } {
  if (
    !chunk ||
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > chunk.chunk_text.length
  ) {
    return { span_start: null, span_end: null, evidence_excerpt: null };
  }
  return {
    span_start: start,
    span_end: end,
    evidence_excerpt: chunk.chunk_text.slice(start, end),
  };
}

function buildEvidenceRow(input: {
  relationType: string;
  leftEntityId: string;
  rightEntityId: string;
  confidence: number;
  evidenceRef: string | null;
  chunk: ChunkRecord | undefined;
  mention: StoredRelationshipMention;
  spanStart?: number;
  spanEnd?: number;
  spec: RelationshipExtractionSpec;
  ontology: ResolvedRelationshipOntology;
  recordedAt: string;
  modelId: string;
}): RelationshipEvidenceRow {
  const span = evidenceExcerpt(input.chunk, input.spanStart, input.spanEnd);
  const relation = input.ontology.relations.find(
    (item) => item.relation_type === input.relationType
  );
  if (!relation) {
    throw new CommandError(
      `Unknown relation_type '${input.relationType}' in fallback extraction.`,
      2
    );
  }
  return {
    evidence_id: relationshipIdempotencyHash({
      document_version_id: input.mention.document_version_id,
      chunk_id: input.mention.chunk_id,
      left_entity_id: input.leftEntityId,
      right_entity_id: input.rightEntityId,
      relation_type: input.relationType,
      ontology_version: input.ontology.ontologyVersion,
      prompt_version: input.spec.extraction.prompt_version,
      model_id: input.modelId,
    }),
    relationship_id: relationshipId({
      left_entity_id: input.leftEntityId,
      right_entity_id: input.rightEntityId,
      relation_type: input.relationType,
    }),
    relation_type: input.relationType,
    left_entity_id: input.leftEntityId,
    right_entity_id: input.rightEntityId,
    evidence_kind: 'mention_link',
    evidence_ref: input.evidenceRef,
    source_document_id: input.mention.document_id,
    source_document_version_id: input.mention.document_version_id,
    source_chunk_id: input.mention.chunk_id,
    span_start: span.span_start,
    span_end: span.span_end,
    evidence_excerpt: span.evidence_excerpt,
    confidence: input.confidence,
    extraction_role: input.spec.extraction.role,
    prompt_version: input.spec.extraction.prompt_version,
    ontology_version: input.ontology.ontologyVersion,
    model_metadata: JSON.stringify({ mode: 'fallback' }),
    injection_markers: null,
    review_flag: reviewFlagForConfidence(input.confidence, relation.review_thresholds),
    observed_at: null,
    recorded_at: input.recordedAt,
  };
}

export function fallbackEvidenceRows(
  spec: RelationshipExtractionSpec,
  ontology: ResolvedRelationshipOntology,
  chunksById: ReadonlyMap<string, ChunkRecord>,
  mentionsByChunk: ReadonlyMap<string, StoredRelationshipMention[]>,
  now: () => Date,
  candidatePairRules?: CandidatePairRules
): RelationshipEvidenceRow[] {
  const recordedAt = now().toISOString();
  const rows: RelationshipEvidenceRow[] = [];
  for (const mentions of mentionsByChunk.values()) {
    const firstMention = mentions[0];
    if (!firstMention) continue;
    const chunk = chunksById.get(firstMention.chunk_id);
    for (const relation of ontology.relations) {
      for (const mention of mentions) {
        if (relation.left_entity === 'Document' && relation.right_entity === mention.entity_type) {
          rows.push(
            buildEvidenceRow({
              relationType: relation.relation_type,
              leftEntityId: mention.document_id,
              rightEntityId: mention.resolved_entity_id!,
              confidence: mention.resolution_confidence ?? mention.confidence,
              evidenceRef: mention.mention_id,
              chunk,
              mention,
              spanStart: mention.span_start,
              spanEnd: mention.span_end,
              spec,
              ontology,
              recordedAt,
              modelId: 'fallback',
            })
          );
        }
        if (relation.right_entity === 'Document' && relation.left_entity === mention.entity_type) {
          rows.push(
            buildEvidenceRow({
              relationType: relation.relation_type,
              leftEntityId: mention.resolved_entity_id!,
              rightEntityId: mention.document_id,
              confidence: mention.resolution_confidence ?? mention.confidence,
              evidenceRef: mention.mention_id,
              chunk,
              mention,
              spanStart: mention.span_start,
              spanEnd: mention.span_end,
              spec,
              ontology,
              recordedAt,
              modelId: 'fallback',
            })
          );
        }
      }
    }

    const pairs = buildCandidatePairs(
      mentions,
      ontology,
      candidatePairRules ?? spec.candidate_pair_rules
    );
    for (const pair of pairs) {
      const left = mentions.find((mention) => mention.mention_id === pair.left_mention_id);
      const right = mentions.find((mention) => mention.mention_id === pair.right_mention_id);
      if (!left || !right) continue;
      const start =
        left.span_start !== undefined && right.span_start !== undefined
          ? Math.min(left.span_start, right.span_start)
          : undefined;
      const end =
        left.span_end !== undefined && right.span_end !== undefined
          ? Math.max(left.span_end, right.span_end)
          : undefined;
      for (const relationType of pair.allowed_relation_types) {
        rows.push(
          buildEvidenceRow({
            relationType,
            leftEntityId: pair.left_entity_id,
            rightEntityId: pair.right_entity_id,
            confidence: Math.min(
              left.resolution_confidence ?? left.confidence,
              right.resolution_confidence ?? right.confidence
            ),
            evidenceRef: pair.pair_id,
            chunk,
            mention: left,
            spanStart: start,
            spanEnd: end,
            spec,
            ontology,
            recordedAt,
            modelId: 'fallback',
          })
        );
      }
    }
  }
  return rows;
}
