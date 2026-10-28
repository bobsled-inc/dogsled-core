export {
  buildPrompt,
  neutralizeChunkText,
  type BuildPromptInput,
  type BuildPromptOutput,
} from './prompt-builder.js';
export {
  buildSurfaceProposalPrompt,
  proposeSurfaces,
  validateSurfaceProposals,
  ProposedSurfaceSchema,
  SurfaceProposalResponseSchema,
  type BuildSurfaceProposalPromptOutput,
  type ProposedSurface,
  type SurfaceProposalCall,
  type SurfaceProposalInput,
  type SurfaceProposalModelCall,
  type SurfaceProposalResponse,
} from './surface-proposer.js';
export {
  validateLlmResolution,
  type LlmResolutionInput,
  type ValidatedResolution,
} from './llm-response-validator.js';
export {
  extractMention,
  filterCandidatesForSurface,
  isShortAcronymSurface,
  mentionId,
  type EntitySemanticContext,
  type ExtractMentionOptions,
  type LlmCall,
  type MentionInput,
  type MentionRow,
  type ResolutionMethod,
} from './extract.js';
export {
  evaluateMentionSurface,
  normalizeMentionSurface,
  type MentionSurfaceFilters,
  type SurfaceDropReason,
  type SurfaceFilterContext,
  type SurfaceFilterResult,
} from './surface-hygiene.js';
export { PerSourceRateLimiter } from './budget.js';
export type { RateLimitOptions } from './budget.js';
export {
  buildSupersedeOrphansSql,
  createChunkerConfigChangeHandler,
  ChunkerConfigChangePayloadSchema,
} from './chunker-config-change.js';
export type {
  ChunkerConfigChangePayload,
  ChunkerConfigChangeRunner,
} from './chunker-config-change.js';
export { createCompromiseFallback } from './compromise-fallback.js';
export type {
  CompromiseFallback,
  CompromiseFallbackInput,
  CompromiseFallbackOptions,
  FallbackMentionSpan,
} from './compromise-fallback.js';
export {
  buildMentionQualityViewSelect,
  buildRelationshipEvidenceDiversitySelect,
} from './quality-view.js';
export type {
  MentionQualityViewOptions,
  RelationshipEvidenceDiversityOptions,
} from './quality-view.js';
export { extractChunk } from './extract-chunk.js';
export type {
  ExtractChunkInput,
  ExtractChunkMode,
  ExtractChunkOptions,
  MentionExtractionDiagnostics,
  MentionFallbackMode,
} from './extract-chunk.js';
export type {
  ProfileAliasCandidate,
  ProfileAliasDiagnostics,
  ProfileAliasMatch,
} from './profile-alias.js';
