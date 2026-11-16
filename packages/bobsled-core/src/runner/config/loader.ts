import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  entryFilePath,
  ProjectIndexError,
  entriesOfKind,
  scanProject,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import { CommandError, parseEnvPlaceholder, type SchemaBehavior } from '@bobsled-inc/protocol';
import { LineCounter, parse as parseYaml, YAMLError } from 'yaml';

export interface BobsledProjectLocation {
  /** Absolute Project root. */
  projectRoot: string;
  /** Absolute paths of the Project's pipeline configuration fragments. */
  configPaths: readonly string[];
  /** Project index scanned to find a moved configuration, for reuse. */
  index?: ProjectIndex;
}

import { BUILT_IN_VALIDATION_CATALOG } from '../../validation.js';
import type {
  IntegrationsLib,
  ValidationCatalog,
  ValidationCatalogResourceSpec,
} from '../../validation.js';

import { parseToCron } from '../schedule/parser.js';
import { legacyBlueprintWarnings, normalizePipelineBlueprint } from './legacy-blueprint.js';
import { declareHostConfigEnvironment, parseHostDeclaredEnvNames } from './host-environment.js';
import type { LoadProjectPipelineConfigOptions } from './project-resolver.js';
import { validateDatabricksDestinationAuth } from './destination-auth.js';
import { normalizeDestinationNames, normalizeResources } from './resource-normalization.js';
import {
  isEntityGraphPipelineConfig,
  isExtractPipelineConfig,
  isModelsPipelineConfig,
  pipelineTriggerFor,
  BobsledConfigSchema,
} from './schema.js';
import type {
  ChunkSource,
  DestinationConfig,
  EmbedConfig,
  EntityGraphPhase,
  InputMatrix,
  PipelineInputValue,
  PipelineRunner,
  PipelineTrigger,
  BobsledConfig,
} from './schema.js';
import {
  discoverModels,
  discoverProjectModels,
  isOrphanEligibleMaterialization,
  validateModelPipelineMembership,
  type DiscoveredModel,
  type ModelNode,
} from './model-discovery.js';
import {
  openBobsledProject,
  projectFileIssues,
  projectResourceIssues,
  type BobsledProject,
} from './project-files.js';
import { resolveEntityVariant } from './resolve-entity.js';
import { validateForEachIteration } from './resolve-for-each.js';
import { validateResourceResolution, validateResourceSourceAlignment } from './resolve-resource.js';
import { validateViaSelections } from './validate-via.js';
import {
  validateResourceInputMatrices,
  validateResourceInputOverrides,
} from './validate-resource-inputs.js';
import { validateUniqueResolvedResources } from './validate-resource-selection.js';
import { validateSourcePresence } from './validate-source.js';
import {
  validateModelWarehouseSelections,
  validateWarehouseSelections,
} from './validate-warehouse.js';

// Re-export the model-discovery surface for public configuration consumers and
// runner tests.
export { discoverModels, isOrphanEligibleMaterialization, type DiscoveredModel, type ModelNode };
export type { IntegrationsLib, ValidationCatalog } from '../../validation.js';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const CONFIG_NAMES = ['bobsled.yml', 'bobsled.yaml'];
export const INTEGRATIONS_LOAD_WARNING =
  'Could not load @bobsled-inc/integrations — skipping integration validation';

export interface ResolvedResource {
  /**
   * Resolved resource spec name as consumed by the extractor (e.g.
   * `issues_mcp`). For entity-name references in `bobsled.yml` (e.g.
   * `resources: [issues] + via: mcp`), `resolveEntityVariant` rewrites this to
   * the matched variant's spec name and preserves the original token on
   * `requestedName`. Strict-name references leave `requestedName` unset.
   */
  name: string;
  /**
   * The original token authored in `bobsled.yml` when entity resolution rewrote
   * `name`. Preserved so error messages and observability can echo back what
   * the user wrote (e.g. `Pipeline "..." uses per-resource overrides on
   * [issues]`) instead of the variant-specific spec name.
   */
  requestedName?: string;
  override?: {
    loadStrategy?: 'append' | 'merge' | 'full_refresh';
    schemaBehavior?: SchemaBehavior;
    table?: string;
    tableOwnershipMarker?: string;
    inputs?: Record<string, PipelineInputValue>;
    inputMatrix?: InputMatrix;
    via?: string;
    /**
     * Per-resource warehouse selector — carried only so cross-validation can
     * REJECT it. Per-resource (and per-model) warehouse selection is not
     * supported yet; selection is pipeline-grained only.
     */
    warehouse?: string;
  };
  /**
   * Optional sibling resource iterated through `extract.for_each`. The
   * manifest compiler uses this to keep the parent and child in one process.
   */
  forEachParent?: string;
}

export interface ResolvedPipeline {
  name: string;
  description?: string;
  schedule: string;
  /**
   * POSIX cron expression for the resolved `schedule`, or `null` when the
   * pipeline opts out of automatic firing via `schedule: manual`. Consumers
   * that walk this field for workflow / cron generation must branch on
   * `trigger` (or null-check `cron`) before using the value.
   */
  cron: string | null;
  trigger: PipelineTrigger;
  source: string;
  destinationNames: string[];
  resources: ResolvedResource[];
  tablePrefix: string;
  enabled: boolean;
  runner: PipelineRunner;
  /**
   * Transport id override for this pipeline. When set, becomes the effective
   * `default_transport` for the source integration during the pipeline run.
   * Validation in {@link validateBobsledConfig} guarantees this references a
   * transport id declared on the source integration; runtime plumbing in
   * `packages/bobsled-core/src/commands/pipeline.ts` forwards it to the extractor
   * subprocess as `--default-via <id>`.
   */
  via?: string;
  /**
   * Pipeline-level Snowflake warehouse selector. References one of the source
   * connection's declared `warehouses` by stable ID. Validated by
   * {@link validateWarehouseSelections}; runtime plumbing forwards the
   * resolved warehouse to the Snowflake session via the runner context.
   */
  warehouse?: string;
  /** Managed destination warehouse ID preserved for the execution host. */
  destinationWarehouse?: string;
  inputs?: Record<string, PipelineInputValue>;
  loadStrategy?: 'append' | 'merge' | 'full_refresh';
  schemaBehavior?: SchemaBehavior;
  /** Records buffered per load file before the loader flushes/converts a chunk. */
  bufferSize?: number;
  embed?: EmbedConfig;
}

export interface SecretRequirement {
  integration: string;
  envVar: string;
  description: string;
  docsUrl?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: string[];
  secrets: SecretRequirement[];
  pipelines: ResolvedPipeline[];
  modelPipelines: ResolvedModelPipeline[];
  entityGraphPipelines: ResolvedEntityGraphPipeline[];
}

/**
 * Locate the Bobsled Core project for `startDir`: the nearest directory at or above
 * it that holds a root `bobsled.yml`/`bobsled.yaml`, or else `startDir` itself when
 * it contains Bobsled Core Project files. Pipeline configuration is optional.
 */
export function findBobsledProject(startDir?: string): BobsledProjectLocation | null {
  const start = path.resolve(startDir ?? process.cwd());
  let dir = start;
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        const index = scanProject(dir);
        return {
          projectRoot: dir,
          configPaths: entriesOfKind(index, 'pipeline_config').map((entry) =>
            entryFilePath(index, entry)
          ),
          index,
        };
      }
    }
    dir = path.dirname(dir);
  }

  let index: ProjectIndex;
  try {
    index = scanProject(start);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  const entries = entriesOfKind(index, 'pipeline_config');
  return index.entries.length > 0
    ? {
        projectRoot: start,
        configPaths: entries.map((entry) => entryFilePath(index, entry)),
        index,
      }
    : null;
}

export function findBobsledConfig(startDir?: string): string | null {
  return findBobsledProject(startDir)?.configPaths[0] ?? null;
}

function declaresPipelineConfig(configPath: string): boolean {
  try {
    const parsed = parseYaml(fs.readFileSync(configPath, 'utf-8')) as { type?: unknown } | null;
    return parsed?.type === 'pipeline_config';
  } catch {
    return false;
  }
}

/**
 * The project an explicit pipeline configuration belongs to: the file's
 * directory, unless a typed fragment lives inside the caller's working
 * directory. In that case the working directory is the Project root, even
 * when the fragment is named `bobsled.yml` or `bobsled.yaml`.
 */
export function bobsledProjectForConfig(
  explicitConfigPath: string,
  cwd: string = process.cwd()
): BobsledProjectLocation {
  const configPath = path.resolve(cwd, explicitConfigPath);
  const configDir = path.dirname(configPath);
  const workingDir = path.resolve(cwd);
  const relative = path.relative(workingDir, configPath);
  const insideWorkingDir = !relative.startsWith('..') && !path.isAbsolute(relative);
  if (configDir !== workingDir && insideWorkingDir && declaresPipelineConfig(configPath)) {
    return { projectRoot: workingDir, configPaths: [configPath] };
  }
  return { projectRoot: configDir, configPaths: [configPath] };
}

/**
 * The project a CLI command works on: the project of an explicit `--config`
 * path (see `bobsledProjectForConfig`), or else the project discovered from the
 * working directory.
 */
export function resolveBobsledProject(
  explicitConfigPath?: string,
  cwd: string = process.cwd()
): BobsledProjectLocation | null {
  return explicitConfigPath
    ? bobsledProjectForConfig(explicitConfigPath, cwd)
    : findBobsledProject(cwd);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse one pipeline config file. `declaredEnvNames` and `hostManagedModelAuth`
 * have the same names-only, off-by-default meaning as in
 * `loadProjectPipelineConfig`.
 */
export function loadBobsledConfig(
  configPath: string,
  options: Pick<LoadProjectPipelineConfigOptions, 'declaredEnvNames' | 'hostManagedModelAuth'> = {}
): BobsledConfig {
  const declaredEnvNames = parseHostDeclaredEnvNames(options.declaredEnvNames);
  if (!fs.existsSync(configPath)) {
    throw new CommandError(`Config file not found: ${configPath}`, 2);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  const lineCounter = new LineCounter();
  try {
    parsed = parseYaml(raw, { uniqueKeys: true, prettyErrors: false, lineCounter });
  } catch (e) {
    const position = e instanceof YAMLError ? e.pos[0] : -1;
    const location = position < 0 ? undefined : lineCounter.linePos(position);
    const reason =
      e instanceof Error ? e.message.replace(/ at line \d+, column \d+$/u, '') : String(e);
    const suffix = location ? ` at line ${location.line}, column ${location.col}` : '';
    throw new CommandError(`Invalid YAML in ${configPath}: ${reason}${suffix}`, 2);
  }

  const normalized = normalizePipelineBlueprint(parsed, configPath);
  const result = BobsledConfigSchema.safeParse(
    normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
      ? declareHostConfigEnvironment(
          normalized as Record<string, unknown>,
          declaredEnvNames,
          options.hostManagedModelAuth === true
        )
      : normalized
  );
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new CommandError(`Invalid bobsled.yml:\n${issues}`, 2);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Pipeline resolution
// ---------------------------------------------------------------------------

export function filterPipelinesByRunner(
  pipelines: ResolvedPipeline[],
  runner: PipelineRunner
): ResolvedPipeline[] {
  return pipelines.filter((pipeline) => pipeline.runner === runner);
}

export function resolvePipelines(config: BobsledConfig): ResolvedPipeline[] {
  const pipelines: ResolvedPipeline[] = [];

  for (const [name, entry] of Object.entries(config.pipelines)) {
    if (!isExtractPipelineConfig(entry)) continue;
    const trigger = pipelineTriggerFor(entry.schedule);
    pipelines.push({
      name,
      description: entry.description,
      schedule: entry.schedule,
      cron: trigger === 'manual' ? null : parseToCron(entry.schedule),
      trigger,
      source: entry.source,
      destinationNames: normalizeDestinationNames(entry),
      resources: normalizeResources(entry.resources),
      tablePrefix: entry.table_prefix ?? `${name}__`,
      enabled: entry.enabled ?? true,
      runner: entry.runner ?? 'managed',
      via: entry.via,
      warehouse: entry.warehouse,
      destinationWarehouse: entry.destination_warehouse,
      inputs: entry.inputs,
      loadStrategy: entry.load_strategy,
      schemaBehavior: entry.schema_behavior,
      bufferSize: entry.buffer_size,
      embed: entry.embed,
    });
  }

  return pipelines;
}

export interface ResolvedModelPipeline {
  name: string;
  description?: string;
  schedule: string;
  /**
   * POSIX cron expression for the resolved `schedule`, or `null` when the
   * pipeline opts out of automatic firing via `schedule: manual`.
   */
  cron: string | null;
  trigger: PipelineTrigger;
  connection: string;
  models: '*' | string[];
  enabled: boolean;
  /**
   * Pipeline-level Snowflake warehouse selector. References one of the
   * `connection`'s declared `warehouses` by stable ID. Validated by
   * {@link validateModelWarehouseSelections}; runtime plumbing forwards the
   * resolved warehouse to the Snowflake session via the runner context.
   *
   * v5 manifests preserve this as execution metadata for a programmatic host.
   */
  warehouse?: string;
}

export function resolveModelPipelines(config: BobsledConfig): ResolvedModelPipeline[] {
  const result: ResolvedModelPipeline[] = [];
  for (const [name, entry] of Object.entries(config.pipelines)) {
    if (!isModelsPipelineConfig(entry)) continue;
    const trigger = pipelineTriggerFor(entry.schedule);
    result.push({
      name,
      description: entry.description,
      schedule: entry.schedule,
      cron: trigger === 'manual' ? null : parseToCron(entry.schedule),
      trigger,
      connection: entry.connection,
      models: entry.models,
      enabled: entry.enabled ?? true,
      warehouse: entry.warehouse,
    });
  }
  return result;
}

/**
 * Resolved shape for a `type: entity-graph` pipeline — mirrors
 * `ResolvedModelPipeline` but carries entity selectors and the phase list
 * instead of model selectors. Wildcard `entities: '*'` is preserved here;
 * downstream consumers decide when to expand it against the project's
 * resolution specs.
 */
export interface ResolvedEntityGraphPipeline {
  name: string;
  description?: string;
  schedule: string;
  /**
   * POSIX cron expression for the resolved `schedule`, or `null` when the
   * pipeline opts out of automatic firing via `schedule: manual`.
   */
  cron: string | null;
  trigger: PipelineTrigger;
  connection: string;
  entities: '*' | string[];
  phases: EntityGraphPhase[];
  /** Scheduled resolve phases default to incremental; manual runs stay full. */
  default_run_mode: 'full' | 'incremental';
  /**
   * Optional warehouse-text chunk sources, copied through verbatim from
   * `bobsled.yml`. The `extract_mentions` phase chunks these into `__chunks`.
   * Consumed by the managed runner; absent for resolution-only pipelines.
   */
  chunk_sources?: ChunkSource[];
  enabled: boolean;
}

/**
 * Walk `bobsled.yml` and return one `ResolvedEntityGraphPipeline` per
 * `type: entity-graph` entry. Schedules are pre-parsed into POSIX cron
 * (or `null` for `schedule: manual`) and the `phases` default is
 * already materialized by the Zod schema, so consumers don't need to
 * re-apply it. Extract and models pipelines are skipped — pair this
 * function with `resolvePipelines` and `resolveModelPipelines` to get
 * the full inventory.
 */
export function resolveEntityGraphPipelines(config: BobsledConfig): ResolvedEntityGraphPipeline[] {
  const result: ResolvedEntityGraphPipeline[] = [];
  for (const [name, entry] of Object.entries(config.pipelines)) {
    if (!isEntityGraphPipelineConfig(entry)) continue;
    const trigger = pipelineTriggerFor(entry.schedule);
    result.push({
      name,
      description: entry.description,
      schedule: entry.schedule,
      cron: trigger === 'manual' ? null : parseToCron(entry.schedule),
      trigger,
      connection: entry.connection,
      entities: entry.entities,
      phases: entry.phases,
      default_run_mode: trigger === 'manual' ? 'full' : 'incremental',
      chunk_sources: entry.chunk_sources,
      enabled: entry.enabled ?? true,
    });
  }
  return result;
}

/**
 * Slug used in the synthetic pipeline name `_models_default_<connection_slug>`.
 * Connection handles are already snake_case (the schema enforces this), so the
 * slug is just the handle echoed back. Kept as a function so a future change
 * to the slug shape lives in one place.
 */
export function syntheticModelPipelineNameForConnection(connection: string): string {
  return `_models_default_${connection}`;
}

/**
 * A model pipeline post-resolution: wildcards expanded, synthetic flag set,
 * cron pre-parsed. Workflow generators and host applications consume this
 * resolved shape.
 */
export interface ExpandedModelPipeline {
  name: string;
  description?: string;
  schedule: string;
  /**
   * POSIX cron expression for the resolved `schedule`, or `null` for
   * manual-trigger pipelines (`schedule: manual`).
   */
  cron: string | null;
  trigger: PipelineTrigger;
  connection: string;
  /** Optional pipeline-level session warehouse selector. */
  warehouse?: string;
  /** Resolved model names — never `'*'`, never empty for synthetic pipelines. */
  models: string[];
  /**
   * Per-model nodes for the v3 manifest DAG — one entry per name in `models`,
   * carrying the in-pipeline upstream refs (intersected with this pipeline's
   * model set) and tags. Parallel to `models` and in the same order; the v3
   * manifest builder turns each into a node + ref edges.
   */
  modelNodes: ModelNode[];
  enabled: boolean;
  /** True for `_models_default_<connection>` pipelines emitted by the parser. */
  synthetic: boolean;
}

/**
 * Build the per-model `ModelNode` list for a model pipeline: for each resolved
 * model name, pull its refs/tags from the discovered-model map and intersect
 * the refs with the pipeline's own model set so cross-pipeline refs don't
 * create dangling edges. A model whose metadata is absent (or carries no refs)
 * yields `refs: []` — a correct root node.
 */
function buildModelNodes(modelNames: string[], models: Map<string, DiscoveredModel>): ModelNode[] {
  const inSet = new Set(modelNames.map((name) => name.toLowerCase()));
  // Resolve metadata case-insensitively — the Model Spec DAG canonicalizes model
  // names/refs to lowercase, so a `bobsled.yml` pipeline may list a model in a
  // different case than the spec's `name:`. A case-sensitive `models.get(name)`
  // would miss, drop the model's refs, and silently turn it into a spurious
  // root node (parallel instead of sequential edges).
  const byCanonical = new Map<string, DiscoveredModel>();
  for (const [key, value] of models) byCanonical.set(key.toLowerCase(), value);
  return modelNames.map((name) => {
    const meta = byCanonical.get(name.toLowerCase());
    const self = name.toLowerCase();
    const refs = (meta?.refs ?? []).filter((ref) => {
      const canonical = ref.toLowerCase();
      return canonical !== self && inSet.has(canonical);
    });
    const node: ModelNode = { name, refs };
    if (meta?.tags && meta.tags.length > 0) node.tags = meta.tags;
    return node;
  });
}

/**
 * Expand authored `type: models` pipelines: turn `models: '*'` into the full
 * list of derived models that share the pipeline's `connection`. Pipelines
 * with explicit lists pass through unchanged. Wildcard pipelines that match
 * zero models still emit (with an empty list) — `validateModelPipelineMembership`
 * is the authority on that warning surface.
 */
export function expandAuthoredModelPipelines(
  pipelines: ResolvedModelPipeline[],
  models: Map<string, DiscoveredModel>
): ExpandedModelPipeline[] {
  return pipelines.map((pipeline) => {
    // Wildcard expansion is sorted alphabetically so the manifest is
    // deterministic across machines — `models` discovery walks the filesystem,
    // and the resulting Map iteration order can flap between dev/CI and make
    // `runner generate --check` falsely report drift on identical configs.
    // Explicit lists pass through verbatim (authors choose the order).
    const resolvedModels =
      pipeline.models === '*'
        ? [...models.entries()]
            .filter(([, meta]) => meta.connection === pipeline.connection)
            .map(([name]) => name)
            .sort()
        : [...pipeline.models];
    return {
      name: pipeline.name,
      description: pipeline.description,
      schedule: pipeline.schedule,
      cron: pipeline.cron,
      trigger: pipeline.trigger,
      connection: pipeline.connection,
      ...(pipeline.warehouse !== undefined ? { warehouse: pipeline.warehouse } : {}),
      models: resolvedModels,
      modelNodes: buildModelNodes(resolvedModels, models),
      enabled: pipeline.enabled,
      synthetic: false,
    };
  });
}

/**
 * Detect orphan-eligible derived models — those with materialization in
 * `{table | incremental | snapshot}` that no expanded authored pipeline
 * mentions — and emit one synthetic `_models_default_<connection>` pipeline
 * per connection that has any orphans. Returned pipelines carry the
 * `defaults.models.schedule` cadence; the call is a no-op when no
 * `defaults.models` block is defined or when no orphans exist.
 *
 * Determinism notes:
 *   - The synthetic pipeline list is sorted by connection slug.
 *   - Each pipeline's `models` list is sorted alphabetically.
 *   This keeps generated workflow files stable across runs and environments
 *   so `generate --check` doesn't flap.
 */
export function computeSyntheticModelPipelines(
  config: BobsledConfig,
  authoredExpanded: ExpandedModelPipeline[],
  models: Map<string, DiscoveredModel>
): ExpandedModelPipeline[] {
  const defaultSchedule = config.defaults?.models?.schedule;
  if (!defaultSchedule) return [];

  // Claim case-insensitively — an authored pipeline may list a model in a
  // different case than the discovered key, and the Model Spec DAG treats names
  // case-insensitively. Without this, a case mismatch would wrongly re-emit a
  // claimed model as a synthetic orphan.
  const claimed = new Set<string>();
  for (const pipeline of authoredExpanded) {
    for (const modelName of pipeline.models) {
      claimed.add(modelName.toLowerCase());
    }
  }

  const orphansByConnection = new Map<string, string[]>();
  for (const [name, meta] of models.entries()) {
    if (claimed.has(name.toLowerCase())) continue;
    if (!isOrphanEligibleMaterialization(meta.materialization)) continue;
    if (meta.connection === undefined) continue;
    const list = orphansByConnection.get(meta.connection);
    if (list) {
      list.push(name);
    } else {
      orphansByConnection.set(meta.connection, [name]);
    }
  }

  const sortedConnections = [...orphansByConnection.keys()].sort();
  const trigger = pipelineTriggerFor(defaultSchedule);
  // `defaults.models.schedule: manual` propagates the manual trigger to every
  // synthetic pipeline — orphan models become addressable through
  // `bobsled runner dispatch` / `bobsled model run` but no cron is registered.
  const cron = trigger === 'manual' ? null : parseToCron(defaultSchedule);

  return sortedConnections.map((connection) => {
    const orphanModels = orphansByConnection.get(connection)!.slice().sort();
    return {
      name: syntheticModelPipelineNameForConnection(connection),
      schedule: defaultSchedule,
      cron,
      trigger,
      connection,
      models: orphanModels,
      modelNodes: buildModelNodes(orphanModels, models),
      enabled: true,
      synthetic: true,
    };
  });
}

/**
 * Combined entry point: resolve all model pipelines (authored + synthetic) for
 * a given Bobsled Core config + project root. The manifest generator uses this; the
 * host application will too once it imports the library export.
 *
 * Returns authored pipelines first (preserving bobsled.yml ordering), followed
 * by synthetic pipelines sorted by connection slug.
 */
export function resolveAllModelPipelines(
  config: BobsledConfig,
  projectRoot: string,
  index?: ProjectIndex
): ExpandedModelPipeline[] {
  return resolveAllModelPipelinesFromModels(
    config,
    discoverProjectModels(config, openBobsledProject(projectRoot, index))
  );
}

/**
 * Variant of `resolveAllModelPipelines` for callers that already have a
 * resolved model registry (e.g. a downstream host application, which loads model
 * specs from a database rather than a filesystem).
 */
export function resolveAllModelPipelinesFromModels(
  config: BobsledConfig,
  models: Map<string, DiscoveredModel>
): ExpandedModelPipeline[] {
  const authored = resolveModelPipelines(config);
  const expanded = expandAuthoredModelPipelines(authored, models);
  const synthetic = computeSyntheticModelPipelines(config, expanded, models);
  return [...expanded, ...synthetic];
}

export function resolveDestinationConfig(
  config: BobsledConfig,
  destinationName: string
): DestinationConfig | undefined {
  return config.destinations[destinationName];
}

// ---------------------------------------------------------------------------
// Integration validation catalog
// ---------------------------------------------------------------------------

export async function loadIntegrationsLib(): Promise<IntegrationsLib> {
  return BUILT_IN_VALIDATION_CATALOG;
}

interface EmbedSecretBinding {
  pipelineName: string;
  envVar: string;
  provider: string;
  rawPlaceholder: string;
}

function extractEmbedApiKey(embed: EmbedConfig): string | undefined {
  if (!('api_key' in embed) || typeof embed.api_key !== 'string') return undefined;
  return embed.api_key;
}

function enumerateEmbedSecretBindings(config: BobsledConfig): EmbedSecretBinding[] {
  const bindings: EmbedSecretBinding[] = [];
  for (const [pipelineName, pipeline] of Object.entries(config.pipelines)) {
    if (!isExtractPipelineConfig(pipeline) || !pipeline.embed) continue;
    const rawPlaceholder = extractEmbedApiKey(pipeline.embed);
    if (!rawPlaceholder) continue;
    const envVar = parseEnvPlaceholder(rawPlaceholder);
    if (!envVar) continue;
    bindings.push({
      pipelineName,
      envVar,
      provider: pipeline.embed.provider,
      rawPlaceholder,
    });
  }
  return bindings;
}

export function enumerateSecretsFromLib(
  config: BobsledConfig,
  lib: IntegrationsLib
): SecretRequirement[] {
  const secrets: SecretRequirement[] = [];
  const seen = new Set<string>();
  const sources = new Set(
    Object.values(config.pipelines)
      .filter(isExtractPipelineConfig)
      .map((p) => p.source)
  );

  for (const source of sources) {
    try {
      const integration = lib.getIntegration(source);
      for (const entry of integration.meta.auth_setup ?? []) {
        if (seen.has(entry.env)) continue;
        seen.add(entry.env);
        secrets.push({
          integration: source,
          envVar: entry.env,
          description: entry.description,
          docsUrl: entry.docs_url,
        });
      }
    } catch {
      // Source not found — validation handles this separately
    }
  }

  for (const binding of enumerateEmbedSecretBindings(config)) {
    if (seen.has(binding.envVar)) continue;
    seen.add(binding.envVar);
    secrets.push({
      integration: `embed:${binding.provider}`,
      envVar: binding.envVar,
      description: `API key for the embed stage of pipeline "${binding.pipelineName}" (provider: ${binding.provider})`,
    });
  }

  return secrets;
}

/**
 * Verify every `api_key` placeholder referenced by a pipeline `embed:` block
 * resolves to a value in the given env. Returns one ValidationIssue per
 * unresolved placeholder, with the pipeline path so consumers can surface
 * a structured planning error before invoking `runProjectPipeline`.
 *
 * This is the plan-time gate that lets the host application (and the CLI) fail fast
 * on missing secrets instead of waiting for the embed subprocess to crash
 * with `Environment variable "X" is not set`.
 */
export function validateEmbedSecretsResolvable(
  config: BobsledConfig,
  env: Record<string, string | undefined> = process.env
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const binding of enumerateEmbedSecretBindings(config)) {
    const value = env[binding.envVar];
    if (value === undefined || value === '') {
      issues.push({
        path: `bobsled.yml:pipelines.${binding.pipelineName}.embed.api_key`,
        message:
          `Environment variable "${binding.envVar}" referenced by ` +
          `"${binding.rawPlaceholder}" is not set.`,
      });
    }
  }
  return issues;
}

export async function enumerateSecrets(config: BobsledConfig): Promise<SecretRequirement[]> {
  const lib = await loadIntegrationsLib();
  if (!lib) return [];
  return enumerateSecretsFromLib(config, lib);
}

function isIncrementalResource(resource: ValidationCatalogResourceSpec): boolean {
  if (resource.extract?.incremental) return true;
  if (resource.replication && resource.replication.method !== 'full_refresh') return true;
  return false;
}

export function buildIncrementalChecker(lib: IntegrationsLib): (source: string) => boolean {
  return (source: string): boolean => {
    try {
      const resources = lib.getResources(source);
      return resources.some((r) => isIncrementalResource(r.resource));
    } catch {
      // Unknown source — assume incremental to avoid false warnings
      return true;
    }
  };
}

// ---------------------------------------------------------------------------
// Embed validation
// ---------------------------------------------------------------------------

interface EmbedValidationResult {
  errors: ValidationIssue[];
  warnings: string[];
}

function validateEmbedSelections(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib
): EmbedValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: string[] = [];
  const activeResourceNames = new Set(pipeline.resources.map((r) => r.name));
  const resources = lib
    .getResources(pipeline.source)
    .map((entry) => entry.resource)
    .filter((resource) => activeResourceNames.has(resource.name));
  const resourcesByName = new Map(resources.map((resource) => [resource.name, resource]));
  const candidatesByStream = new Map<string, string[]>();

  for (const resource of resources) {
    const candidateFields = Object.entries(resource.output ?? {})
      .filter(([, field]) => field.embedding_candidate === true)
      .map(([fieldName]) => fieldName);
    if (candidateFields.length > 0) {
      candidatesByStream.set(resource.name, candidateFields);
    }
  }

  if (!pipeline.embed) {
    for (const [stream, candidateFields] of candidatesByStream.entries()) {
      warnings.push(
        `Pipeline "${pipeline.name}": stream "${stream}" has embedding_candidate fields (${candidateFields.join(', ')}) but no embed config.`
      );
    }
    return { errors, warnings };
  }

  for (const [stream, fields] of Object.entries(pipeline.embed.streams)) {
    const resource = resourcesByName.get(stream);
    if (!resource) {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.embed.streams.${stream}`,
        message:
          `resource "${stream}" not found in integration "${pipeline.source}" ` +
          'or is excluded from this pipeline',
      });
      continue;
    }

    for (const field of fields) {
      const outputField = resource.output?.[field.field];
      if (!outputField) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.embed.streams.${stream}.${field.field}`,
          message:
            `field "${field.field}" not found on resource "${stream}" ` +
            `in integration "${pipeline.source}"`,
        });
        continue;
      }

      if (outputField.embedding_candidate !== true) {
        warnings.push(
          `Pipeline "${pipeline.name}": embed field "${field.field}" on stream "${stream}" is not marked embedding_candidate in integration "${pipeline.source}".`
        );
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Full validation
// ---------------------------------------------------------------------------

export async function validateBobsledConfig(
  config: BobsledConfig,
  projectRoot: string,
  validationCatalog: ValidationCatalog = BUILT_IN_VALIDATION_CATALOG,
  index?: ProjectIndex
): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: string[] = [];
  const invalid = (): ValidationResult => ({
    valid: false,
    errors,
    warnings,
    secrets: [],
    pipelines: [],
    modelPipelines: [],
    entityGraphPipelines: [],
  });
  let project: BobsledProject;
  try {
    project = openBobsledProject(projectRoot, index);
  } catch (error) {
    if (!(error instanceof ProjectIndexError)) throw error;
    errors.push(...projectFileIssues(error));
    return invalid();
  }
  warnings.push(...legacyBlueprintWarnings(project.index));
  let pipelines: ResolvedPipeline[] = [];
  let modelPipelines: ResolvedModelPipeline[] = [];
  let entityGraphPipelines: ResolvedEntityGraphPipeline[] = [];

  // 1. Resolve pipelines (validates schedules)
  try {
    pipelines = resolvePipelines(config);
    modelPipelines = resolveModelPipelines(config);
    entityGraphPipelines = resolveEntityGraphPipelines(config);
  } catch (e) {
    errors.push({ path: 'bobsled.yml', message: (e as Error).message });
    return invalid();
  }

  // 2. Validate destination references
  errors.push(...validateDatabricksDestinationAuth(config.destinations));
  for (const pipeline of pipelines) {
    for (const destinationName of pipeline.destinationNames) {
      if (!(destinationName in config.destinations)) {
        const available = Object.keys(config.destinations).join(', ');
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}`,
          message: `Destination "${destinationName}" not found in top-level destinations map. Available: ${available}`,
        });
      }
    }
    if (pipeline.destinationWarehouse !== undefined) {
      const destinationName = pipeline.destinationNames[0];
      const destination = destinationName ? config.destinations[destinationName] : undefined;
      if (pipeline.destinationNames.length !== 1 || destination?.type !== 'bobsled_managed') {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.destination_warehouse`,
          message:
            'destination_warehouse is only supported with a singular destination whose type is "bobsled_managed".',
        });
      }
    }
    for (const resource of pipeline.resources) {
      if (resource.override?.tableOwnershipMarker === undefined) continue;
      const destinationName = pipeline.destinationNames[0];
      if (
        pipeline.destinationNames.length !== 1 ||
        (destinationName &&
          !['snowflake', 'bigquery', 'databricks', 'postgres'].includes(
            config.destinations[destinationName]?.type ?? ''
          ))
      ) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.table_ownership_marker`,
          message: 'table_ownership_marker requires one supported warehouse destination',
        });
      }
    }
  }

  const fileDestinationTypes = new Set(['local', 'gcs', 's3']);
  for (const pipeline of pipelines) {
    const fileDestinations = pipeline.destinationNames.filter((name) => {
      const destination = config.destinations[name];
      return destination ? fileDestinationTypes.has(destination.type) : false;
    });
    if (fileDestinations.length === 0) continue;
    const unsupported = pipeline.resources.filter(
      (resource) =>
        resource.override?.loadStrategy !== undefined || resource.override?.table !== undefined
    );
    if (unsupported.length > 0) {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
        message:
          `Per-resource load_strategy/table overrides require database destinations; ` +
          `file destination(s) [${fileDestinations.join(', ')}] cannot apply overrides on ` +
          `[${unsupported.map((resource) => resource.requestedName ?? resource.name).join(', ')}].`,
      });
    }
  }

  // 3. Select one metadata-only catalog for every validation phase.
  const lib = validationCatalog;

  // 4. Validate sources against bundled and project-local integrations.
  if (lib) {
    validateSourcePresence(pipelines, lib, project, errors);
  }

  // 4b. Validate `via:` selectors reference real transport ids on the source.
  if (lib) {
    for (const pipeline of pipelines) {
      validateViaSelections(pipeline, lib, errors);
    }
  }

  // 4b'. Validate warehouse selectors: reject per-resource overrides and
  //      require each pipeline-level selector to name a declared warehouse ID.
  for (const pipeline of pipelines) {
    validateWarehouseSelections(pipeline, lib, errors);
  }

  // 4c. Resolve entity-name resource references to their concrete variant.
  // Runs before validateResourceResolution so the resolved spec name flows
  // through every downstream check and into the extractor subprocess.
  // The project is passed so project-local resources can shadow bundled
  // entity rewrites (preserves the "project-local overrides bundled" rule).
  if (lib) {
    for (const pipeline of pipelines) {
      resolveEntityVariant(pipeline, lib, project, errors);
    }
  }
  for (const pipeline of pipelines) {
    validateResourceInputOverrides(pipeline, lib, project, errors);
    validateResourceInputMatrices(pipeline, lib, project, errors);
  }
  for (const pipeline of pipelines) {
    validateUniqueResolvedResources(pipeline, errors);
  }

  // 5. Validate resources resolve (bundled or project-local). Project
  //    resources must each have one owner and a unique name.
  errors.push(...projectResourceIssues(project));
  for (const pipeline of pipelines) {
    validateResourceResolution(pipeline, lib, project, errors, warnings);
  }

  // 6. Cross-check resource extract.integration matches the pipeline binding
  for (const pipeline of pipelines) {
    validateResourceSourceAlignment(pipeline, project, errors);
  }

  // 7. Validate embed selections
  if (lib) {
    for (const pipeline of pipelines) {
      if (pipeline.enabled === false) {
        continue;
      }

      try {
        const embedValidation = validateEmbedSelections(pipeline, lib);
        errors.push(...embedValidation.errors);
        warnings.push(...embedValidation.warnings);
      } catch {
        // Source lookup failures already handled above.
      }
    }
  }

  // 8. Validate model pipeline membership (compile-time check that named
  //    models exist as derived models AND belong to the declared connection).
  validateModelPipelineMembership(modelPipelines, config, project, errors, warnings);

  // 8b. Validate model-pipeline warehouse selectors against their connection's
  //     declared warehouse IDs. A supplied selector cannot be best-effort.
  for (const mp of modelPipelines) {
    validateModelWarehouseSelections(mp, lib, errors);
  }

  // 9. Validate for_each iteration: the runner supports it AND every for_each
  //    child's parent is selected in the same pipeline (so the parent runs
  //    first). Runs after resolveEntityVariant so names compare in spec space.
  for (const pipeline of pipelines) {
    validateForEachIteration(pipeline, lib, project, errors);
  }

  // 10. Enumerate secrets
  const secrets = lib ? enumerateSecretsFromLib(config, lib) : [];

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    secrets,
    pipelines,
    modelPipelines,
    entityGraphPipelines,
  };
}
