/**
 * Programmatic API for `@bobsled-inc/model-spec`.
 *
 * Three layers composed on top of the Layer 1 primitives exported from the
 * package root:
 *
 *   - Layer 2 (loaders): `loadProject` reads a Model Spec project directory into a
 *     typed `LoadedProject` without compiling or executing.
 *   - Layer 3 (orchestrators): `compileProject`, `runProject`,
 *     `validateProject`, `testProject`, `lineageProject`, seed helpers —
 *     one function per CLI verb, returning structured results.
 *   - File-less variant: `compileInMemory` for hosts whose models and sources
 *     live outside the filesystem (e.g. database-backed YAML).
 *
 * Layer 1 primitives (compileAll, buildModelRegistry, TransformSpecSchema,
 * etc.) stay at the root export and are unchanged by this module — see
 * `packages/model-spec/docs/programmatic-api.md` for the compatibility
 * contract.
 */

// ---------------------------------------------------------------------------
// Project config (model-spec.yml)
// ---------------------------------------------------------------------------
export {
  CONFIG_FILE_NAME,
  DEFAULT_RESOLVED_DIALECT,
  DEFAULT_RESOLVED_SCHEMA,
  ProjectConfigSchema,
  CheckpointStoreConfigSchema,
  type CheckpointStoreConfig,
  loadProjectConfig,
  parseProjectConfig,
  resolveConfig,
  type LoadProjectConfigOptions,
  type ProjectConfig,
  type ResolvedProjectConfig,
} from '../config.js';

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export {
  buildSecretResolver,
  listIntegrationHandles,
  loadAllIntegrations,
  pickIntegrationsByHandle,
  resolveActiveIntegration,
  resolveIndexedIntegrationByHandle,
  resolveIndexedIntegrations,
  resolveIntegrationByHandle,
  selectActiveIntegration,
  validateSourceIntegrationRefs,
  type ResolvedIntegration,
} from '../integrations.js';

// ---------------------------------------------------------------------------
// Compile context builders (shared across orchestrators)
// ---------------------------------------------------------------------------
export {
  buildCompileContext,
  buildMultiCompileContext,
  type CompileContext,
  type MultiCompileContext,
  type CommandContext,
  type GlobalFlags,
  type ResolvedConfig,
} from '../commands/common.js';
export {
  buildIntegrationContext,
  validateSchema,
  type DagContext,
  type IntegrationCompileContext,
} from './integration-context.js';

// ---------------------------------------------------------------------------
// Metadata entities (metrics / relationships / VQs)
// ---------------------------------------------------------------------------
export {
  MetricSpecSchema,
  EntityRelationshipSpecSchema,
  RelationshipSpecSchema,
  VqSpecSchema,
  effectiveSynonyms,
  extractVqSqlTokens,
  mergeSynonyms,
  loadEntityRelationshipsDirectory,
  loadIndexedMetadataRegistry,
  loadMetadataRegistry,
  loadMetricsDirectory,
  loadRelationshipsDirectory,
  loadVqsDirectory,
  validateMetadataReferences,
  type MetadataRegistry,
  type MetadataValidationContext,
  type MetricSpec,
  type EntityRelationshipSpec,
  type RelationshipSpec,
  type VqParameter,
  type VqSpec,
  type VqSqlToken,
} from '../entities/index.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export { CommandError, DogsledRuntimeError } from '../errors.js';

// Publish/execution accessors — re-exported so orchestrators (e.g. the Dogsled
// live-source bridge) can reproduce the publisher's "is this model published?"
// decision without re-deriving it and drifting from `runProject`.
export { getExecutionEngine, getPublishTarget } from '../compiler/index.js';

// ---------------------------------------------------------------------------
// Layer 2 — project loader
// ---------------------------------------------------------------------------
export {
  loadProject,
  selectIntegrationContexts,
  type LoadedProject,
  type LoadProjectOptions,
  type SelectIntegrationsOptions,
} from './load-project.js';

// ---------------------------------------------------------------------------
// Layer 3 — orchestrators (one per CLI verb)
// ---------------------------------------------------------------------------
export {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult,
  type CompileProjectIntegrationResult,
} from './compile-project.js';
export {
  runProject,
  type CrossWarehousePublishContext,
  type CrossWarehousePublishResult,
  type PlannedPublishedModel,
  type RunProjectOptions,
  type RunProjectResult,
  type RunProjectIntegrationResult,
} from './run-project.js';
export {
  validateProject,
  type ValidateProjectOptions,
  type ValidateProjectResult,
  type ValidateProjectIntegrationResult,
} from './validate-project.js';
export {
  collectPhysicalFqnCollisions,
  formatFqnCollisionError,
  normalizePhysicalFqn,
  PHYSICAL_FQN_COLLISION_ERROR_CODE,
  type PhysicalFqnCollision,
  type PhysicalFqnCollisionModel,
} from './validate-physical-fqn.js';
export {
  testProject,
  type TestProjectOptions,
  type TestProjectResult,
  type TestProjectIntegrationResult,
  type TestSqlEntry,
} from './test-project.js';
export {
  lineageProject,
  type LineageProjectOptions,
  type LineageProjectResult,
  type LineageProjectIntegrationResult,
} from './lineage-project.js';
export {
  expectProject,
  type ExpectProjectOptions,
  type ExpectProjectResult,
  type ExpectRunEntry,
} from './expect-project.js';
export {
  compileInMemory,
  type CompileInMemoryOptions,
  type CompileInMemoryResult,
  type InMemoryModel,
} from './compile-in-memory.js';
export {
  analyzeDeployedModelProject,
  planDeployedModelExecution,
  type AnalyzeDeployedModelProjectOptions,
  type DeployedModelAnalysis,
  type DeployedModelExecutionClosure,
  type DeployedModelExecutionMode,
  type DeployedModelExecutionPlan,
  type DeployedModelSourceBinding,
  type PlanDeployedModelExecutionOptions,
} from './deployed-model-plan.js';
export {
  dryRunProject,
  dryRunInMemory,
  wrapDryRunSql,
  type DryRunMode,
  type DryRunModelResult,
  type DryRunProjectOptions,
  type DryRunProjectResult,
  type DryRunProjectIntegrationResult,
  type DryRunInMemoryOptions,
  type DryRunInMemoryResult,
} from './dry-run-project.js';
export {
  diffSeeds,
  loadSeeds,
  validateSeeds,
  type DiffSeedsOptions,
  type DiffSeedsResult,
  type LoadSeedsOptions,
  type LoadSeedsResult,
  type SeedDiffEntry,
  type SeedDiffResultEntry,
  type SeedLoadEntry,
  type SeedValidationEntry,
  type ValidateSeedsOptions,
  type ValidateSeedsResult,
} from './seed-project.js';
export {
  discoverProjectSeeds,
  type DiscoverProjectSeedsOptions,
  type DiscoveredBareSeedCsv,
  type DiscoveredProjectSeeds,
} from './project-seeds.js';

// ---------------------------------------------------------------------------
// Re-exports of Layer 1 types commonly needed when consuming orchestrator
// results. These remain canonically exported from the package root; duplicating
// here lets hosts import everything they need from `@bobsled-inc/model-spec/project`
// without also reaching into the root for type aliases.
// ---------------------------------------------------------------------------
export type {
  CompileResult,
  DagNode,
  MaterializationType,
  ModelExecutionResult,
  ModelRegistry,
  DedupeSpec,
  RunState,
  SourceColumnRegistry,
  SourceRegistry,
  SupportedDialect,
  TransformSpec,
} from '../compiler/index.js';

// Ossie authoring support; the compiler continues to consume native Dogsled types.
export {
  expandOssieIndex,
  getOssieOrigins,
  translateOssieDocument,
  validateOssieDocument,
  OSSIE_VERSION,
  OSSIE_SCHEMA_REVISION,
} from '../ossie/index.js';
