import { mentionId, type MentionRow } from './extract.js';
import {
  evaluateMentionSurface,
  type MentionSurfaceFilters,
  type SurfaceDropReason,
} from './surface-hygiene.js';

interface ProfileAliasChunkInput {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  document_version_id: string;
}

export interface ProfileAliasCandidate {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  aliases: readonly string[];
}

export interface ProfileAliasMatch extends ProfileAliasCandidate {
  surface_text: string;
  span_start: number;
  span_end: number;
}

export interface ProfileAliasDiagnostics {
  dropped_surface_spans: Partial<Record<SurfaceDropReason, number>>;
  profile_alias_matches: number;
}

function recordSurfaceDrop(
  diagnostics: ProfileAliasDiagnostics | undefined,
  reason: SurfaceDropReason
): void {
  if (!diagnostics) return;
  diagnostics.dropped_surface_spans[reason] = (diagnostics.dropped_surface_spans[reason] ?? 0) + 1;
}

function isBoundaryChar(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9_]/.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateSurfaces(candidate: ProfileAliasCandidate): string[] {
  return [...new Set([candidate.canonical_name, ...candidate.aliases].filter((s) => s.length > 0))];
}

function findSurfaceMatches(
  chunkText: string,
  surface: string
): Array<{ surface_text: string; span_start: number; span_end: number }> {
  const matches: Array<{ surface_text: string; span_start: number; span_end: number }> = [];
  const regex = new RegExp(escapeRegex(surface), 'giu');
  for (const match of chunkText.matchAll(regex)) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + match[0].length;
    if (!isBoundaryChar(chunkText[start - 1]) || !isBoundaryChar(chunkText[end])) continue;
    matches.push({ surface_text: chunkText.slice(start, end), span_start: start, span_end: end });
  }
  return matches;
}

export function profileAliasMatches(options: {
  input: ProfileAliasChunkInput;
  candidates?: readonly ProfileAliasCandidate[];
  surfaceFilters?: MentionSurfaceFilters;
  diagnostics?: ProfileAliasDiagnostics;
}): ProfileAliasMatch[] {
  const rawMatches = (options.candidates ?? []).flatMap((candidate) =>
    candidateSurfaces(candidate).flatMap((surface) =>
      findSurfaceMatches(options.input.chunk_text, surface).map((match) => ({
        ...candidate,
        ...match,
      }))
    )
  );

  const filtered = rawMatches.filter((match) => {
    const result = evaluateMentionSurface(match.surface_text, options.surfaceFilters, {
      chunkText: options.input.chunk_text,
      spanStart: match.span_start,
      spanEnd: match.span_end,
    });
    if (result.ok) return true;
    recordSurfaceDrop(options.diagnostics, result.reason);
    return false;
  });

  const selected: ProfileAliasMatch[] = [];
  for (const match of filtered.sort((a, b) => {
    const lengthDiff = b.span_end - b.span_start - (a.span_end - a.span_start);
    if (lengthDiff !== 0) return lengthDiff;
    if (a.span_start !== b.span_start) return a.span_start - b.span_start;
    const entityTypeDiff = a.entity_type.localeCompare(b.entity_type);
    if (entityTypeDiff !== 0) return entityTypeDiff;
    return a.entity_id.localeCompare(b.entity_id);
  })) {
    if (
      selected.some(
        (existing) => existing.span_start < match.span_end && match.span_start < existing.span_end
      )
    ) {
      continue;
    }
    selected.push(match);
  }

  selected.sort((a, b) => a.span_start - b.span_start || a.entity_id.localeCompare(b.entity_id));
  if (options.diagnostics) options.diagnostics.profile_alias_matches += selected.length;
  return selected;
}

export function profileAliasRows(options: {
  input: ProfileAliasChunkInput;
  matches: readonly ProfileAliasMatch[];
  extractionRole: string;
  now?: () => Date;
}): MentionRow[] {
  const now = options.now ? options.now() : new Date();
  return options.matches.map((match) => ({
    mention_id: mentionId({
      chunk_id: options.input.chunk_id,
      entity_type: match.entity_type,
      entity_name: match.surface_text,
      span_start: match.span_start,
      span_end: match.span_end,
    }),
    chunk_id: options.input.chunk_id,
    document_version_id: options.input.document_version_id,
    document_id: options.input.document_id,
    entity_type: match.entity_type,
    entity_name: match.surface_text,
    confidence: 1,
    span_start: match.span_start,
    span_end: match.span_end,
    resolved_entity_id: match.entity_id,
    resolution_method: 'exact_match',
    resolution_confidence: 1,
    superseded_at: null,
    extracted_at: now.toISOString(),
    extraction_role: options.extractionRole,
    notes: {
      injection_markers: [],
      review_route: 'agent_applied',
      proposal_source: 'profile_alias',
    },
  }));
}
