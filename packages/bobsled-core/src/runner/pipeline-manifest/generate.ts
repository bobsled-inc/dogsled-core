import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProjectIndex } from '@bobsled-inc/project-index';
import { CommandError, warnLegacySettings } from '@bobsled-inc/protocol';

import {
  discoverModels,
  resolveAllModelPipelines,
  resolveAllModelPipelinesFromModels,
  resolveEntityGraphPipelines,
  type DiscoveredModel,
  type ExpandedModelPipeline,
  type IntegrationsLib,
  type ModelNode,
  type ResolvedEntityGraphPipeline,
  type ResolvedPipeline,
} from '../config/loader.js';
import {
  resolveProjectPipelines,
  type ResolveProjectPipelinesOptions,
} from '../config/project-resolver.js';
import { BUILT_IN_VALIDATION_CATALOG } from '../../validation.js';
import { isModelsPipelineConfig, pipelineTriggerFor } from '../config/schema.js';
import type { BobsledConfig } from '../config/schema.js';
import { forEachDependencyFromRaw, forEachParentFromRaw } from '../config/resolve-resource.js';
import { parseToCron } from '../schedule/parser.js';
import { listSyncSpecs, type LoadedSyncSpec } from '../../sync/spec.js';
import {
  buildPipelineManifestObject,
  PIPELINE_MANIFEST_PATH,
  serializePipelineManifest,
  type EntityGraphPipelineTemplateInput,
  type BobsledPipelineManifest,
  type ModelPipelineTemplateInput,
  type PipelineTemplateInput,
  type PipelineResourceMetadata,
  type ReverseEtlPipelineTemplateInput,
} from './template.js';

interface GeneratedFile {
  relativePath: string;
  content: string;
}

interface ResolvedModelSequence {
  modelSequence: string[];
  runModels: boolean;
}

export interface GeneratePipelineManifestFilesOptions {
  integrations?: IntegrationsLib;
  bobsledVersion?: string;
}

declare const __CLI_VERSION__: string | undefined;

function resolveBobsledCliVersion(): string {
  if (typeof __CLI_VERSION__ !== 'undefined' && __CLI_VERSION__) {
    return __CLI_VERSION__;
  }

  try {
    const packagePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'package.json'
    );
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Source execution should still generate a syntactically valid manifest in tests.
  }

  return '0.0.0-dev';
}

function slugForPipelineName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const withStart = /^[a-z_]/.test(normalized) ? normalized : `pipeline_${normalized}`;
  return withStart || 'pipeline';
}

export function graphIdForPipeline(pipelineName: string): string {
  return `bobsled_${slugForPipelineName(pipelineName)}`;
}

function resolveResources(pipeline: ResolvedPipeline, _lib?: IntegrationsLib): string[] {
  const resourceNames = pipeline.resources.map((r) => r.name);
  if (resourceNames.length === 0) {
    throw new CommandError(
      `Pipeline manifest generation found no resources for pipeline "${pipeline.name}".`,
      2
    );
  }
  return resourceNames;
}

/**
 * Build complete resolved resource metadata for the persisted manifest.
 * Besides for_each grouping, this freezes destination and effective load
 * settings so an execution consumer never needs to reproduce Dogsled's
 * override/default precedence.
 *
 * Resolution order:
 *
 *   1. **Per-resource `forEachParent`** carried on `ResolvedPipeline.resources[i]`.
 *      This is the library-mode entrypoint: callers (host manifest generators) read for_each from their own bundle
 *      indexer and pass it through. They typically don't ship
 *      `@bobsled-inc/integrations` and they can't — `custom_api` integrations
 *      defined in user bundles live outside that package, so library-mode
 *      callers must supply the metadata directly.
 *   2. **`IntegrationsLib.getResources(...)` lookup.** Dogsled CLI flow: when
 *      generating the manifest from `bobsled.yml` and a bundled integration,
 *      pull `extract.for_each.resource` straight off the loaded ResourceSpec.
 *
 * Returns `undefined` only when neither source yields any parent — in that
 * case every resource lands in its own component (pre-fix behavior).
 */
function collectResourceMetadata(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib | undefined,
  config: BobsledConfig | undefined
): Record<string, PipelineResourceMetadata> | undefined {
  const metadata: Record<string, PipelineResourceMetadata> = Object.create(null);
  const resourceNames = new Set(pipeline.resources.map((r) => r.name));
  let specs: Array<{ resource: { name?: unknown; extract?: unknown } }> = [];
  if (lib) {
    try {
      const raw = lib.getResources(pipeline.source);
      specs = Array.isArray(raw) ? raw : [];
    } catch {
      specs = [];
    }
  }

  // Pass 1 — freeze Dogsled-resolved load metadata for every selected resource.
  // Runtime precedence for load_strategy and schema_behavior is resource >
  // pipeline > destination. A pipeline can impose one load contract across
  // its fan-out destinations while destinations remain useful as the
  // project-wide default.
  for (const resource of pipeline.resources) {
    const destinationSettings = Object.fromEntries(
      pipeline.destinationNames.map((name) => {
        const destination = config?.destinations[name];
        const effectiveLoadStrategy =
          resource.override?.loadStrategy ?? pipeline.loadStrategy ?? destination?.load_strategy;
        const effectiveSchemaBehavior =
          resource.override?.schemaBehavior ??
          pipeline.schemaBehavior ??
          destination?.schema_behavior;
        const effectiveTablePrefix = destination?.table_prefix ?? pipeline.tablePrefix;
        return [
          name,
          {
            ...(effectiveLoadStrategy ? { load_strategy: effectiveLoadStrategy } : {}),
            ...(effectiveSchemaBehavior ? { schema_behavior: effectiveSchemaBehavior } : {}),
            ...(effectiveTablePrefix ? { table_prefix: effectiveTablePrefix } : {}),
          },
        ];
      })
    );
    const settings = Object.values(destinationSettings);
    const sharedStrategy =
      settings.length > 0 &&
      settings.every((entry) => entry.load_strategy === settings[0]?.load_strategy)
        ? settings[0]?.load_strategy
        : undefined;
    const sharedSchemaBehavior =
      settings.length > 0 &&
      settings.every((entry) => entry.schema_behavior === settings[0]?.schema_behavior)
        ? settings[0]?.schema_behavior
        : undefined;
    const sharedPrefix =
      settings.length > 0 &&
      settings.every((entry) => entry.table_prefix === settings[0]?.table_prefix)
        ? settings[0]?.table_prefix
        : undefined;
    metadata[resource.name] = {
      ...(resource.override?.inputMatrix
        ? {
            input_matrix: {
              axes: Object.fromEntries(
                Object.entries(resource.override.inputMatrix.axes).map(([axis, values]) => [
                  axis,
                  [...values],
                ])
              ),
              concurrency: resource.override.inputMatrix.concurrency,
            },
          }
        : {}),
      load: {
        destinations: [...pipeline.destinationNames],
        destination_settings: destinationSettings,
        ...(sharedPrefix ? { table_prefix: sharedPrefix } : {}),
        ...(sharedStrategy ? { load_strategy: sharedStrategy } : {}),
        ...(sharedSchemaBehavior ? { schema_behavior: sharedSchemaBehavior } : {}),
        ...(resource.override?.table ? { table: resource.override.table } : {}),
        ...(resource.override?.tableOwnershipMarker
          ? { table_ownership_marker: resource.override.tableOwnershipMarker }
          : {}),
      },
    };
    const bundledResource = specs.find(
      ({ resource: spec }) => spec.name === resource.name
    )?.resource;
    const dependency = forEachDependencyFromRaw(bundledResource);
    const hasExplicitBindings = hasEveryForEachInput(pipeline, resource, dependency);
    if (
      resource.forEachParent &&
      resourceNames.has(resource.forEachParent) &&
      !hasExplicitBindings
    ) {
      metadata[resource.name]!.for_each_parent = resource.forEachParent;
    }
  }

  // Pass 2 — IntegrationsLib fallback for resources whose forEachParent was
  // not already supplied. Dogsled CLI users get the metadata for free this way.
  if (lib) {
    for (const { resource } of specs) {
      const name = typeof resource?.name === 'string' ? resource.name : undefined;
      if (!name || !resourceNames.has(name) || metadata[name]?.for_each_parent) continue;
      const resolved = pipeline.resources.find((candidate) => candidate.name === name);
      const dependency = forEachDependencyFromRaw(resource);
      if (resolved && hasEveryForEachInput(pipeline, resolved, dependency)) {
        continue;
      }
      const parent = forEachParentFromRaw(resource);
      if (!parent || !resourceNames.has(parent)) continue;
      metadata[name]!.for_each_parent = parent;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function hasEveryForEachInput(
  pipeline: ResolvedPipeline,
  resource: ResolvedPipeline['resources'][number],
  dependency: ReturnType<typeof forEachDependencyFromRaw>
): boolean {
  if (!dependency) return false;
  const inputs = { ...pipeline.inputs, ...resource.override?.inputs };
  return dependency.boundInputs.every((inputName) => Object.hasOwn(inputs, inputName));
}

function resolveModelSequence(
  config: BobsledConfig,
  pipeline: ResolvedPipeline
): ResolvedModelSequence {
  if (!config.models?.after?.includes(pipeline.name)) {
    return { modelSequence: [], runModels: false };
  }

  return {
    modelSequence: config.models.sequence ?? [],
    runModels: true,
  };
}

export function buildPipelineInputs(
  pipelines: ResolvedPipeline[],
  lib?: IntegrationsLib,
  config?: BobsledConfig
): PipelineTemplateInput[] {
  const seenGraphIds = new Map<string, string>();

  return pipelines.map((pipeline) => {
    const graphId = graphIdForPipeline(pipeline.name);
    const existing = seenGraphIds.get(graphId);
    if (existing) {
      throw new CommandError(
        `Pipeline names "${existing}" and "${pipeline.name}" resolve to the same graph id (${graphId}). Rename one pipeline.`,
        2
      );
    }
    seenGraphIds.set(graphId, pipeline.name);
    const { modelSequence, runModels } = config
      ? resolveModelSequence(config, pipeline)
      : { modelSequence: [], runModels: false };

    const resourceMetadata = collectResourceMetadata(pipeline, lib, config);
    return {
      cron: pipeline.cron,
      graphId,
      integration: pipeline.source,
      ...(pipeline.warehouse !== undefined ? { warehouse: pipeline.warehouse } : {}),
      ...(pipeline.destinationWarehouse !== undefined
        ? { destinationWarehouse: pipeline.destinationWarehouse }
        : {}),
      modelSequence,
      pipelineName: pipeline.name,
      description: pipeline.description,
      resources: resolveResources(pipeline, lib),
      ...(resourceMetadata ? { resourceMetadata } : {}),
      runModels,
      schedule: pipeline.schedule,
      trigger: pipeline.trigger,
    };
  });
}

/**
 * Map an `ExpandedModelPipeline` (authored or synthetic) onto the manifest's
 * `ModelPipelineTemplateInput` shape. Pure data shuffle; the
 * synthetic-vs-authored distinction is preserved verbatim so the manifest can
 * carry the `synthetic: true` marker.
 */
export function buildModelPipelineInputs(
  modelPipelines: ExpandedModelPipeline[],
  reservedGraphIds?: Map<string, string>
): ModelPipelineTemplateInput[] {
  const seenGraphIds = reservedGraphIds ?? new Map<string, string>();
  return modelPipelines
    .filter((pipeline) => pipeline.enabled !== false)
    .map((pipeline) => {
      const graphId = graphIdForPipeline(pipeline.name);
      const existing = seenGraphIds.get(graphId);
      if (existing) {
        throw new CommandError(
          `Pipeline names "${existing}" and "${pipeline.name}" resolve to the same graph id (${graphId}). Rename one pipeline.`,
          2
        );
      }
      seenGraphIds.set(graphId, pipeline.name);
      return {
        pipelineName: pipeline.name,
        description: pipeline.description,
        graphId,
        connection: pipeline.connection,
        ...(pipeline.warehouse !== undefined ? { warehouse: pipeline.warehouse } : {}),
        models: pipeline.models,
        modelNodes: pipeline.modelNodes,
        schedule: pipeline.schedule,
        cron: pipeline.cron,
        trigger: pipeline.trigger,
        synthetic: pipeline.synthetic,
      };
    });
}

/**
 * Map `ResolvedEntityGraphPipeline` (parsed from `bobsled.yml`) onto the
 * manifest's `EntityGraphPipelineTemplateInput` shape. Pure data
 * shuffle. Disabled pipelines are filtered out so they neither claim a
 * graph id nor land in the manifest.
 */
export function buildEntityGraphPipelineInputs(
  entityGraphPipelines: ResolvedEntityGraphPipeline[],
  reservedGraphIds?: Map<string, string>
): EntityGraphPipelineTemplateInput[] {
  const seenGraphIds = reservedGraphIds ?? new Map<string, string>();
  return entityGraphPipelines
    .filter((pipeline) => pipeline.enabled !== false)
    .map((pipeline) => {
      const graphId = graphIdForPipeline(pipeline.name);
      const existing = seenGraphIds.get(graphId);
      if (existing) {
        throw new CommandError(
          `Pipeline names "${existing}" and "${pipeline.name}" resolve to the same graph id (${graphId}). Rename one pipeline.`,
          2
        );
      }
      seenGraphIds.set(graphId, pipeline.name);
      return {
        pipelineName: pipeline.name,
        description: pipeline.description,
        graphId,
        connection: pipeline.connection,
        entities: pipeline.entities,
        phases: pipeline.phases,
        defaultRunMode: pipeline.default_run_mode,
        schedule: pipeline.schedule,
        cron: pipeline.cron,
        trigger: pipeline.trigger,
      };
    });
}

export function buildReverseEtlPipelineInputs(
  syncs: LoadedSyncSpec[],
  reservedGraphIds?: Map<string, string>
): ReverseEtlPipelineTemplateInput[] {
  const seenGraphIds = reservedGraphIds ?? new Map<string, string>();
  return syncs.map((sync) => {
    const graphId = sync.spec.graph_id ?? graphIdForPipeline(sync.name);
    const existing = seenGraphIds.get(graphId);
    if (existing) {
      throw new CommandError(
        `Pipeline names "${existing}" and "${sync.name}" resolve to the same graph id (${graphId}). Rename one pipeline or set a unique sync graph_id.`,
        2
      );
    }
    seenGraphIds.set(graphId, sync.name);
    const trigger = pipelineTriggerFor(sync.spec.schedule);
    return {
      pipelineName: sync.name,
      description: sync.spec.description,
      graphId,
      syncName: sync.name,
      sourceConnection: sync.spec.source.connection,
      destinationConnection: sync.spec.target.destination_connection,
      targetAction: sync.spec.target.action,
      schedule: sync.spec.schedule,
      cron: trigger === 'manual' ? null : parseToCron(sync.spec.schedule),
      trigger,
    };
  });
}

export function generatePipelineManifestFiles(
  config: BobsledConfig,
  pipelines: ResolvedPipeline[],
  options: GeneratePipelineManifestFilesOptions & { projectRoot?: string } = {}
): GeneratedFile[] {
  // CLI / library parity: route the CLI through the same `generateManifest`
  // entry point that external consumers (downstream host applications) call.
  //
  // Without a `projectRoot` the model-pipeline scan can't run. If the config
  // declares any `type: models` pipelines, we fail loud rather than silently
  // dropping wildcard expansion + synthetic orphan emission — the resulting
  // manifest would still look structurally valid, so the regression would be
  // easy to miss. Disk-less callers (the host application) should use `generateManifest`
  // with an explicit `models` map instead.
  const hasModelPipelines = Object.values(config.pipelines).some(isModelsPipelineConfig);
  if (hasModelPipelines && !options.projectRoot) {
    throw new CommandError(
      'generatePipelineManifestFiles: bobsled.yml declares model pipelines but no `projectRoot` was provided. ' +
        'Pass `options.projectRoot` so Dogsled can scan `models/` for connection + materialization metadata, ' +
        'or call `generateManifest({ config, models })` directly with a pre-loaded model registry.',
      2
    );
  }
  const bobsledVersion = options.bobsledVersion ?? resolveBobsledCliVersion();
  const projectInput: GenerateManifestProjectInput = options.projectRoot
    ? { config, projectRoot: options.projectRoot }
    : { config, models: new Map() };

  const manifest = generateManifest(projectInput, {
    bobsledVersion,
    extractPipelines: pipelines,
    integrations: options.integrations,
  });

  if (manifest.pipelines.length === 0) {
    return [];
  }

  return [
    {
      relativePath: PIPELINE_MANIFEST_PATH,
      content: serializePipelineManifest(manifest),
    },
  ];
}

export function generatePipelineManifestFilesFromInputs(
  inputs: PipelineTemplateInput[],
  bobsledVersion?: string
): GeneratedFile[] {
  if (inputs.length === 0) {
    return [];
  }
  return [
    {
      relativePath: PIPELINE_MANIFEST_PATH,
      content: serializePipelineManifest(
        buildPipelineManifestObject(inputs, [], bobsledVersion ?? resolveBobsledCliVersion())
      ),
    },
  ];
}

/**
 * Public library entry point for callers that want the manifest as a
 * structured object instead of a generated-file artifact. Used by the
 * downstream host application (replacing its byte-identical local copy of this
 * logic). Orchestrator integrations should call `generateProjectManifest`
 *
 * Two project-input shapes are supported:
 *   - `{ config, projectRoot }` — Dogsled CLI shape: read Model Spec model metadata
 *     from the `type: model` files under `<projectRoot>` (or
 *     `<projectRoot>/<config.models.project>`), using `index` when given.
 *   - `{ config, models }` — disk-less shape: caller pre-loads the Model Spec model
 *     registry (the host application does this from a database).
 *
 * The two shapes are mutually exclusive at the type level; pass exactly one.
 */
export type GenerateManifestProjectInput =
  | { config: BobsledConfig; projectRoot: string; index?: ProjectIndex; models?: undefined }
  | {
      config: BobsledConfig;
      models: Map<string, DiscoveredModel>;
      projectRoot?: undefined;
      index?: undefined;
    };

export interface GenerateManifestOptions {
  /** Override `bobsled_cli_version`; defaults to the running Dogsled CLI version. */
  bobsledVersion?: string;
  /**
   * Resolved extract pipelines whose `runner` is `'managed'`. Optional —
   * callers that only care about model pipelines (the host application's current need)
   * may omit this.
   */
  extractPipelines?: ResolvedPipeline[];
  /** Compatibility name for a validation catalog used to enrich resolved resources. */
  integrations?: IntegrationsLib;
  /**
   * Parsed sync specs for disk-less callers. When omitted for project-root
   * callers, Dogsled reads the project's `type: sync` files.
   */
  reverseEtlSyncs?: LoadedSyncSpec[];
}

export interface GenerateProjectManifestOptions extends ResolveProjectPipelinesOptions {
  /** Override `bobsled_cli_version`; defaults to the running Dogsled CLI version. */
  bobsledVersion?: string;
}

/**
 * Fully validate and compile a materialized Dogsled project into its canonical
 * runtime manifest. Unlike the lower-level synchronous `generateManifest`,
 * callers do not supply partially resolved extract pipelines: Dogsled owns
 * parsing, cross-validation, entity/resource resolution, for_each grouping,
 * runner filtering, and schedule semantics.
 */
export async function generateProjectManifest(
  options: GenerateProjectManifestOptions
): Promise<BobsledPipelineManifest> {
  warnLegacySettings();
  const validationCatalog = options.validationCatalog ?? BUILT_IN_VALIDATION_CATALOG;
  const project = await resolveProjectPipelines({ ...options, validationCatalog });
  return generateManifest(
    { config: project.config, projectRoot: project.projectRoot, index: project.index },
    {
      extractPipelines: project.extractPipelines,
      integrations: validationCatalog,
      ...(options.bobsledVersion ? { bobsledVersion: options.bobsledVersion } : {}),
    }
  );
}

export function generateManifest(
  project: GenerateManifestProjectInput,
  options: GenerateManifestOptions = {}
): BobsledPipelineManifest {
  const modelPipelines: ExpandedModelPipeline[] =
    project.models !== undefined
      ? resolveAllModelPipelinesFromModels(project.config, project.models)
      : resolveAllModelPipelines(project.config, project.projectRoot, project.index);

  const entityGraphPipelines = resolveEntityGraphPipelines(project.config);
  const reverseEtlSyncs =
    options.reverseEtlSyncs ??
    (project.projectRoot !== undefined ? listSyncSpecs(project.projectRoot, project.index) : []);

  const seenGraphIds = new Map<string, string>();
  const extractInputs = buildPipelineInputs(
    (options.extractPipelines ?? []).filter(
      (pipeline) => pipeline.runner === 'managed' && pipeline.enabled !== false
    ),
    options.integrations,
    project.config
  );
  for (const input of extractInputs) {
    seenGraphIds.set(input.graphId, input.pipelineName);
  }
  const modelInputs = buildModelPipelineInputs(modelPipelines, seenGraphIds);
  const entityGraphInputs = buildEntityGraphPipelineInputs(entityGraphPipelines, seenGraphIds);
  const reverseEtlInputs = buildReverseEtlPipelineInputs(reverseEtlSyncs, seenGraphIds);

  return buildPipelineManifestObject(
    extractInputs,
    modelInputs,
    options.bobsledVersion ?? resolveBobsledCliVersion(),
    entityGraphInputs,
    reverseEtlInputs
  );
}

/**
 * Re-exported for downstream consumers that prefer to work with
 * `DiscoveredModel` directly when constructing `GenerateManifestProjectInput`.
 */
export { discoverModels };
export type { DiscoveredModel, ExpandedModelPipeline, ModelNode };
