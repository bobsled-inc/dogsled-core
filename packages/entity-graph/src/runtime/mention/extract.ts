/**
 * Two-stage retrieve-then-resolve mention extraction.
 *
 * Stage 1: candidate retrieval → top-K from `__entity_profile`. Auto-link
 *          if top sim > 0.95.
 * Stage 2: LLM disambiguation via @bobsled-inc/ai's `generateStructured`,
 *          discriminated-union return; schema_violation → `unresolved`.
 *          Post-hoc validate via `validateLlmResolution`.
 *
 * Confidence bands aligned with agent-first routing:
 *  > 0.95   -> exact_match (Stage 1 only)
 *  0.85+    -> llm_disambiguation, agent_applied audit route
 *  0.55+    -> llm_disambiguation, agent_review/eval route
 *  < 0.55   -> unresolved
 */

import { createHash } from 'node:crypto';

import type { Candidate, CandidateRetrievalStrategy } from '../candidate-retrieval/interface.js';
import { buildPrompt } from './prompt-builder.js';
import { validateLlmResolution, type LlmResolutionInput } from './llm-response-validator.js';
import { normalizeMentionSurface } from './surface-hygiene.js';

export type ResolutionMethod =
  | 'exact_match'
  | 'llm_disambiguation'
  | 'compromise_ner'
  | 'unresolved'
  | 'schema_violation';

export interface MentionRow {
  mention_id: string;
  chunk_id: string;
  document_version_id: string;
  document_id: string;
  entity_type: string;
  entity_name: string;
  confidence: number;
  span_start: number;
  span_end: number;
  resolved_entity_id: string | null;
  resolution_method: ResolutionMethod;
  resolution_confidence: number;
  superseded_at: string | null;
  extracted_at: string;
  extraction_role: string;
  notes: {
    injection_markers: string[];
    review_route?: 'agent_applied' | 'agent_review' | 'unresolved';
    review_flag?: boolean;
    proposal_source?: 'llm' | 'compromise' | 'profile_alias';
    proposal_failure?: 'schema_violation' | 'budget_exceeded' | 'provider_error';
    dropped_reason?: string;
    surface_filter?: string;
  } | null;
}

export interface MentionInput {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  document_version_id: string;
  entity_type: string;
  entity_name: string;
  span_start: number;
  span_end: number;
  /** Source-form confidence from the surface extractor (NER etc.). */
  source_confidence: number;
}

export interface EntitySemanticContext {
  entity_type: string;
  definition?: string;
  categories?: Array<{ name: string; description: string }>;
  positive_examples?: string[];
  negative_examples?: string[];
}

export type LlmCall = (prompt: ReturnType<typeof buildPrompt>) => Promise<
  | { ok: true; value: LlmResolutionInput; tokenUsage: number; costUsd: number }
  | {
      ok: false;
      error: 'schema_violation' | 'budget_exceeded' | 'provider_error';
      raw?: string;
      message: string;
      attempts: number;
    }
>;

export interface ExtractMentionOptions {
  strategy: CandidateRetrievalStrategy;
  llmCall: LlmCall;
  /** Dogsled AI model role used (for audit). */
  extractionRole: string;
  /** Top-K passed to candidate retrieval. */
  k?: number;
  /** Minimum similarity for stage-1 retrieval. */
  minSim?: number;
  /** Candidate entity types allowed by the mention extraction spec. */
  allowedEntityTypes?: readonly string[];
  /**
   * For multi-entity specs, generic NER labels are only surface hints. The
   * resolved candidate type becomes the final mention type.
   */
  candidateLedEntityType?: boolean;
  entitySemantics?: readonly EntitySemanticContext[];
  /**
   * Test seam — defaults to wall clock. Used for deterministic
   * `extracted_at` in unit tests.
   */
  now?: () => Date;
}

function normalizeExactSurface(surface: string): string {
  return normalizeMentionSurface(surface)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function isShortAcronymSurface(surface: string): boolean {
  const normalized = normalizeMentionSurface(surface).normalize('NFKC');
  return /^[A-Za-z0-9]{1,3}$/.test(normalized);
}

function candidateMatchesSurface(candidate: Candidate, surface: string): boolean {
  const surfaceExact = normalizeExactSurface(surface);
  if (surfaceExact.length === 0) return false;
  return (
    normalizeExactSurface(candidate.matched_text) === surfaceExact ||
    normalizeExactSurface(candidate.canonical_name) === surfaceExact
  );
}

export function filterCandidatesForSurface(candidates: Candidate[], surface: string): Candidate[] {
  if (!isShortAcronymSurface(surface)) return candidates;
  return candidates.filter((candidate) => candidateMatchesSurface(candidate, surface));
}

function isCandidateEntityTypeAllowed(
  candidate: Candidate,
  allowedEntityTypes: readonly string[] | undefined
): boolean {
  return !allowedEntityTypes || allowedEntityTypes.length === 0
    ? true
    : allowedEntityTypes.includes(candidate.entity_type);
}

function rowEntityType(
  input: MentionInput,
  candidate: Candidate | undefined,
  options: ExtractMentionOptions
): string {
  return options.candidateLedEntityType && candidate ? candidate.entity_type : input.entity_type;
}

export function mentionId(input: {
  chunk_id: string;
  entity_type: string;
  entity_name: string;
  span_start: number;
  span_end: number;
}): string {
  // span_end included to prevent collisions on overlapping mentions sharing
  // a start.
  //
  // Hash input is JSON.stringify of an array — collision-free even when
  // entity_name or any other field contains the literal '::'. The
  // previous '::'-joined string allowed two distinct tuples to serialize
  // identically and produce the same mention_id.
  const serialized = JSON.stringify([
    input.chunk_id,
    input.entity_type,
    input.entity_name,
    input.span_start,
    input.span_end,
  ]);
  return createHash('sha256').update(serialized).digest('hex');
}

export async function extractMention(
  input: MentionInput,
  options: ExtractMentionOptions
): Promise<MentionRow> {
  const now = options.now ? options.now() : new Date();
  const k = options.k ?? 10;
  const minSim = options.minSim ?? 0.55;

  const searchText = normalizeMentionSurface(input.entity_name);
  const candidates = filterCandidatesForSurface(
    await options.strategy.retrieve({
      mention_text: searchText,
      k,
      min_sim: minSim,
      entity_types: options.allowedEntityTypes,
    }),
    searchText
  ).filter((candidate) => isCandidateEntityTypeAllowed(candidate, options.allowedEntityTypes));

  const unresolvedEntityType = rowEntityType(input, undefined, options);
  const unresolvedId = mentionId({
    chunk_id: input.chunk_id,
    entity_type: unresolvedEntityType,
    entity_name: input.entity_name,
    span_start: input.span_start,
    span_end: input.span_end,
  });

  const baseFor = (
    entityType: string,
    id: string
  ): Omit<
    MentionRow,
    'resolved_entity_id' | 'resolution_method' | 'resolution_confidence' | 'notes'
  > => ({
    mention_id: id,
    chunk_id: input.chunk_id,
    document_version_id: input.document_version_id,
    document_id: input.document_id,
    entity_type: entityType,
    entity_name: input.entity_name,
    confidence: input.source_confidence,
    span_start: input.span_start,
    span_end: input.span_end,
    superseded_at: null,
    extracted_at: now.toISOString(),
    extraction_role: options.extractionRole,
  });

  if (searchText.length === 0) {
    return {
      ...baseFor(unresolvedEntityType, unresolvedId),
      resolved_entity_id: null,
      resolution_method: 'unresolved',
      resolution_confidence: 0,
      notes: null,
    };
  }

  const top = candidates[0];
  if (top && top.sim > 0.95) {
    const entityType = rowEntityType(input, top, options);
    return {
      ...baseFor(
        entityType,
        mentionId({
          chunk_id: input.chunk_id,
          entity_type: entityType,
          entity_name: input.entity_name,
          span_start: input.span_start,
          span_end: input.span_end,
        })
      ),
      resolved_entity_id: top.entity_id,
      resolution_method: 'exact_match',
      resolution_confidence: top.sim,
      notes: null,
    };
  }

  // No candidates within min_sim — unresolved.
  if (candidates.length === 0) {
    return {
      ...baseFor(unresolvedEntityType, unresolvedId),
      resolved_entity_id: null,
      resolution_method: 'unresolved',
      resolution_confidence: 0,
      notes: null,
    };
  }

  // Stage 2: LLM disambiguation via @bobsled-inc/ai.
  const prompt = buildPrompt({
    mention_text: searchText,
    original_mention_text: input.entity_name,
    chunk_text: input.chunk_text,
    candidates,
    entity_semantics: options.entitySemantics ?? [],
  });

  const result = await options.llmCall(prompt);

  if (!result.ok) {
    if (result.error === 'schema_violation') {
      return {
        ...baseFor(unresolvedEntityType, unresolvedId),
        resolved_entity_id: null,
        resolution_method: 'schema_violation',
        resolution_confidence: 0,
        notes: { injection_markers: prompt.injection_markers },
      };
    }
    // budget_exceeded / provider_error: surface as unresolved (caller may
    // re-enqueue when budget refreshes / provider recovers).
    return {
      ...baseFor(unresolvedEntityType, unresolvedId),
      resolved_entity_id: null,
      resolution_method: 'unresolved',
      resolution_confidence: 0,
      notes: { injection_markers: prompt.injection_markers },
    };
  }

  const validated = validateLlmResolution(
    result.value,
    candidates,
    searchText,
    options.allowedEntityTypes
  );
  if (!validated) {
    return {
      ...baseFor(unresolvedEntityType, unresolvedId),
      resolved_entity_id: null,
      resolution_method: 'unresolved',
      resolution_confidence: 0,
      notes: { injection_markers: prompt.injection_markers },
    };
  }

  const entityType = options.candidateLedEntityType ? validated.entity_type : input.entity_type;
  const resolvedBase = baseFor(
    entityType,
    mentionId({
      chunk_id: input.chunk_id,
      entity_type: entityType,
      entity_name: input.entity_name,
      span_start: input.span_start,
      span_end: input.span_end,
    })
  );

  // Agent-first routing: confidence below the configured floor (0.55)
  // collapses to `unresolved`, while review-band rows stay linked and
  // route to the agent/eval queue instead of blocking on humans.
  if (validated.confidence < 0.55) {
    return {
      ...resolvedBase,
      resolved_entity_id: null,
      resolution_method: 'unresolved',
      resolution_confidence: validated.confidence,
      notes: {
        injection_markers: [...prompt.injection_markers, ...validated.injection_markers],
      },
    };
  }

  const reviewRoute = validated.confidence < 0.85 ? 'agent_review' : 'agent_applied';

  return {
    ...resolvedBase,
    resolved_entity_id: validated.resolved_entity_id,
    resolution_method: 'llm_disambiguation',
    resolution_confidence: validated.confidence,
    notes: {
      injection_markers: [...prompt.injection_markers, ...validated.injection_markers],
      review_route: reviewRoute,
    },
  };
}
