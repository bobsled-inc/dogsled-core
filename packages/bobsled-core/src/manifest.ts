/**
 * Public library entry point for Dogsled's pipeline manifest generator.
 *
 * Imported as `@bobsled-inc/bobsled-core/manifest`. Consumers use this surface
 * so persisted manifests and runtime execution stay aligned with Dogsled.
 *
 * Two project-input shapes are supported (see `GenerateManifestProjectInput`):
 *   - `{ config, projectRoot }` — read Model Spec model metadata from disk.
 *   - `{ config, models }`     — caller supplies the Model Spec model registry.
 *
 * The `bobsled.yml` parser + schema (`loadBobsledConfig`, `BobsledConfigSchema`) is
 * also exported so callers can validate before generating.
 */

export {
  generateManifest,
  generateProjectManifest,
  type GenerateManifestOptions,
  type GenerateManifestProjectInput,
  type GenerateProjectManifestOptions,
  type DiscoveredModel,
  type ExpandedModelPipeline,
  type ModelNode,
  discoverModels,
} from './runner/pipeline-manifest/generate.js';

export {
  buildPipelineManifest,
  buildPipelineManifestObject,
  serializePipelineManifest,
  PIPELINE_MANIFEST_PATH,
  PIPELINE_MANIFEST_VERSION,
  PIPELINE_MANIFEST_COMPAT_VERSIONS,
  MANUAL_SCHEDULE_SENTINEL,
  type BobsledPipelineManifest,
  type PipelineManifestVersion,
  type BobsledPipelineEntry,
  type ExtractPipelineManifest,
  type ModelPipelineManifest,
  type ModelDagNode,
  type EntityGraphPipelineManifest,
  type EntityGraphNode,
  type ReverseEtlPipelineManifest,
  type EntityGraphPhase as ManifestEntityGraphPhase,
  type PipelineTemplateInput,
  type PipelineResourceMetadata,
  type PipelineResourceLoadMetadata,
  type PipelineSchemaBehavior,
  type ModelPipelineTemplateInput,
  type EntityGraphPipelineTemplateInput,
  type ReverseEtlPipelineTemplateInput,
  type PipelineTrigger as ManifestPipelineTrigger,
  type PipelineCommandContract,
} from './runner/pipeline-manifest/template.js';

export {
  PipelineManifestValidationError,
  parsePipelineManifest,
  safeParsePipelineManifest,
  PipelineManifestSchema,
  type PipelineManifestValidationIssue,
  type PipelineManifestValidationIssueCode,
  type SafeParsePipelineManifestResult,
  type ValidatedBobsledPipelineManifest,
  type ValidatedBobsledPipelineManifestV7,
} from './runner/pipeline-manifest/manifest-schema.js';

export {
  loadBobsledConfig,
  validateBobsledConfig,
  findBobsledConfig,
  findBobsledProject,
  resolveBobsledProject,
  resolveModelPipelines,
  resolveEntityGraphPipelines,
  resolveAllModelPipelines,
  resolveAllModelPipelinesFromModels,
  expandAuthoredModelPipelines,
  computeSyntheticModelPipelines,
  syntheticModelPipelineNameForConnection,
  isOrphanEligibleMaterialization,
  type ResolvedPipeline,
  type ResolvedResource,
  type ResolvedModelPipeline,
  type ResolvedEntityGraphPipeline,
  type BobsledProjectLocation,
  type ValidationResult,
} from './runner/config/loader.js';

export type { ValidationCatalog } from './validation.js';

export {
  BobsledConfigSchema,
  isExtractPipelineConfig,
  isModelsPipelineConfig,
  isEntityGraphPipelineConfig,
  isManualSchedule,
  pipelineTrigger,
  pipelineTriggerFor,
  MANUAL_SCHEDULE,
  PipelineRunnerSchema,
  type BobsledConfig,
  type ModelsPipelineConfig,
  type EntityGraphPipelineConfig,
  type EntityGraphPhase,
  type ChunkSource,
  type ExtractPipelineConfig,
  type InputMatrix,
  type PipelineConfig,
  type PipelineTrigger,
  type PipelineRunner,
} from './runner/config/schema.js';

export {
  RUNNER_CATALOG,
  getRunnerCapabilities,
  listRunnerCapabilities,
  type RunnerCapabilities,
} from './runner/config/runner-catalog.js';

export {
  loadProjectPipelineConfig,
  type LoadProjectPipelineConfigOptions,
  type LoadedProjectPipelineConfig,
  resolveProjectPipelines,
  validateProjectPipelines,
  BobsledProjectValidationError,
  type ResolveProjectPipelinesOptions,
  type ResolvedProjectPipelines,
  type ProjectPipelineValidationResult,
  type StructuredProjectPipelineIssue,
} from './runner/config/project-resolver.js';
