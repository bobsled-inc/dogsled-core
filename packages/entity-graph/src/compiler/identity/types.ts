/**
 * Resolved types for entity resolution pipeline.
 *
 * These types represent parsed and validated resolution specs
 * with all references resolved to concrete table names.
 */

import type { z } from 'zod';
import type { TrustTier } from '@bobsled-inc/model-spec';
import type { FieldMetadata } from '@bobsled-inc/protocol';
import type { AgentThresholdBand } from '../agent/schema.js';
import type { FieldMetadataOverrideSchema } from '../entity-graph/field-metadata.js';

// ---------------------------------------------------------------------------
// Core pipeline types
// ---------------------------------------------------------------------------

export interface ResolvedBlockingConfig {
  rules: BlockingRule[];
  candidateLimit?: number;
}

export interface ResolvedResolutionSpec {
  name: string;
  entity: string;
  description: string;
  inputs: ResolvedInput[];
  standardize: StandardizeTransform[];
  semanticOverrides?: SemanticOverrides;
  semanticTriage?: SemanticTriageConfig;
  blocking?: ResolvedBlockingConfig;
  deterministicRules: DeterministicRule[];
  scoring?: ScoringConfig;
  thresholds: ThresholdBands;
  entityIdPolicy: ResolvedEntityIdPolicy;
  agentPolicy?: AgentPolicy;
  entitySemantics?: ResolvedEntitySemantics;
  profile?: ResolvedProfileConfig;
  targetSchema?: string;
  pairCountWarnLimit?: number;
}

export interface ResolvedInput {
  ref: string;
  fqTableName: string;
  alias: string;
  role?: 'internal' | 'provider';
  trustTier?: TrustTier;
  idFields?: string[];
  /** Column names from the source spec schema, if available. Used to avoid wildcard collisions. */
  sourceColumns?: string[];
  /** Field metadata inherited from upstream Model Spec/source column specs, keyed by column name. */
  sourceFieldMetadata?: SourceFieldMetadataMap;
}

export type FieldMetadataOverride = z.infer<typeof FieldMetadataOverrideSchema>;

export type SemanticOverrides = Record<string, FieldMetadataOverride>;

export type SourceFieldMetadataMap = Readonly<Record<string, FieldMetadata>>;

export type SourceFieldMetadataRegistry = ReadonlyMap<string, SourceFieldMetadataMap>;

export interface SemanticTriageConfig {
  provider: string;
  model?: string;
  dimensions?: number;
  pricePerMillionTokensUsd?: number;
  fields: string[];
  promoteToMergeThreshold: number;
  promoteToRejectThreshold: number;
}

export interface StandardizeTransform {
  field: string;
  transforms: StandardizeFunction[];
  preHashed?: boolean;
}

export type StandardizeFunction =
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'collapse_whitespace'
  | 'nullif_empty'
  | 'normalize_email'
  | 'normalize_email_uid2'
  | 'extract_email_domain'
  | 'strip_email_subaddress'
  | 'strip_accents'
  | 'strip_legal_suffixes'
  | 'strip_trading_as'
  | 'normalize_company'
  | 'strip_www'
  | 'strip_protocol'
  | 'extract_domain'
  | 'digits_only'
  | 'strip_country_code'
  | 'strip_phone_extension'
  | 'normalize_phone'
  | 'normalize_state'
  | 'expand_street_abbreviations'
  | 'normalize_street'
  | 'normalize_postal'
  | 'remove_punctuation'
  | 'fingerprint'
  | 'parse_number'
  | 'sha256'
  | 'hmac_sha256';

export interface BlockingRule {
  name: string;
  key: string;
}

export interface DeterministicRule {
  name: string;
  conditions: DeterministicCondition[];
  /**
   * auto_merge merges the pair directly; flag_for_review routes it to
   * __review_queue regardless of score band (match_type
   * 'deterministic_review'), leaving the merge to a review decision.
   */
  action: 'auto_merge' | 'flag_for_review';
  confidence: number;
}

export interface DeterministicCondition {
  field: string;
  operator: 'exact';
  bothNotNull: boolean;
}

/**
 * Whether any deterministic rule routes to review instead of merging.
 * Codegen branches on this so specs without flag_for_review rules emit
 * exactly the SQL they did before the action existed.
 */
export function hasFlagForReviewRules(
  spec: Pick<ResolvedResolutionSpec, 'deterministicRules'>
): boolean {
  return spec.deterministicRules.some((r) => r.action === 'flag_for_review');
}

export interface ScoringFeature {
  field: string;
  algorithm: FuzzyAlgorithm;
  weight: number;
}

export type FuzzyAlgorithm =
  | 'exact'
  | 'jaro_winkler'
  | 'edit_distance'
  | 'soundex'
  | 'numeric_distance'
  | 'date_proximity'
  | 'token_cosine';

// ---------------------------------------------------------------------------
// Scoring methods
// ---------------------------------------------------------------------------

/** Hand-tuned weighted average of per-field fuzzy similarities. */
export interface WeightedFeaturesScoring {
  method: 'weighted_features';
  features: ScoringFeature[];
}

/** Comparison operator for a Fellegi–Sunter level (`else` is the catch-all). */
export type FellegiSunterOp = FuzzyAlgorithm | 'else';

/**
 * One comparison level in the Fellegi–Sunter model, with its m/u probabilities
 * (precomputed / offline-trained for Phase 1A). `gte` is the similarity
 * threshold for fuzzy ops and is omitted for `exact` / `soundex` / `else`.
 */
export interface FellegiSunterLevel {
  op: FellegiSunterOp;
  gte?: number;
  m: number;
  u: number;
}

/** Ordered comparison levels for a single field (final level is `else`). */
export interface FellegiSunterComparison {
  field: string;
  levels: FellegiSunterLevel[];
}

/** Probabilistic record linkage: calibrated match probability from m/u weights. */
export interface FellegiSunterScoring {
  method: 'fellegi_sunter';
  /** Prior probability that two random records are a match (λ). */
  prior: number;
  comparisons: FellegiSunterComparison[];
}

export type ScoringConfig = WeightedFeaturesScoring | FellegiSunterScoring;

export interface ThresholdBands {
  /**
   * Score at/above which pairs auto-merge. `null` disables score-driven
   * auto-merge: only deterministic rules produce merge edges, and the
   * review band is unbounded above.
   */
  autoMerge: number | null;
  review: number;
  autoReject: number;
}

export interface ResolvedEntityIdPolicy {
  strategy: 'stable';
  newId: 'component_id';
  merge: 'oldest_entity_id';
  split: 'preserve_anchor';
}

export interface AgentPolicy {
  enabled: boolean;
  instructionsPath?: string;
  approvalPolicy?: 'always' | 'never' | 'on_failure';
  maxPairsPerRun?: number;
  maxCostUsd?: number;
  maxEmbeddingCostUsd?: number;
  batchSize?: number;
  tokenBudgetPerPair?: number;
  contextFields?: string[];
  confirmBeforeWrite?: boolean;
  legacyModel?: string;
  promptTemplate?: string;
  autoApplyThreshold?: number;
  agentConfidenceFloor?: number;
  /** Optional multi-model consensus reviewer. Absent ⇒ single-agent behavior. */
  panel?: ResolvedPanelPolicy;
  /** Optional external reviewer transport. Wins over `legacyModel`/`panel`. */
  reviewer?: ReviewerConfig;
  /**
   * User-facing judge tier for the review phase (cross-repo contract §5).
   * Absent ⇒ model (default) with today's precedence unchanged (external
   * reviewer still wins when present). `'model'` pins the in-Bobsled Core model judge
   * and ignores `reviewer` / `reviewerOverride`. `'agent'` requires an external
   * reviewer transport and skips (`no_judge_configured`) rather than falling
   * back to the model judge. A host-injected `llmClient` always wins. Selection
   * semantics live in `api/review-project.ts` (`selectJudge`).
   */
  judge?: 'model' | 'agent';
}

/**
 * External reviewer transport config (`agent_policy.reviewer`). Consumed by
 * `createExternalReviewerClient`; also injectable per run via
 * `reviewResolveProject`'s `reviewerOverride` (which wins over the spec).
 */
export interface ReviewerConfig {
  kind: 'http' | 'command';
  /** `kind: http` — endpoint receiving `entity_graph_review_request.v1`. */
  url?: string;
  /** `kind: http` — bearer token; env placeholder resolved at runtime. */
  authToken?: string;
  /** `kind: command` — local command fed the request JSON on stdin. */
  command?: string | string[];
  timeoutS?: number;
  /** `kind: http` — poll interval for async 202 job responses. */
  pollIntervalS?: number;
}

/** Resolved (camelCase) `entity_semantics` block from the resolution spec. */
export interface ResolvedEntitySemantics {
  definition?: string;
  categories?: Array<{ name: string; description: string }>;
  positiveExamples?: string[];
  negativeExamples?: string[];
}

export interface ResolvedDisplayName {
  field: string;
  sourcePrecedence?: string[];
}

export interface ResolvedProfileAttribute {
  field: string;
  alias: string;
  hashed?: boolean;
}

export interface ResolvedQualityFreshnessWindow {
  days: number;
  score: number;
}

export interface ResolvedQualityTrustWeights {
  identity: number;
  freshness: number;
  diversity: number;
  coverage: number;
}

export interface ResolvedQualityTrustTierThresholds {
  trusted: number;
  monitor: number;
  review: number;
}

export interface ResolvedQualityConfig {
  freshnessWindows: ResolvedQualityFreshnessWindow[];
  sourceDiversityCap: number;
  trustWeights: ResolvedQualityTrustWeights;
  trustTierThresholds: ResolvedQualityTrustTierThresholds;
}

export interface ResolvedActivationField {
  field: string;
  target: string;
}

export interface ResolvedActivationIdentityMap {
  sourceSystem: string;
  idAlias: string;
}

export interface ResolvedActivationProjection {
  name: string;
  version: string;
  trustGate: number;
  fields: ResolvedActivationField[];
  identityMap?: ResolvedActivationIdentityMap;
}

export type ProfileAttributeMasking = 'none' | 'hash' | 'partial' | 'null';

export interface ResolvedPiiControl {
  field: string;
  masking: ProfileAttributeMasking;
  classification?: string;
}

export interface ResolvedPiiControls {
  attributes: ResolvedPiiControl[];
}

export interface ResolvedViewsConfig {
  enabled: boolean;
  namePattern: string;
  includeEntityGraphMetadata?: boolean;
  /** @deprecated Use includeEntityGraphMetadata. */
  includeMdmMetadata?: boolean;
}

export interface ResolvedProfileConfig {
  displayName?: ResolvedDisplayName;
  attributes: ResolvedProfileAttribute[];
  quality: ResolvedQualityConfig;
  activations: ResolvedActivationProjection[];
  views?: ResolvedViewsConfig;
  piiControls?: ResolvedPiiControls;
}

// ---------------------------------------------------------------------------
// Pipeline stage result types
// ---------------------------------------------------------------------------

export interface SqlStatement {
  name: string;
  sql: string;
  tableCreated?: string;
  ignoreErrorPatterns?: string[];
  /**
   * Names of statements this one depends on. Executors skip a statement when
   * an upstream failed (transitively), so a sequential write chain never runs
   * against the partial state a mid-chain failure left behind.
   */
  deps?: string[];
}

export interface ResolutionCompileResult {
  ok: true;
  statements: SqlStatement[];
  entityName: string;
  tableNames: string[];
  warnings: string[];
  preamble?: string;
}

// ---------------------------------------------------------------------------
// Review types
// ---------------------------------------------------------------------------

export interface ReviewExportRow {
  pair_id: string;
  record_a_id: string;
  record_b_id: string;
  source_a: string;
  source_b: string;
  composite_score: number;
  threshold_band: AgentThresholdBand;
  blocking_rules: string;
  field_diffs: string;
  recommended_action: 'merge' | 'not_match';
  semantic_score?: number | null;
  semantic_decision?: 'promoted_merge' | 'promoted_reject' | 'kept_for_review' | null;
  /** Deterministic rule that produced this pair (NULL for scored pairs). */
  rule_name?: string | null;
  // `escalate` retained for backward compatibility with rows written before
  // the agent_confidence_floor split. Read paths (review export/list/show)
  // surface them as-is so reviewers can see legacy data; new writes never
  // emit `escalate`.
  decision?: 'merge' | 'not_match' | 'defer' | 'escalate' | null;
  confidence?: number | null;
  reviewer?: string | null;
  reason?: string | null;
  proposed_decision?: 'merge' | 'not_match' | 'defer' | 'escalate' | null;
  proposed_confidence?: number | null;
  confidence_gap?: number | null;
  decided_at?: string | null;
  decision_source?: string | null;
  decision_batch_id?: string | null;
  applied_at?: string | null;
}

export interface ReviewDecisionRow {
  pair_id: string;
  decision: 'merge' | 'not_match' | 'defer';
  // 'escalated' kept for backward compat with rows written before the
  // agent_confidence_floor split. New code does not emit it.
  status?: 'proposed' | 'applied' | 'deferred' | 'escalated' | 'superseded';
  reviewer?: string;
  reason?: string;
  confidence?: number;
  proposed_decision?: 'merge' | 'not_match' | 'defer';
  proposed_confidence?: number;
  decided_at?: string;
  decision_batch_id?: string;
  content_hash?: string;
  decision_source?: string;
  applied_at?: string;
  human_feedback_outcome?: HumanFeedbackOutcome | null;
  human_feedback_reason?: string | null;
  feedback_timestamp?: string | null;
}

export type HumanFeedbackOutcome = 'correct' | 'incorrect' | 'needs_revision';

// ---------------------------------------------------------------------------
// Agent review types
// ---------------------------------------------------------------------------

export interface PairContext {
  pairId: string;
  recordAId: string;
  recordBId: string;
  sourceA: string;
  sourceB: string;
  compositeScore: number;
  fields: Record<string, { a: string; b: string; score?: number }>;
}

export interface PairDecision {
  pairId: string;
  decision: 'merge' | 'not_match' | 'defer';
  confidence: number;
  reasoning: string;
}

export interface AgentReviewOptions {
  model?: string;
  batchSize: number;
  tokenBudgetPerPair?: number;
  promptTemplate?: string;
  contextFields?: string[];
  learningContext?: string;
}

export interface LlmClient {
  reviewPairs(pairs: PairContext[], options: AgentReviewOptions): Promise<PairDecision[]>;
}

// ---------------------------------------------------------------------------
// Agent panel (multi-model consensus reviewer) types
// ---------------------------------------------------------------------------

/** How the panel relates to the existing single-agent reviewer for the band. */
export type PanelMode = 'replace' | 'escalate';

/** How agreement is judged within one panel tier. */
export type PanelConsensus = 'unanimous' | 'majority';

/**
 * Resolved (camelCase) agent-panel config. A panel runs the review-band pairs
 * through a first panel of model-role judges; on disagreement it escalates to a
 * resolution panel that adjudicates the first panel's rationales; if still
 * unresolved the pair is deferred to a human.
 */
export interface ResolvedPanelPolicy {
  enabled: boolean;
  /** `replace` swaps the panel in for the single agent; `escalate` runs the
   *  single agent first and only sends its defer / low-confidence pairs here. */
  mode: PanelMode;
  /** Model role names (keys in `platform.models`) for the first panel. */
  firstPanel: string[];
  /** Model role names for the second-tier resolution panel. */
  resolutionPanel: string[];
  consensus: PanelConsensus;
  /** v1: only `defer` (unresolved pairs go to human review). */
  onUnresolved: 'defer';
  /** Confidence base for a first-panel agreement (scaled by agreement ratio). */
  unanimousConfidence: number;
  /** Confidence base for a resolution-panel agreement (scaled by ratio). */
  resolutionConfidence: number;
}

/** One judge's call on a single pair, carried in the decision trace. */
export interface PanelJudgeLabel {
  /** The model role name (`platform.models` key) that produced this label. */
  role: string;
  label: PairDecision['decision'];
  rationale: string;
  confidence?: number;
}

/** Per-pair two-tier panel trace, JSON-serialized into `PairDecision.reasoning`. */
export interface PanelTrace {
  pairId: string;
  firstPanel: PanelJudgeLabel[];
  firstPanelConsensus: 'unanimous' | 'majority' | 'split';
  /** Present only when the first panel disagreed and the resolution panel ran. */
  resolutionPanel?: PanelJudgeLabel[];
  resolutionConsensus?: 'unanimous' | 'majority' | 'split';
  outcome: PairDecision['decision'];
  resolvedAtTier: 'first' | 'resolution' | 'unresolved';
  /** Winning-tier agreement fraction; drives the derived confidence. */
  agreementRatio: number;
}

/** A single panel judge — a model role paired with its single-model client. */
export interface PanelJudge {
  role: string;
  client: LlmClient;
}

/** The two panels of judges, injected into the orchestrator. */
export interface PanelJudges {
  firstPanel: PanelJudge[];
  resolutionPanel: PanelJudge[];
}
