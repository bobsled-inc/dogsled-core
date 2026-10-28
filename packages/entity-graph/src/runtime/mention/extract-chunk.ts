/**
 * Chunk-level mention extraction with `compromise` NER fallback.
 *
 * Two operating modes:
 *
 *  - **`primary`** (default): use the LLM disambiguator end-to-end. Spans
 *    are typically supplied by an upstream surface extractor; for chunks
 *    without pre-resolved spans, `compromise` discovers candidate
 *    surfaces and the LLM disambiguates each one.
 *  - **`fallback`**: when `llmCall` is unavailable (cost cap hit,
 *    Bedrock IAM down, `--fallback compromise`), runs `compromise` only
 *    and emits rows with `resolution_method = 'compromise_ner'` —
 *    `resolved_entity_id` left null so review queue surfaces them.
 *
 * `primary` mode routes every candidate span through `extractMention()`,
 * which owns the LLM + validate pipeline. `fallback` mode skips
 * `extractMention()` and assembles `compromise_ner` rows directly in this
 * file — it only consults candidate retrieval for opportunistic exact-match
 * promotion (sim > 0.95).
 */

import type { CandidateRetrievalStrategy } from '../candidate-retrieval/interface.js';
import type { CompromiseFallback, FallbackMentionSpan } from './compromise-fallback.js';
import {
  extractMention,
  filterCandidatesForSurface,
  mentionId,
  type ExtractMentionOptions,
  type EntitySemanticContext,
  type LlmCall,
  type MentionInput,
  type MentionRow,
} from './extract.js';
import {
  evaluateMentionSurface,
  normalizeMentionSurface,
  type MentionSurfaceFilters,
  type SurfaceDropReason,
} from './surface-hygiene.js';
import {
  profileAliasMatches,
  profileAliasRows,
  type ProfileAliasCandidate,
  type ProfileAliasMatch,
} from './profile-alias.js';
import type { ProposedSurface, SurfaceProposalCall } from './surface-proposer.js';

export type ExtractChunkMode = 'primary' | 'fallback';
type ProposalFailure = 'schema_violation' | 'budget_exceeded' | 'provider_error';
export type MentionFallbackMode = 'compromise' | 'none';

export interface MentionExtractionDiagnostics {
  surface_proposer_failures: Partial<Record<ProposalFailure, number>>;
  fallback_none_chunks: number;
  dropped_generic_spans: number;
  dropped_surface_spans: Partial<Record<SurfaceDropReason, number>>;
  profile_alias_matches: number;
}

export interface ExtractChunkInput {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  document_version_id: string;
}

export interface ExtractChunkOptions {
  strategy: CandidateRetrievalStrategy;
  /**
   * LLM call. Required for `mode: 'primary'`. Optional for
   * `mode: 'fallback'` — if provided alongside `mode: 'fallback'`, ignored.
   */
  llmCall?: LlmCall;
  fallback: CompromiseFallback;
  extractionRole: string;
  mode?: ExtractChunkMode;
  k?: number;
  minSim?: number;
  /** Optional ontology-aware entity type allowlist. Omitted preserves legacy behavior. */
  allowedEntityTypes?: readonly string[];
  /** Use selected candidate type as final mention type for multi-entity extraction. */
  candidateLedEntityType?: boolean;
  entitySemantics?: readonly EntitySemanticContext[];
  surfaceProposer?: SurfaceProposalCall;
  fallbackMode?: MentionFallbackMode;
  surfaceFilters?: MentionSurfaceFilters;
  profileAliasCandidates?: readonly ProfileAliasCandidate[];
  diagnostics?: MentionExtractionDiagnostics;
  now?: () => Date;
}

const GENERIC_FALLBACK_ENTITY_TYPES = new Set(['company', 'person', 'location', 'product']);

function serializeRetrieval(strategy: CandidateRetrievalStrategy): CandidateRetrievalStrategy {
  let chain: Promise<void> = Promise.resolve();
  return {
    dialect: strategy.dialect,
    retrieve(input) {
      const result = chain.then(() => strategy.retrieve(input));
      chain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}

function spansToInputs(
  base: ExtractChunkInput,
  spans: readonly FallbackMentionSpan[]
): MentionInput[] {
  return spans.map((s) => ({
    chunk_id: base.chunk_id,
    chunk_text: base.chunk_text,
    document_id: base.document_id,
    document_version_id: base.document_version_id,
    entity_type: s.entity_type,
    entity_name: s.entity_name,
    span_start: s.span_start,
    span_end: s.span_end,
    source_confidence: s.source_confidence,
  }));
}

function surfacesToInputs(
  base: ExtractChunkInput,
  surfaces: readonly ProposedSurface[]
): MentionInput[] {
  return surfaces.map((surface) => ({
    chunk_id: base.chunk_id,
    chunk_text: base.chunk_text,
    document_id: base.document_id,
    document_version_id: base.document_version_id,
    entity_type: surface.entity_type,
    entity_name: surface.surface_text,
    span_start: surface.span_start,
    span_end: surface.span_end,
    source_confidence: surface.source_confidence,
  }));
}

function filterAllowedInputs(inputs: MentionInput[], options: ExtractChunkOptions): MentionInput[] {
  const allowedEntityTypes = options.allowedEntityTypes
    ? new Set(options.allowedEntityTypes)
    : undefined;
  return inputs.filter((span) => {
    if (!allowedEntityTypes) return true;
    return allowedEntityTypes.has(span.entity_type) || options.candidateLedEntityType === true;
  });
}

function recordSurfaceDrop(
  diagnostics: MentionExtractionDiagnostics | undefined,
  reason: SurfaceDropReason
): void {
  if (!diagnostics) return;
  diagnostics.dropped_surface_spans[reason] = (diagnostics.dropped_surface_spans[reason] ?? 0) + 1;
}

function recordProposalFailure(
  diagnostics: MentionExtractionDiagnostics | undefined,
  reason: ProposalFailure
): void {
  if (!diagnostics) return;
  diagnostics.surface_proposer_failures[reason] =
    (diagnostics.surface_proposer_failures[reason] ?? 0) + 1;
}

function filterSurfaceInputs(inputs: MentionInput[], options: ExtractChunkOptions): MentionInput[] {
  return inputs.filter((span) => {
    const result = evaluateMentionSurface(span.entity_name, options.surfaceFilters, {
      chunkText: span.chunk_text,
      spanStart: span.span_start,
      spanEnd: span.span_end,
    });
    if (result.ok) return true;
    recordSurfaceDrop(options.diagnostics, result.reason);
    return false;
  });
}

function overlaps(a: { span_start: number; span_end: number }, b: MentionInput): boolean {
  return a.span_start < b.span_end && b.span_start < a.span_end;
}

function dropInputsOverlappingProfileAliases(
  inputs: MentionInput[],
  aliasMatches: readonly ProfileAliasMatch[]
): MentionInput[] {
  if (aliasMatches.length === 0) return inputs;
  return inputs.filter((input) => !aliasMatches.some((match) => overlaps(match, input)));
}

function isDisallowedGenericInput(input: MentionInput, options: ExtractChunkOptions): boolean {
  if (options.candidateLedEntityType !== true) return false;
  const allowed = new Set(options.allowedEntityTypes ?? []);
  if (allowed.size === 0 || allowed.has(input.entity_type)) return false;
  return GENERIC_FALLBACK_ENTITY_TYPES.has(input.entity_type.toLowerCase());
}

function isDisallowedGenericRow(row: MentionRow, options: ExtractChunkOptions): boolean {
  if (row.resolved_entity_id) return false;
  if (options.candidateLedEntityType !== true) return false;
  const allowed = new Set(options.allowedEntityTypes ?? []);
  if (allowed.size === 0 || allowed.has(row.entity_type)) return false;
  return GENERIC_FALLBACK_ENTITY_TYPES.has(row.entity_type.toLowerCase());
}

function dropDisallowedGenericRows(rows: MentionRow[], options: ExtractChunkOptions): MentionRow[] {
  return rows.filter((row) => {
    if (!isDisallowedGenericRow(row, options)) return true;
    if (options.diagnostics) options.diagnostics.dropped_generic_spans += 1;
    return false;
  });
}

async function fallbackInputs(
  input: ExtractChunkInput,
  options: ExtractChunkOptions
): Promise<MentionInput[]> {
  const spans = await options.fallback.extract({
    text: input.chunk_text,
    chunkId: input.chunk_id,
    documentId: input.document_id,
    documentVersionId: input.document_version_id,
  });
  return filterSurfaceInputs(filterAllowedInputs(spansToInputs(input, spans), options), options);
}

function withProposalNotes(
  rows: MentionRow[],
  proposalSource: 'llm' | 'compromise' | undefined,
  proposalFailure: ProposalFailure | undefined
): MentionRow[] {
  if (!proposalSource) return rows;
  return rows.map((row) => ({
    ...row,
    notes: {
      injection_markers: row.notes?.injection_markers ?? [],
      ...(row.notes ?? {}),
      proposal_source: proposalSource,
      ...(proposalFailure ? { proposal_failure: proposalFailure } : {}),
    },
  }));
}

export async function extractChunk(
  input: ExtractChunkInput,
  options: ExtractChunkOptions
): Promise<MentionRow[]> {
  const mode: ExtractChunkMode = options.mode ?? 'primary';
  const fallbackMode: MentionFallbackMode = options.fallbackMode ?? 'compromise';
  const aliasMatches = profileAliasMatches({
    input,
    candidates: options.profileAliasCandidates,
    surfaceFilters: options.surfaceFilters,
    diagnostics: options.diagnostics,
  });
  const aliasRows = profileAliasRows({
    input,
    matches: aliasMatches,
    extractionRole: options.extractionRole,
    now: options.now,
  });
  let inputs: MentionInput[];
  let proposalSource: 'llm' | 'compromise' | undefined;
  let proposalFailure: ProposalFailure | undefined;

  if (mode === 'primary' && options.surfaceProposer) {
    const proposed = await options.surfaceProposer({
      chunk_text: input.chunk_text,
      chunk_id: input.chunk_id,
      document_id: input.document_id,
      document_version_id: input.document_version_id,
      entity_semantics: options.entitySemantics ?? [],
      allowed_entity_types: options.allowedEntityTypes ?? [],
    });
    if (proposed.ok) {
      proposalSource = 'llm';
      inputs = filterSurfaceInputs(surfacesToInputs(input, proposed.surfaces), options);
    } else {
      proposalFailure = proposed.error;
      recordProposalFailure(options.diagnostics, proposed.error);
      if (fallbackMode === 'none') {
        if (options.diagnostics) options.diagnostics.fallback_none_chunks += 1;
        return aliasRows;
      }
      proposalSource = 'compromise';
      inputs = await fallbackInputs(input, options);
    }
  } else {
    if (mode === 'primary' && !options.surfaceProposer && fallbackMode === 'none') {
      if (options.diagnostics) options.diagnostics.fallback_none_chunks += 1;
      return aliasRows;
    }
    if (mode === 'fallback' && fallbackMode === 'none') {
      if (options.diagnostics) options.diagnostics.fallback_none_chunks += 1;
      return aliasRows;
    }
    inputs = await fallbackInputs(input, options);
  }

  inputs = dropInputsOverlappingProfileAliases(inputs, aliasMatches);

  if (inputs.length === 0) return aliasRows;

  if (mode === 'primary') {
    if (!options.llmCall) {
      throw new Error("extractChunk: mode 'primary' requires options.llmCall");
    }
    const ext: ExtractMentionOptions = {
      strategy: options.strategy,
      llmCall: options.llmCall,
      extractionRole: options.extractionRole,
    };
    if (options.k !== undefined) ext.k = options.k;
    if (options.minSim !== undefined) ext.minSim = options.minSim;
    if (options.now) ext.now = options.now;
    if (options.allowedEntityTypes) ext.allowedEntityTypes = options.allowedEntityTypes;
    if (options.candidateLedEntityType !== undefined) {
      ext.candidateLedEntityType = options.candidateLedEntityType;
    }
    if (options.entitySemantics) ext.entitySemantics = options.entitySemantics;
    ext.strategy = serializeRetrieval(ext.strategy);
    const rows = await Promise.all(inputs.map((i) => extractMention(i, ext)));
    const annotated = withProposalNotes(rows, proposalSource, proposalFailure);
    return [...aliasRows, ...dropDisallowedGenericRows(annotated, options)];
  }

  // Fallback mode: emit `compromise_ner` rows with no LLM call. We still
  // attempt cheap candidate retrieval in case the surface form is an
  // exact match against a known canonical name (sim > 0.95) — that way
  // the fallback continues to populate `resolved_entity_id` for the easy
  // wins instead of always punting to the review queue.
  const now = options.now ? options.now() : new Date();
  const k = options.k ?? 10;
  const minSim = options.minSim ?? 0.55;
  const out: MentionRow[] = [];
  for (const i of inputs) {
    // Fallback mode is deliberately best-effort: candidate retrieval is
    // only used for exact-match promotion, so a backend error here MUST
    // not abort the chunk. Degrade to "no candidates" and still emit
    // the compromise_ner row.
    let candidates: Awaited<ReturnType<typeof options.strategy.retrieve>> = [];
    const searchText = normalizeMentionSurface(i.entity_name);
    try {
      candidates = filterCandidatesForSurface(
        await options.strategy.retrieve({
          mention_text: searchText,
          k,
          min_sim: minSim,
          entity_types: options.allowedEntityTypes,
        }),
        searchText
      ).filter(
        (candidate) =>
          !options.allowedEntityTypes ||
          options.allowedEntityTypes.length === 0 ||
          options.allowedEntityTypes.includes(candidate.entity_type)
      );
    } catch {
      candidates = [];
    }
    const top = candidates[0];
    const exactMatch = top && top.sim > 0.95;
    if (!exactMatch && isDisallowedGenericInput(i, options)) {
      if (options.diagnostics) options.diagnostics.dropped_generic_spans += 1;
      continue;
    }
    const entityType =
      options.candidateLedEntityType && exactMatch && top ? top.entity_type : i.entity_type;
    const id = mentionId({
      chunk_id: i.chunk_id,
      entity_type: entityType,
      entity_name: i.entity_name,
      span_start: i.span_start,
      span_end: i.span_end,
    });
    out.push({
      mention_id: id,
      chunk_id: i.chunk_id,
      document_version_id: i.document_version_id,
      document_id: i.document_id,
      entity_type: entityType,
      entity_name: i.entity_name,
      confidence: i.source_confidence,
      span_start: i.span_start,
      span_end: i.span_end,
      // Exact-match wins still get the `exact_match` label so downstream
      // quality scoring can distinguish "high-confidence even in fallback"
      // from "fallback NER guess that needs review".
      resolved_entity_id: exactMatch ? top.entity_id : null,
      resolution_method: exactMatch ? 'exact_match' : 'compromise_ner',
      resolution_confidence: exactMatch ? top.sim : i.source_confidence,
      superseded_at: null,
      extracted_at: now.toISOString(),
      extraction_role: options.extractionRole,
      notes: { injection_markers: [], review_route: exactMatch ? 'agent_applied' : 'agent_review' },
    });
  }
  return [...aliasRows, ...withProposalNotes(out, proposalSource, proposalFailure)];
}
