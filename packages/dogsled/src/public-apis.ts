/**
 * Stable root library entry point for `@bobsled-inc/dogsled`.
 *
 * The package root intentionally exposes configuration and runner metadata,
 * while execution-heavy APIs retain explicit subpaths such as `/pipeline`,
 * `/actions`, `/sync`, and `/mcp`.
 */
export {
  DogsledConfigSchema,
  PipelineRunnerSchema,
  isExtractPipelineConfig,
  isModelsPipelineConfig,
  isEntityGraphPipelineConfig,
  isManualSchedule,
  pipelineTrigger,
  pipelineTriggerFor,
  MANUAL_SCHEDULE,
  type DogsledConfig,
  type ModelsPipelineConfig,
  type EntityGraphPipelineConfig,
  type EntityGraphPhase,
  type ChunkSource,
  type ExtractPipelineConfig,
  type PipelineConfig,
  type PipelineTrigger,
  type PipelineRunner,
} from './runner/config/schema.js';

export {
  loadDogsledConfig,
  findDogsledConfig,
  findDogsledProject,
  resolveDogsledProject,
  resolvePipelines,
  resolveModelPipelines,
  resolveEntityGraphPipelines,
  resolveAllModelPipelines,
  resolveAllModelPipelinesFromModels,
  expandAuthoredModelPipelines,
  computeSyntheticModelPipelines,
  syntheticModelPipelineNameForConnection,
  isOrphanEligibleMaterialization,
  discoverModels,
  type DiscoveredModel,
  type ExpandedModelPipeline,
  type ModelNode,
  type ResolvedPipeline,
  type ResolvedResource,
  type ResolvedModelPipeline,
  type ResolvedEntityGraphPipeline,
  type DogsledProjectLocation,
} from './runner/config/loader.js';

export {
  RUNNER_CATALOG,
  getRunnerCapabilities,
  listRunnerCapabilities,
  type RunnerCapabilities,
} from './runner/config/runner-catalog.js';
