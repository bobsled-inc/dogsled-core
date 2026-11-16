/**
 * Public library API surface for `@bobsled-inc/entity-graph`.
 *
 * Imported via `@bobsled-inc/entity-graph/api`. Used by `@bobsled-inc/sdk-codegen`,
 * the `@bobsled-inc/bobsled-core` runtime when dispatching
 * `type: entity-graph` pipelines, and any future consumer that needs
 * programmatic access to the compiled entity-graph inventory or the
 * resolve/compile/run/cluster/profile workflows.
 */

export { inventoryEntityGraph, SDK_IR_VERSION } from './inventory-project.js';
export { autoEmitDocumentSpec } from './auto-spec.js';
export { extractMentionsProject } from './mention-extract-project.js';
export { extractRelationshipsProject } from './relationship-extract-project.js';
export { loadEntityGraphProjectContext } from '../runtime/project-context.js';
export type { AutoEmitDocumentSpecOptions, AutoEmitDocumentSpecResult } from './auto-spec.js';
export type { ExtractMentionsProjectOptions } from './mention-extract-project.js';
export type { ExtractRelationshipsProjectOptions } from './relationship-extract-project.js';
export type {
  EntityGraphProjectContext,
  EntityGraphProjectOptions,
} from '../runtime/project-context.js';

export type {
  EntityGraphInventory,
  SdkEntityInventory,
  SdkRelationshipInventory,
  SdkProfileAttr,
  SdkAttrType,
  SdkDialectCapabilities,
  SdkOntologyInventory,
} from './inventory-project.js';

export {
  validateResolveProject,
  compileResolveProject,
  runResolveProject,
  clusterResolveProject,
  profileResolveProject,
} from './resolve-project.js';
export { describeWorkflowFailure } from './resolve-project.js';
export type {
  ResolveWorkflowOptions,
  ResolveWorkflowResult,
  ResolveWorkflowFailure,
  ResolveValidateEntity,
  ResolveCompileEntity,
  ResolveExecutionEntity,
} from './resolve-project.js';

export { applyReviewDecisions } from './apply-decisions.js';
export type {
  ApplyReviewDecisionsOptions,
  ApplyReviewDecisionsResult,
  MaterializedGoldenRow,
} from './apply-decisions.js';
export {
  generateIncrementalMaterializeSql,
  generateTouchedEntityIdsQuery,
  generateUpdatedGoldenRowsQuery,
} from '../compiler/identity/review-materialize.js';
export type { GenerateIncrementalMaterializeSqlOptions } from '../compiler/identity/review-materialize.js';

// Agent review phase: queue fetch → swappable judge → applyReviewDecisions.
export type {
  AgentDecisionBundleDecision,
  AgentDecisionBundleV1,
} from '../compiler/agent/types.js';
export { reviewResolveProject } from './review-project.js';
export type { ReviewResolveProjectOptions, ReviewResolveProjectResult } from './review-project.js';
export { createModelReviewLlmClient, buildModelReviewPrompt } from './model-review-client.js';
export type {
  CreateModelReviewLlmClientOptions,
  ModelReviewLlmClient,
  ModelReviewPromptInput,
  ModelReviewUsage,
} from './model-review-client.js';
export {
  createExternalReviewerClient,
  buildReviewRequest,
  REVIEW_REQUEST_VERSION,
} from './external-reviewer-client.js';
export type {
  ExternalReviewContextV1,
  ExternalReviewEntitySemanticsV1,
  ExternalReviewJobV1,
  ExternalReviewRequestV1,
  ExternalReviewerClientDeps,
  ExternalReviewerLlmClient,
} from './external-reviewer-client.js';
export { runAgentReview, generateUnreviewedPairsQuery } from '../compiler/identity/agent-review.js';
export type {
  AgentReviewInput,
  AgentReviewMetrics,
  AgentReviewResult,
} from '../compiler/identity/agent-review.js';
export {
  fetchUnreviewedPairContexts,
  mapReviewQueueRowsToPairContexts,
  ReviewQueueRowSchema,
} from '../compiler/identity/agent-review-fetch.js';
export type {
  FetchUnreviewedPairContextsOptions,
  FetchUnreviewedPairContextsResult,
  ReviewQueueRow,
} from '../compiler/identity/agent-review-fetch.js';

export { buildSimilarDecisionsQuery, findSimilarDecisions } from './decision-trace.js';
export type {
  FindSimilarDecisionsOptions,
  FindSimilarDecisionsResult,
  SimilarDecision,
} from './decision-trace.js';

// Agent panel (multi-model consensus reviewer). The orchestrator is
// provider-agnostic; hosts inject concrete per-role judge LlmClients.
export {
  createAgentPanelClient,
  runPanelReview,
  runReviewWithPanel,
  tallyConsensus,
  deriveConfidence,
  FIRST_PANEL_CONTEXT_FIELD,
} from '../compiler/identity/agent-panel.js';
export type {
  AgentPanelClientInput,
  ReviewWithPanelInput,
} from '../compiler/identity/agent-panel.js';
export type {
  LlmClient,
  PairContext,
  PairDecision,
  AgentReviewOptions,
  AgentPolicy,
  ReviewerConfig,
  ResolvedEntitySemantics,
  PanelMode,
  PanelConsensus,
  ResolvedPanelPolicy,
  PanelJudge,
  PanelJudges,
  PanelJudgeLabel,
  PanelTrace,
} from '../compiler/identity/types.js';
