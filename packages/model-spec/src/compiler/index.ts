/**
 * YAML spec → SQL compiler.
 *
 * Public API for compiling source + transform specs into
 * warehouse DDL (CREATE VIEW statements).
 */

// --- Core API ---
export { generateSelectSql, generateSql, transpileExpr } from './codegen.js';
export { compileAll, trackEphemeralModel, validateAll } from './orchestrator.js';
export { generateTestSql } from './tests.js';
export { generateExpectationSql } from './expect/codegen.js';
export {
  dropStatementForMaterialization,
  materializeSql,
  generateUnprocessedRowsSql,
  generateProcessedKeyReplacementSql,
  generateStageReplacementDml,
  planSchemaChange,
  planTransition,
} from './materializer.js';
export type { ProcessedKeySqlOptions } from './materializer.js';
export { planConfigDrift } from './materializer-config-drift.js';
export type { CurrentRunConfigSnapshot } from './materializer-config-drift.js';
export { executeSqlStatements } from './executor.js';

// --- Model selection (dbt-style selector grammar) ---
// Re-exported from the root barrel for convenience; the canonical subpath is
// `@bobsled-inc/model-spec/selection` (kept in lockstep — same module).
export { parseSelector, resolveSelection } from '../selection.js';
export type { ParsedSelector, ResolveSelectionOptions, SelectableNode } from '../selection.js';

// --- DAG & Resolution ---
export {
  buildDag,
  buildDagFromDocuments,
  collectYamlFiles,
  computeEffectiveTiers,
  filterDagByIntegration,
  inferDagIntegrations,
  subgraph,
  withEphemeralAncestors,
} from './dag.js';
export type { ModelDocument } from './dag.js';
export {
  bucketColumnType,
  buildIndexedSourceRegistry,
  buildInMemorySourceEntryRegistry,
  buildModelRegistry,
  buildSourceRegistry,
  filterSourceEntryRegistry,
  filterSourceRegistry,
  getSourceEntry,
  normalizeSourceRef,
  parseTransformSpec,
  parseTransformSpecFromParsed,
  resolveRef,
  resolveSourceEntry,
} from './parser.js';
export { analyzeModelDependencies } from './model-dependency-analysis.js';

// --- State Management ---
export {
  computeChecksum,
  computeSelectState,
  diffSelectColumns,
  isFirstRun,
  loadState,
  normalizeIncrementalFilterForState,
  normalizeSelectColumns,
  normalizeUniqueKeyForState,
  saveState,
  stateKey,
} from './state.js';

// --- FileSystem Abstraction ---
export { nodeFs } from './node-fs.js';

// --- Expression DSL ---
export {
  parseExprField,
  tryParseExpr,
  emitExpr,
  walkExpr,
  mapExpr,
  FUNCTION_CATALOG,
  getExpressionFunctionManifest,
  EXPRESSION_REGISTRY_VERSION,
  buildExpressionFunctionManifest,
} from './expr/index.js';
export {
  MATCH_KEY_SECRET_RUNTIME_TOKEN,
  hasMatchKeySecretPlaceholder,
  emitSha256Expr,
  materializeMatchKeySecretPlaceholders,
  redactMatchKeySecret,
} from './expr/functions-cleaning.js';
export {
  USPS_DIRECTIONALS,
  USPS_SECONDARY_UNIT_DESIGNATORS,
  USPS_STREET_SUFFIXES,
} from './expr/address-normalization-data.js';

export { collectModelExpectations } from './expect/parser.js';
export type { ParsedModelExpectations } from './expect/parser.js';

// --- Column Lineage ---
export { extractColumnLineage } from './column-lineage.js';

// --- Output ---
export { renderLineage } from './lineage.js';
export { buildFqName, buildFqNameWithDatabase } from './dialect.js';
export type { SqlDryRunner, SqlQueryRow, SqlQueryRunner, SqlRunnerModule } from './runner.js';

// --- Low-level Utilities (exported for advanced use — prefer higher-level APIs) ---
export {
  CANONICAL_DIALECTS,
  SUPPORTED_DIALECTS,
  caseName,
  createOrReplaceTableAs,
  createSchemaIfNotExistsStatement,
  getCanonicalDialect,
  getSelectStarModifier,
  isReservedWord,
  isSupportedDialect,
  quoteIdentifier,
  quoteLiteral,
  resolveDialectProfile,
  supportsDialectCapability,
  supportsFuzzyAlgorithm,
  unsupportedDialectFeatureError,
} from './dialect.js';

// --- SQL → Model Spec YAML generator ---
export { generateModelSpecFromSql, ModelSpecGenerationError } from '../generator/index.js';
export type {
  ModelSpecGenerationOptions,
  ModelSpecGenerationResult,
  ModelSpecGenerationErrorCode,
  ModelSpecSqlDialect,
} from '../generator/index.js';

// --- Schemas ---
export {
  isDangerousRawSql,
  getPublishTarget,
  getPublishTargetDatabase,
  getPublishTargetSchema,
  getExecutionEngine,
  MaterializationTypeSchema,
  OnSchemaChangeSchema,
  ApiResourceSourceSchema,
  ExpectSpecSchema,
  RefreshStrategySchema,
  ResolutionSpecSchema,
  SemanticRoleSchema,
  SeedSpecSchema,
  SourceSpecSchema,
  TransformSpecSchema,
  TrustConfigSchema,
  TrustTierSchema,
  WarehouseTableSourceSchema,
} from './schemas.js';

// Per-reference read mode (`live`/`lazy`) for a mixed model's warehouse leaf.
// Authoring metadata carried on transform refs; ignored by compilation.
export { ReadModeSchema } from './read-mode.js';
export type { ReadMode } from './read-mode.js';

// --- Seed / CSV Utilities ---
export { readCsv } from './seed/csv-reader.js';

// --- Types ---
export type {
  CanonicalDialect,
  DialectCapabilities,
  DialectCapability,
  DialectFqnStyle,
  DialectIdentifierStyle,
  DialectProfile,
  FuzzyAlgorithmCapability,
  SupportedDialect,
} from './dialect.js';
export type {
  CompileResult,
  ApiResourceSourceSpec,
  DataTest,
  DedupeSpec,
  DerivedColumn,
  ExpectSpec,
  MaterializationType,
  OnSchemaChange,
  PublishConfig,
  RefreshStrategy,
  ResolutionSpec,
  SeedSpec,
  SemanticRole,
  SourceDestinationOverride,
  SourceMode,
  SourceSpec,
  TransformSpec,
  TrustConfig,
  TrustTier,
  WarehouseTableSourceSpec,
} from './schemas.js';
export type { TestResult, TestSpec } from './tests.js';
export type { ExpectSqlInput, ExpectSqlStatement } from './expect/codegen.js';
export type {
  SqlRunner,
  SqlStatement,
  ModelExecutionResult,
  ExecuteCallbacks,
  ExecuteOptions,
  ModelGuardFailure,
} from './executor.js';

// Cancellation surface, re-exported so consumers of the Model Spec execution API can
// detect a cancelled run without also depending on `@bobsled-inc/connections`.
export { SqlCancelledError, isCancellationError } from '@bobsled-inc/connections';
export type { DagNode, DagResult } from './dag.js';
export type {
  ModelRegistry,
  ResolvedColumn,
  ResolvedFlattenJson,
  ResolvedJoin,
  ResolvedPivot,
  ResolvedUnpivot,
  ResolvedTransformSpec,
  ResolvedUnionBranch,
  SetOperation,
  SourceColumnRegistry,
  SourceEntryColumn,
  SourceEntryColumnType,
  SourceEntryRegistry,
  SourceRegistry,
  SourceRegistryEntry,
} from './parser.js';
export type {
  AnalyzeModelDependenciesOptions,
  AnalyzeModelDependenciesResult,
  ModelDependencyAnalysis,
  ModelDependencyClosure,
  ModelExecutionMode,
} from './model-dependency-analysis.js';
export type {
  RunState,
  ModelRunState,
  SelectColumnDiff,
  SelectColumnInput,
  SelectSignatureResult,
  SelectStateColumn,
} from './state.js';
export type { FileSystem } from './types.js';
export type { WindowExpr } from './expr/types.js';
export type {
  BobsledExpr,
  BobsledExprKind,
  FunctionCallExpr,
  ColumnRefExpr,
  RawSqlExpr,
  TypeRef,
  CaseWhen,
} from './expr/index.js';
export type {
  ExpressionFunctionManifest,
  ExpressionFunctionManifestEntry,
  FunctionDef,
  FunctionCategory,
  FunctionSignature,
  ParseResult,
} from './expr/index.js';
export type { CompileAllOptions, ValidateAllOptions, ValidateModelResult } from './orchestrator.js';
export type {
  ColumnLineageEntry,
  ColumnLineageOptions,
  ColumnLineageUpstream,
  SourceColumnState,
} from './column-lineage.js';

// --- Metadata entities ---
export {
  EntityRelationshipSpecSchema,
  EntityRelationshipJoinColumnPairSchema,
  EntityRelationshipScoringAlgorithmSchema,
  EntityRelationshipConfidenceFeatureSchema,
  EntityRelationshipConfidenceScoringSchema,
  EntityRelationshipTemporalSchema,
  EntityRelationshipReviewThresholdsSchema,
  EntityRelationshipReviewSchema,
  MentionExtractionCandidateRetrievalSchema,
  MentionExtractionSurfaceFiltersSchema,
  MentionExtractionSpecSchema,
  OntologyRelationTypeSchema,
  RelationshipDirectionSchema,
  RelationshipExtractionCandidatePairRulesSchema,
  RelationshipExtractionChunkFilterSchema,
  RelationshipExtractionModelConfigSchema,
  RelationshipExtractionReviewSchema,
  RelationshipExtractionSpecSchema,
  RelationshipOntologyRelationSchema,
  RelationshipOntologySpecSchema,
  RelationshipSemanticsSchema,
  RelationshipTemporalKindSchema,
  JoinTypeSchema,
  RelationshipTypeSchema,
} from '../entities/index.js';
export type {
  EntityRelationshipSpec,
  EntityRelationshipJoinColumnPair,
  EntityRelationshipScoringAlgorithm,
  EntityRelationshipConfidenceFeature,
  EntityRelationshipConfidenceScoring,
  EntityRelationshipTemporal,
  EntityRelationshipReviewThresholds,
  EntityRelationshipReview,
  MentionExtractionCandidateRetrieval,
  MentionExtractionSurfaceFilters,
  MentionExtractionSpec,
  OntologyRelationType,
  RelationshipDirection,
  RelationshipExtractionCandidatePairRules,
  RelationshipExtractionChunkFilter,
  RelationshipExtractionModelConfig,
  RelationshipExtractionReview,
  RelationshipExtractionSpec,
  RelationshipOntologyRelation,
  RelationshipOntologySpec,
  RelationshipSemantics,
  RelationshipTemporalKind,
  JoinType,
  RelationshipType,
} from '../entities/index.js';
