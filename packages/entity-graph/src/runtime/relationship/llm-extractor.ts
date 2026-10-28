import type { ResolvedRelationshipOntology } from '../../compiler/ontology/types.js';
import type { EntitySemanticContext } from '../mention/extract.js';
import {
  buildCandidatePairs,
  type CandidatePairRules,
  type ResolvedChunkMention,
} from './candidate-pairs.js';
import { buildRelationshipPrompt, type BuildRelationshipPromptOutput } from './prompt-builder.js';
import {
  validateRelationshipResponse,
  type RelationshipExtractionResponse,
} from './response-validator.js';
import {
  reviewFlagForConfidence,
  writeRelationshipEvidence,
  type RelationshipEvidenceRow,
  type RelationshipEvidenceStore,
} from './evidence-writer.js';
import { relationshipId, relationshipIdempotencyHash } from './idempotency.js';

export type RelationshipLlmCall = (prompt: BuildRelationshipPromptOutput) => Promise<
  | {
      ok: true;
      value: RelationshipExtractionResponse;
      model_id: string;
      model_metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: 'schema_violation' | 'budget_exceeded' | 'provider_error';
      message: string;
      raw?: string;
    }
>;

export interface ExtractRelationshipsForChunkInput {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  document_version_id: string;
  document_format?: string;
  mentions: readonly ResolvedChunkMention[];
}

export interface ExtractRelationshipsForChunkOptions {
  ontology: ResolvedRelationshipOntology;
  llmCall: RelationshipLlmCall;
  extractionRole: string;
  promptVersion: string;
  candidatePairRules?: CandidatePairRules;
  entitySemantics?: readonly EntitySemanticContext[];
  requireSpanEvidence?: boolean;
  documentFormatIn?: readonly string[];
  hasResolvedMentionsMin?: number;
  store?: RelationshipEvidenceStore;
  now?: () => Date;
}

export interface ExtractRelationshipsForChunkResult {
  evidence: RelationshipEvidenceRow[];
  rejected: ReturnType<typeof validateRelationshipResponse>['rejected'];
  inserted: number;
  skipped: number;
  diagnostics: RelationshipExtractionChunkDiagnostics;
}

export interface RelationshipExtractionChunkDiagnostics {
  candidate_pairs_considered: number;
  llm_calls: number;
  accepted_relationships: number;
  inserted_relationships: number;
  skipped_relationships: number;
  rejected_relationships_by_reason: Record<string, number>;
  provider_failures: Record<string, number>;
  zero_row_chunks: number;
}

function emptyDiagnostics(): RelationshipExtractionChunkDiagnostics {
  return {
    candidate_pairs_considered: 0,
    llm_calls: 0,
    accepted_relationships: 0,
    inserted_relationships: 0,
    skipped_relationships: 0,
    rejected_relationships_by_reason: {},
    provider_failures: {},
    zero_row_chunks: 0,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function extractRelationshipsForChunk(
  input: ExtractRelationshipsForChunkInput,
  options: ExtractRelationshipsForChunkOptions
): Promise<ExtractRelationshipsForChunkResult> {
  const resolvedCount = input.mentions.filter((mention) => mention.resolved_entity_id).length;
  const diagnostics = emptyDiagnostics();
  if (resolvedCount < (options.hasResolvedMentionsMin ?? 2)) {
    return { evidence: [], rejected: [], inserted: 0, skipped: 0, diagnostics };
  }
  if (options.documentFormatIn) {
    if (!input.document_format || !options.documentFormatIn.includes(input.document_format)) {
      return { evidence: [], rejected: [], inserted: 0, skipped: 0, diagnostics };
    }
  }

  const pairs = buildCandidatePairs(input.mentions, options.ontology, options.candidatePairRules);
  diagnostics.candidate_pairs_considered = pairs.length;
  if (pairs.length === 0) {
    return { evidence: [], rejected: [], inserted: 0, skipped: 0, diagnostics };
  }

  const prompt = buildRelationshipPrompt({
    chunk_text: input.chunk_text,
    ontology: options.ontology,
    pairs,
    entity_semantics: options.entitySemantics,
    require_span_evidence: options.requireSpanEvidence,
  });
  diagnostics.llm_calls = 1;
  const llm = await options.llmCall(prompt);
  if (!llm.ok) {
    increment(diagnostics.provider_failures, llm.error);
    increment(diagnostics.rejected_relationships_by_reason, llm.error);
    diagnostics.zero_row_chunks = 1;
    return {
      evidence: [],
      rejected: [{ item: llm.raw ?? llm.message, reason: llm.error }],
      inserted: 0,
      skipped: 0,
      diagnostics,
    };
  }

  const validation = validateRelationshipResponse(llm.value, {
    chunk_text: input.chunk_text,
    pairs,
    require_span_evidence: options.requireSpanEvidence ?? true,
  });
  diagnostics.accepted_relationships = validation.accepted.length;
  for (const rejected of validation.rejected) {
    increment(diagnostics.rejected_relationships_by_reason, rejected.reason);
  }

  const recordedAt = (options.now ? options.now() : new Date()).toISOString();
  const relationByType = new Map(
    options.ontology.relations.map((relation) => [relation.relation_type, relation])
  );
  const evidence = validation.accepted.map((item): RelationshipEvidenceRow => {
    const relation = relationByType.get(item.relation_type)!;
    const modelMetadata = {
      ...(llm.model_metadata ?? {}),
      model_id: llm.model_id,
      evidence_validation: options.requireSpanEvidence === false ? 'review_only' : 'span_validated',
    };
    return {
      evidence_id: relationshipIdempotencyHash({
        document_version_id: input.document_version_id,
        chunk_id: input.chunk_id,
        left_entity_id: item.left_entity_id,
        right_entity_id: item.right_entity_id,
        relation_type: item.relation_type,
        ontology_version: options.ontology.ontologyVersion,
        prompt_version: options.promptVersion,
        model_id: llm.model_id,
      }),
      relationship_id: relationshipId(item),
      relation_type: item.relation_type,
      left_entity_id: item.left_entity_id,
      right_entity_id: item.right_entity_id,
      evidence_kind: 'llm_extraction',
      evidence_ref: item.pair_id,
      source_document_id: input.document_id,
      source_document_version_id: input.document_version_id,
      source_chunk_id: input.chunk_id,
      span_start: item.span_start ?? null,
      span_end: item.span_end ?? null,
      evidence_excerpt: item.evidence_excerpt ?? null,
      confidence: item.confidence,
      extraction_role: options.extractionRole,
      prompt_version: options.promptVersion,
      ontology_version: options.ontology.ontologyVersion,
      model_metadata: JSON.stringify(modelMetadata),
      injection_markers:
        prompt.injection_markers.length === 0 ? null : JSON.stringify(prompt.injection_markers),
      review_flag:
        options.requireSpanEvidence === false
          ? 'human_review'
          : reviewFlagForConfidence(item.confidence, relation.review_thresholds),
      observed_at: null,
      recorded_at: recordedAt,
    };
  });

  const writeResult = options.store
    ? await writeRelationshipEvidence(evidence, options.store)
    : { inserted: evidence.length, skipped: 0 };
  diagnostics.inserted_relationships = writeResult.inserted;
  diagnostics.skipped_relationships = writeResult.skipped;
  if (writeResult.inserted === 0) diagnostics.zero_row_chunks = 1;

  return {
    evidence,
    rejected: validation.rejected,
    inserted: writeResult.inserted,
    skipped: writeResult.skipped,
    diagnostics,
  };
}
