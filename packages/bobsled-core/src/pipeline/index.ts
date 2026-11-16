import {
  declaredHostEnvironmentNames,
  withDeclaredAuthEnvVars,
  assertDeclaredEnvironmentReferences,
} from '@bobsled-inc/protocol';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateQueryTag } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';

import {
  runPipeline,
  type PipelineDependencies,
  type PipelineExecutionStage,
  type PipelineOptions,
} from '../commands/pipeline.js';
import { type ResolvedPipeline, type ResolvedResource } from '../runner/config/loader.js';
import { resolveProjectPipelines } from '../runner/config/project-resolver.js';
import { getWorkloadIdentitySourceEnvNames } from '../commands/pipeline-load-args.js';
import { resolveEnvPlaceholder } from '../runner/commands/env-placeholders.js';
import { MANAGED_DESTINATION_CORE_ERROR } from '../runner/commands/destination-args.js';
import {
  emptyPipelineRunMetrics,
  pipelineRunMetricsFromSummary,
  PipelineExecutionStateSchema,
  type PipelineExecutionState,
  type PipelineRunError,
  type PipelineRunEvent,
  type PipelineRunEventInput,
  type RunProjectPipelineDependencies,
  type RunProjectPipelineOptions,
  type RunProjectPipelineResult,
  type ResolvePipelineRunOptions,
  type ResolvedPipelineRunProject,
} from './contracts.js';
import { createPipelineRedactor } from './redaction.js';
import { expandInputMatrix } from '../runner/config/input-matrix.js';

import type {
  DestinationConfig,
  NamedDestination,
  PipelineInputValue,
  BobsledConfig,
} from '../runner/config/schema.js';
export {
  PipelineExecutionStateSchema,
  type PipelineExecutionState,
  type PipelineRunProjectResolver,
  type PipelineResourceMetrics,
  type PipelineRunError,
  type PipelineRunEvent,
  type PipelineRunMetrics,
  type PipelineRunStatus,
  type RunProjectPipelineDependencies,
  type RunProjectPipelineOptions,
  type RunProjectPipelineResult,
  type ResolvePipelineRunOptions,
  type ResolvedPipelineRunProject,
} from './contracts.js';

async function resolveDefaultPipelineRunProject(
  options: ResolvePipelineRunOptions,
  declaredEnvNames: readonly string[] = [],
  hostManagedModelAuth = false
): Promise<ResolvedPipelineRunProject> {
  const project = await resolveProjectPipelines({
    projectRoot: options.projectRoot,
    configPath: options.configPath,
    declaredEnvNames,
    hostManagedModelAuth,
  });
  const pipeline = project.extractPipelines.find((entry) => entry.name === options.pipelineName);
  if (!pipeline) {
    const modelPipeline = project.modelPipelines.find(
      (entry) => entry.name === options.pipelineName
    );
    if (modelPipeline) {
      const models = Array.isArray(modelPipeline.models)
        ? ` ${modelPipeline.models.join(' ')}`
        : '';
      throw new CommandError(
        `Pipeline "${options.pipelineName}" is a models pipeline, which runs under an orchestrator. ` +
          `Run its models locally with: dogsled model run${models} --integration ${modelPipeline.connection}`,
        2
      );
    }
    const entityGraphPipeline = project.entityGraphPipelines.find(
      (entry) => entry.name === options.pipelineName
    );
    if (entityGraphPipeline) {
      const entities = Array.isArray(entityGraphPipeline.entities)
        ? ` ${entityGraphPipeline.entities.join(' ')}`
        : '';
      throw new CommandError(
        `Pipeline "${options.pipelineName}" is an entity-graph pipeline, which runs under an orchestrator. ` +
          `Run it locally with: dogsled entity-graph build${entities} (see --help for runner options)`,
        2
      );
    }
    const available = project.extractPipelines.map((entry) => entry.name).join(', ');
    throw new CommandError(
      `Pipeline "${options.pipelineName}" not found. Available: ${available}`,
      2
    );
  }
  return {
    config: project.config,
    pipeline,
    projectRoot: project.projectRoot,
    warnings: project.warnings,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function validateMaxRecords(maxRecords: number | undefined): void {
  if (maxRecords !== undefined && (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)) {
    throw new CommandError('maxRecords must be a positive safe integer.', 2);
  }
}

function assertReconcileSchemaDestinations(
  streams: readonly string[] | undefined,
  destinations: readonly { name: string; type: string }[]
): void {
  if (!streams || streams.length === 0) return;
  const unsupported = destinations.filter((destination) => destination.type !== 'snowflake');
  if (unsupported.length > 0) {
    throw new CommandError(
      '--reconcile-schema is only supported for Snowflake destinations. ' +
        `Unsupported destination(s): ${unsupported.map((destination) => destination.name).join(', ')}.`,
      2
    );
  }
}

function prepareInvocationState(
  projectRoot: string,
  state: PipelineExecutionState | undefined
): { directory?: string; state?: PipelineExecutionState } {
  if (state === undefined) {
    return {};
  }
  const parsed = PipelineExecutionStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new CommandError(
      `Invalid pipeline state: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
      2
    );
  }
  const directory = fs.mkdtempSync(path.join(projectRoot, '.dogsled-runtime-state-'));
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(
      path.join(directory, 'state.json'),
      `${JSON.stringify(parsed.data, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
  return { directory, state: parsed.data };
}

function readInvocationState(
  directory: string,
  fallback: PipelineExecutionState
): PipelineExecutionState {
  const statePath = path.join(directory, 'state.json');
  if (!fs.existsSync(statePath)) {
    return fallback;
  }
  const parsed = PipelineExecutionStateSchema.safeParse(
    JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown
  );
  if (!parsed.success) {
    throw new Error(
      `Extractor returned invalid state: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`
    );
  }
  return parsed.data;
}

export async function runProjectPipeline(
  options: RunProjectPipelineOptions,
  dependencies: RunProjectPipelineDependencies = {}
): Promise<RunProjectPipelineResult> {
  validateMaxRecords(options.maxRecords);
  const declaredEnvNames = declaredHostEnvironmentNames(options.declaredEnvNames, options.env);
  const resolveDefault = (input: ResolvePipelineRunOptions) =>
    resolveDefaultPipelineRunProject(
      input,
      declaredEnvNames,
      options.hostManagedModelAuth === true
    );
  const resolveOptions = {
    projectRoot: options.projectRoot,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    pipelineName: options.pipelineName,
  } satisfies ResolvePipelineRunOptions;
  const project = dependencies.resolvePipeline
    ? await dependencies.resolvePipeline(resolveOptions, resolveDefault)
    : await resolveDefault(resolveOptions);
  const { config, pipeline } = project;

  const runtimeEnv = { ...process.env, ...options.env };
  const runtimeConfig = {
    ...config,
    destinations: Object.fromEntries(
      Object.entries(config.destinations).map(([name, destination]) => [
        name,
        {
          ...destination,
          auth_env_vars: [...(destination.auth_env_vars ?? []), ...declaredEnvNames],
        },
      ])
    ),
  };
  const { resourceNames, pipelineOptions } = buildPipelineInvocation({
    pipeline: {
      ...pipeline,
      ...(pipeline.embed
        ? {
            embed: withDeclaredAuthEnvVars(
              pipeline.embed,
              declaredEnvNames
            ) as typeof pipeline.embed,
          }
        : {}),
    },
    config: runtimeConfig,
    resources: options.resources,
    fullRefresh: options.fullRefresh,
    reconcileSchema: options.reconcileSchema,
    outputDir: options.outputDir,
    logFile: options.logFile,
    logFormat: options.logFormat,
    verbose: options.verbose,
    quiet: options.quiet,
    warehouse: options.warehouse,
    destinationWarehouse: options.destinationWarehouse,
    queryTag: options.queryTag,
    env: runtimeEnv,
  });
  pipelineOptions.declaredEnvNames = declaredEnvNames;
  if (options.maxRecords !== undefined) {
    pipelineOptions.limit = options.maxRecords;
  }
  // Programmatic callers do not have the CLI's stderr breadcrumb for raw
  // capture cleanup. Never retain source rows after failure/cancellation.
  pipelineOptions.preserveCaptureOnFailure = false;

  const invocationState = prepareInvocationState(project.projectRoot, options.state);
  if (invocationState.directory) {
    pipelineOptions.stateBackend = invocationState.directory;
  }

  let sequence = 0;
  let metrics = emptyPipelineRunMetrics();
  const errors: PipelineRunError[] = [];
  const redact = createPipelineRedactor([
    ...Object.values(options.env ?? {}),
    pipelineOptions.bqAccessToken,
    pipelineOptions.sfPassword,
    pipelineOptions.sfAccessToken,
    pipelineOptions.sfTokenCommand,
    pipelineOptions.sfWorkloadIdentityToken,
    pipelineOptions.sfPrivateKeyPassphrase,
    pipelineOptions.postgresPassword,
    pipelineOptions.mysqlPassword,
    pipelineOptions.clickhousePassword,
    pipelineOptions.turbopufferApiKey,
    ...(pipelineOptions.destinations ?? []).flatMap((destination) =>
      Object.entries(destination)
        .filter(([key]) => /password|passphrase|token|secret|api_key/i.test(key))
        .map(([, value]) => (typeof value === 'string' ? value : undefined))
    ),
  ]);
  const warnings: string[] = project.warnings.map(redact);
  let invocationStateCleaned = false;
  const cleanupInvocationState = (): void => {
    if (!invocationState.directory || invocationStateCleaned) return;
    try {
      fs.rmSync(invocationState.directory, { force: true, recursive: true });
      invocationStateCleaned = true;
    } catch (error) {
      const warning = redact(
        `Failed to clean pipeline state directory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  };
  try {
    const startedAt = new Date();
    const emit = (event: PipelineRunEventInput): void => {
      const completeEvent = deepFreeze({
        ...event,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        pipelineName: pipeline.name,
      }) as PipelineRunEvent;
      try {
        options.onEvent?.(completeEvent);
      } catch (error) {
        const warning = redact(
          `Pipeline event callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
      }
    };

    emit({ type: 'run_started', resources: [...resourceNames] });
    let exitCode = 1;
    let activeStage: PipelineExecutionStage | undefined;
    try {
      exitCode = await runPipeline(resourceNames, pipelineOptions, {
        ...(dependencies.spawn ? { spawn: dependencies.spawn } : {}),
        ...(dependencies.metaUrl ? { metaUrl: dependencies.metaUrl } : {}),
        cwd: project.projectRoot,
        env: runtimeEnv,
        ...(options.signal ? { signal: options.signal } : {}),
        onStage(stage, status) {
          activeStage = status === 'started' ? stage : activeStage;
          emit({ type: status === 'started' ? 'stage_started' : 'stage_completed', stage });
        },
        onSummary(stage, summary) {
          metrics = pipelineRunMetricsFromSummary(summary, pipeline.source, redact);
          emit({ type: 'progress', stage, metrics: structuredClone(metrics) });
        },
      } satisfies PipelineDependencies);
    } catch (error) {
      errors.push({
        code: 'RUNTIME_ERROR',
        message: redact(error instanceof Error ? error.message : String(error)),
        ...(activeStage ? { stage: activeStage } : {}),
      });
    }

    let status: RunProjectPipelineResult['status'] =
      options.signal?.aborted && exitCode !== 0
        ? 'cancelled'
        : exitCode === 0 && errors.length === 0
          ? 'success'
          : 'failure';
    for (const [resource, resourceMetrics] of Object.entries(metrics.resources)) {
      if (resourceMetrics.error) {
        errors.push({
          code: 'PIPELINE_FAILED',
          message: resourceMetrics.error,
          resource,
          ...(resourceMetrics.cause ? { cause: structuredClone(resourceMetrics.cause) } : {}),
        });
      }
    }
    if (status === 'failure' && errors.length === 0) {
      errors.push({ code: 'PIPELINE_FAILED', message: `Pipeline exited with code ${exitCode}.` });
    }
    let resultingState = invocationState.state;
    if (invocationState.directory && invocationState.state) {
      try {
        resultingState = readInvocationState(invocationState.directory, invocationState.state);
      } catch (error) {
        errors.push({
          code: 'STATE_READ_FAILED',
          message: redact(error instanceof Error ? error.message : String(error)),
          stage: 'state',
        });
      }
    }
    if (status === 'success' && errors.length > 0) {
      status = 'failure';
    }
    if (status !== 'success') {
      metrics = {
        ...metrics,
        resources: Object.fromEntries(
          Object.entries(metrics.resources).map(([resource, resourceMetrics]) => [
            resource,
            resourceMetrics.status === 'success'
              ? { ...resourceMetrics, status: 'unknown' as const }
              : resourceMetrics,
          ])
        ),
      };
    }

    const completedAt = new Date();
    cleanupInvocationState();
    emit({ type: 'run_completed', status, exitCode, metrics: structuredClone(metrics) });

    return {
      exitCode,
      status,
      pipelineName: pipeline.name,
      resources: resourceNames,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      metrics,
      errors,
      warnings,
      ...(resultingState ? { state: resultingState } : {}),
    };
  } finally {
    cleanupInvocationState();
  }
}

interface BuildPipelineInvocationInput {
  pipeline: ResolvedPipeline;
  config: BobsledConfig;
  resources?: string[];
  fullRefresh?: boolean;
  reconcileSchema?: string[];
  outputDir?: string;
  logFile?: string;
  logFormat?: string;
  verbose?: boolean;
  quiet?: boolean;
  warehouse?: string;
  destinationWarehouse?: string;
  queryTag?: string;
  env: NodeJS.ProcessEnv;
}

function buildPipelineInvocation(input: BuildPipelineInvocationInput): {
  resourceNames: string[];
  pipelineOptions: PipelineOptions;
} {
  const { pipeline, config } = input;
  if (input.reconcileSchema?.length && !input.fullRefresh) {
    throw new CommandError(
      '--reconcile-schema requires fullRefresh: true so the extractor and loader both run a full refresh.',
      2
    );
  }
  const usesMultipleDestinations = pipeline.destinationNames.length > 1;
  const warehouse = input.warehouse ?? pipeline.warehouse;
  const destinationWarehouse = validateDestinationWarehouse(input.destinationWarehouse);
  const queryTag = validateQueryTag(input.queryTag);
  const workloadIdentitySourceEnvNames = getWorkloadIdentitySourceEnvNames(
    pipeline.destinationNames.map((name) => {
      const destination = config.destinations[name];
      return destination?.type === 'snowflake'
        ? destination.credentials_workload_identity_token
        : undefined;
    })
  );

  // Every per-resource override field is forwardable to the subprocesses:
  // `via` + `inputs` go to the extractor (`--resource-via`,
  // `--resource-inputs-json`), `load_strategy` + `schema_behavior` + `table`
  // go to the loader (`--stream-load-strategy`, `--stream-schema-behavior`,
  // `--stream-table`). `input.resources` is matched
  // against the authored token as well as the resolved name — callers pass
  // entity names (e.g. ['issues']), not resolved variant names.
  const matchesUserSelection = (resource: ResolvedResource): boolean => {
    if (!input.resources) return true;
    return (
      input.resources.includes(resource.name) ||
      (resource.requestedName !== undefined && input.resources.includes(resource.requestedName))
    );
  };
  if (input.resources !== undefined) {
    if (input.resources.length === 0) {
      throw new CommandError('Resource selection must contain at least one resource.', 2);
    }
    const duplicates = input.resources.filter(
      (name, index) => input.resources!.indexOf(name) !== index
    );
    if (duplicates.length > 0) {
      throw new CommandError(
        `Resource selection contains duplicate entries: ${[...new Set(duplicates)].join(', ')}.`,
        2
      );
    }
    const unknown = input.resources.filter(
      (name) =>
        !pipeline.resources.some(
          (resource) => resource.name === name || resource.requestedName === name
        )
    );
    if (unknown.length > 0) {
      const available = pipeline.resources.map(
        (resource) => resource.requestedName ?? resource.name
      );
      throw new CommandError(
        `Unknown resource selection: ${unknown.join(', ')}. Available: ${available.join(', ')}.`,
        2
      );
    }
  }

  // Translate user-supplied resource selections into resolved spec names. When
  // the caller passes entity names (`['issues']`) and the validator rewrote
  // them to variants (`issues_mcp`), the extractor needs the variant name —
  // strict-name passthrough still works because the rewrite preserves
  // requestedName=name when no entity resolution fires.
  const resourceNames = input.resources
    ? input.resources.map((name) => {
        const resource = pipeline.resources.find(
          (r) => r.name === name || r.requestedName === name
        );
        return resource?.name ?? name;
      })
    : pipeline.resources.map((resource) => resource.name);
  const duplicateResolvedNames = resourceNames.filter(
    (name, index) => resourceNames.indexOf(name) !== index
  );
  if (duplicateResolvedNames.length > 0) {
    throw new CommandError(
      `Resource selection resolves to duplicate resources: ${[
        ...new Set(duplicateResolvedNames),
      ].join(', ')}.`,
      2
    );
  }
  if (input.resources) {
    const selectedNames = new Set(resourceNames);
    for (const resource of pipeline.resources) {
      if (!matchesUserSelection(resource) || !resource.forEachParent) continue;
      const parentResource = pipeline.resources.find(
        (candidate) =>
          candidate.name === resource.forEachParent ||
          candidate.requestedName === resource.forEachParent
      );
      const resolvedParent = parentResource?.name ?? resource.forEachParent;
      if (!selectedNames.has(resolvedParent)) {
        throw new CommandError(
          `Resource selection includes for_each child "${resource.requestedName ?? resource.name}" ` +
            `without its required parent "${parentResource?.requestedName ?? resource.forEachParent}". ` +
            `Select both resources so the extractor can populate the parent cache.`,
          2
        );
      }
    }
  }

  let reconcileSchema: string[] | undefined;
  if (input.reconcileSchema !== undefined) {
    if (input.reconcileSchema.length === 0) {
      throw new CommandError(
        'Schema reconciliation selection must contain at least one stream.',
        2
      );
    }
    const duplicateRequested = input.reconcileSchema.filter(
      (name, index) => input.reconcileSchema!.indexOf(name) !== index
    );
    if (duplicateRequested.length > 0) {
      throw new CommandError(
        `Schema reconciliation selection contains duplicate entries: ${[
          ...new Set(duplicateRequested),
        ].join(', ')}.`,
        2
      );
    }
    const unknown = input.reconcileSchema.filter(
      (name) =>
        !pipeline.resources.some(
          (resource) => resource.name === name || resource.requestedName === name
        )
    );
    if (unknown.length > 0) {
      const available = pipeline.resources.map(
        (resource) => resource.requestedName ?? resource.name
      );
      throw new CommandError(
        `Unknown schema reconciliation stream selection: ${unknown.join(', ')}. ` +
          `Available: ${available.join(', ')}.`,
        2
      );
    }
    reconcileSchema = input.reconcileSchema.map((name) => {
      const resource = pipeline.resources.find(
        (candidate) => candidate.name === name || candidate.requestedName === name
      );
      return resource?.name ?? name;
    });
    const duplicateResolved = reconcileSchema.filter(
      (name, index) => reconcileSchema!.indexOf(name) !== index
    );
    if (duplicateResolved.length > 0) {
      throw new CommandError(
        `Schema reconciliation selection resolves to duplicate resources: ${[
          ...new Set(duplicateResolved),
        ].join(', ')}.`,
        2
      );
    }
    const selectedNames = new Set(resourceNames);
    const unselected = reconcileSchema.filter((name) => !selectedNames.has(name));
    if (unselected.length > 0) {
      throw new CommandError(
        `Schema reconciliation stream(s) must be included in the selected resources: ${unselected.join(', ')}.`,
        2
      );
    }
  }
  // Per-resource overrides, keyed by the RESOLVED spec name (post entity-variant
  // rewrite). That name is what the extractor's resource loop matches on and
  // what the extractor emits as the protocol stream name, so the same key works
  // for both subprocesses. Only overrides on selected resources are forwarded —
  // a caller-supplied `resources` list narrows the run, and an override for a
  // resource that is not running has nothing to apply to.
  const resourceVia: Record<string, string> = {};
  const resourceLoadStrategy: Record<string, NonNullable<PipelineOptions['loadStrategy']>> = {};
  const resourceSchemaBehavior: Record<string, NonNullable<PipelineOptions['schemaBehavior']>> = {};
  const resourceTable: Record<string, string> = {};
  const resourceTableOwnershipMarker: Record<string, string> = {};
  const resourceInputs: Record<string, Record<string, string>> = {};
  const resourceInputMatrices: Record<
    string,
    Array<Record<string, string | number | boolean>>
  > = {};
  const resourceInputMatrixConcurrency: Record<string, number> = {};
  for (const resource of pipeline.resources) {
    const override = resource.override;
    if (!override) continue;
    if (!matchesUserSelection(resource)) continue;
    if (override.via !== undefined) resourceVia[resource.name] = override.via;
    // An invocation-level full refresh is authoritative. Do not forward
    // authored per-stream strategies because the loader intentionally gives
    // them higher precedence than its global strategy.
    if (!input.fullRefresh && override.loadStrategy !== undefined) {
      resourceLoadStrategy[resource.name] = override.loadStrategy;
    }
    if (override.schemaBehavior !== undefined) {
      resourceSchemaBehavior[resource.name] = override.schemaBehavior;
    }
    if (override.table !== undefined) resourceTable[resource.name] = override.table;
    if (override.tableOwnershipMarker !== undefined) {
      if (override.table === undefined) {
        throw new CommandError(
          `Resource "${resource.name}" must set table with table_ownership_marker.`,
          2
        );
      }
      if (
        pipeline.destinationNames.length !== 1 ||
        !['snowflake', 'bigquery', 'databricks', 'postgres'].includes(
          config.destinations[pipeline.destinationNames[0]!]?.type ?? ''
        )
      ) {
        throw new CommandError(
          `Resource "${resource.name}" table_ownership_marker requires one supported warehouse destination.`,
          2
        );
      }
      resourceTableOwnershipMarker[resource.name] = override.tableOwnershipMarker;
    }
    if (override.inputs !== undefined) {
      resourceInputs[resource.name] = Object.fromEntries(
        Object.entries(override.inputs).map(([key, value]) => [
          key,
          serializeResourceInputValue(value),
        ])
      );
    }
    if (override.inputMatrix !== undefined) {
      resourceInputMatrices[resource.name] = expandInputMatrix(override.inputMatrix);
      resourceInputMatrixConcurrency[resource.name] = override.inputMatrix.concurrency;
    }
  }

  const pipelineOptions: PipelineOptions = {
    integration: pipeline.source,
    outputDir: input.outputDir ?? './output',
    ...(input.fullRefresh ? { fullRefresh: true } : {}),
    ...(reconcileSchema ? { reconcileSchema } : {}),
    ...(input.logFile ? { logFile: input.logFile } : {}),
    ...(input.logFormat ? { logFormat: input.logFormat } : {}),
    ...(input.verbose ? { verbose: true } : {}),
    ...(input.quiet ? { quiet: true } : {}),
    ...(input.fullRefresh
      ? { loadStrategy: 'full_refresh' as const }
      : pipeline.loadStrategy
        ? { loadStrategy: pipeline.loadStrategy }
        : {}),
    ...(pipeline.schemaBehavior ? { schemaBehavior: pipeline.schemaBehavior } : {}),
    ...(pipeline.tablePrefix ? { tablePrefix: pipeline.tablePrefix } : {}),
    ...(pipeline.bufferSize ? { bufferSize: pipeline.bufferSize } : {}),
    ...(pipeline.via ? { via: pipeline.via } : {}),
    ...(warehouse !== undefined ? { warehouse } : {}),
    ...(queryTag !== undefined ? { queryTag } : {}),
    ...(Object.keys(resourceVia).length > 0 ? { resourceVia } : {}),
    ...(Object.keys(resourceLoadStrategy).length > 0 ? { resourceLoadStrategy } : {}),
    ...(Object.keys(resourceSchemaBehavior).length > 0 ? { resourceSchemaBehavior } : {}),
    ...(Object.keys(resourceTable).length > 0 ? { resourceTable } : {}),
    ...(Object.keys(resourceTableOwnershipMarker).length > 0
      ? { resourceTableOwnershipMarker }
      : {}),
    ...(Object.keys(resourceInputs).length > 0 ? { resourceInputs } : {}),
    ...(Object.keys(resourceInputMatrices).length > 0 ? { resourceInputMatrices } : {}),
    ...(Object.keys(resourceInputMatrixConcurrency).length > 0
      ? { resourceInputMatrixConcurrency }
      : {}),
    ...(pipeline.inputs
      ? {
          input: Object.entries(pipeline.inputs).map(
            ([key, value]) => `${key}=${serializePipelineInputValue(key, value)}`
          ),
        }
      : {}),
    ...(pipeline.embed ? { embedConfigJson: JSON.stringify(pipeline.embed) } : {}),
    ...(workloadIdentitySourceEnvNames.length > 0 ? { workloadIdentitySourceEnvNames } : {}),
  };

  if (pipeline.destinationNames.length === 0) {
    throw new CommandError(
      `Pipeline "${pipeline.name}" has no destinations declared. Add a destination: <name> or destinations: [<name>, ...] entry.`,
      2
    );
  }

  if (usesMultipleDestinations) {
    if (destinationWarehouse !== undefined) {
      throw new CommandError(
        'destinationWarehouse is only supported for a singular materialized Snowflake destination.',
        2
      );
    }
    pipelineOptions.pipelineName = pipeline.name;
    const destinations = pipeline.destinationNames.map((name) => {
      const destination = config.destinations[name];
      if (!destination) {
        throw new CommandError(
          `Destination "${name}" referenced by pipeline "${pipeline.name}" is not defined in the destinations map.`,
          2
        );
      }
      return resolveNamedDestination(name, destination, input.env);
    });
    assertReconcileSchemaDestinations(reconcileSchema, destinations);
    pipelineOptions.destinations = destinations;
    return { resourceNames, pipelineOptions };
  }

  const destinationName = pipeline.destinationNames[0]!;
  const destination = config.destinations[destinationName];
  if (!destination) {
    throw new CommandError(
      `Destination "${destinationName}" referenced by pipeline "${pipeline.name}" is not defined in the destinations map.`,
      2
    );
  }

  Object.assign(
    pipelineOptions,
    resolveSingleDestinationOptions(
      destination,
      input.env,
      input.fullRefresh ? 'full_refresh' : pipeline.loadStrategy,
      pipeline.schemaBehavior,
      destinationWarehouse
    )
  );
  assertReconcileSchemaDestinations(reconcileSchema, [
    { name: destinationName, type: pipelineOptions.dest ?? 'local' },
  ]);

  return { resourceNames, pipelineOptions };
}

function validateDestinationWarehouse(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new CommandError('destinationWarehouse must be a non-empty string.', 2);
  }
  return value;
}

function serializeResourceInputValue(value: PipelineInputValue): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/**
 * The CLI→extractor input boundary today uses a comma-joined string for
 * array values (`--input key=v1,v2`). The extractor splits on the same
 * delimiter via `record_filters.delimiter`, which defaults to `,`. There is
 * no escaping contract on either side yet — a single comma in an array
 * element would silently round-trip as two separate entries downstream
 * (e.g. `["a,b", "c"]` would re-split into `["a", "b", "c"]`). Fail loud at
 * pipeline-resolution time instead of corrupting data.
 *
 * Per-resource `inputs:` overrides use the same value contract (they ride a
 * JSON envelope instead of `key=value` pairs, but the values themselves stay
 * byte-identical to `--input`), so they serialize through here too. `key` is a
 * diagnostic label: `<input>` for pipeline inputs, `<resource>.<input>` for
 * per-resource overrides.
 */
function serializePipelineInputValue(key: string, value: PipelineInputValue): string {
  if (!Array.isArray(value)) {
    return String(value);
  }
  return value
    .map((entry) => {
      const serialized = String(entry);
      if (serialized.includes(',')) {
        throw new CommandError(
          `Pipeline input "${key}" array entry ${JSON.stringify(entry)} contains a comma. ` +
            `Array inputs are serialized comma-delimited when forwarded to the extractor and ` +
            `do not support embedded commas. Drop the comma or pass the value as a string.`,
          2
        );
      }
      return serialized;
    })
    .join(',');
}

function resolveValue(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  label?: string
): string | undefined {
  return value === undefined ? undefined : resolveEnvPlaceholder(value, env, label);
}

function resolveNamedDestination(
  name: string,
  destination: DestinationConfig,
  env: NodeJS.ProcessEnv
): NamedDestination {
  assertDeclaredEnvironmentReferences(destination, destination.auth_env_vars);
  const resolve = (value: string | undefined) => resolveValue(value, env, `destination "${name}"`);
  switch (destination.type) {
    case 'duckdb':
      return {
        name,
        ...destination,
        db_path: resolve(destination.db_path)!,
        ...(destination.schema ? { schema: resolve(destination.schema)! } : {}),
      };
    case 'bigquery':
      return {
        name,
        ...destination,
        project: resolve(destination.project)!,
        dataset: resolve(destination.dataset)!,
        ...(destination.location ? { location: resolve(destination.location)! } : {}),
        ...(destination.credentials_access_token
          ? {
              credentials_access_token: resolve(destination.credentials_access_token)!,
            }
          : {}),
        ...(destination.credentials_token_command
          ? {
              credentials_token_command: resolve(destination.credentials_token_command)!,
            }
          : {}),
      };
    case 'snowflake':
      return {
        name,
        ...destination,
        account: resolve(destination.account)!,
        username: resolve(destination.username)!,
        warehouse: resolve(destination.warehouse)!,
        database: resolve(destination.database)!,
        ...(destination.password ? { password: resolve(destination.password)! } : {}),
        ...(destination.private_key_path
          ? { private_key_path: resolve(destination.private_key_path)! }
          : {}),
        ...(destination.private_key_passphrase
          ? {
              private_key_passphrase: resolve(destination.private_key_passphrase)!,
            }
          : {}),
        ...(destination.credentials_access_token
          ? {
              credentials_access_token: resolve(destination.credentials_access_token)!,
            }
          : {}),
        ...(destination.credentials_workload_identity_token !== undefined
          ? {
              credentials_workload_identity_token: resolve(
                destination.credentials_workload_identity_token
              )!,
            }
          : {}),
        ...(destination.credentials_token_command
          ? {
              credentials_token_command: resolve(destination.credentials_token_command)!,
            }
          : {}),
        ...(destination.schema ? { schema: resolve(destination.schema)! } : {}),
        ...(destination.role ? { role: resolve(destination.role)! } : {}),
      };
    case 'postgres':
      return {
        name,
        ...destination,
        host: resolve(destination.host)!,
        database: resolve(destination.database)!,
        username: resolve(destination.username)!,
        ...(destination.password ? { password: resolve(destination.password)! } : {}),
        ...(destination.schema ? { schema: resolve(destination.schema)! } : {}),
      };
    case 'databricks':
      return {
        name,
        ...destination,
        server_hostname: resolve(destination.server_hostname)!,
        http_path: resolve(destination.http_path)!,
        catalog: resolve(destination.catalog)!,
        schema: resolve(destination.schema)!,
      };
    case 'mysql':
      return {
        name,
        ...destination,
        host: resolve(destination.host)!,
        database: resolve(destination.database)!,
        user: resolve(destination.user)!,
        ...(destination.password ? { password: resolve(destination.password)! } : {}),
      };
    case 'clickhouse':
      return {
        name,
        ...destination,
        host: resolve(destination.host)!,
        database: resolve(destination.database)!,
        ...(destination.username ? { username: resolve(destination.username)! } : {}),
        ...(destination.password ? { password: resolve(destination.password)! } : {}),
      };
    case 'turbopuffer':
      return {
        name,
        ...destination,
        api_key: resolve(destination.api_key)!,
        ...(destination.region ? { region: resolve(destination.region)! } : {}),
        ...(destination.namespace_prefix
          ? { namespace_prefix: resolve(destination.namespace_prefix)! }
          : {}),
      };
    case 'local':
      return {
        name,
        ...destination,
        format: resolve(destination.format)! as 'parquet' | 'jsonl' | 'csv',
      };
    case 'gcs':
      return {
        name,
        ...destination,
        bucket: resolve(destination.bucket)!,
        ...(destination.prefix ? { prefix: resolve(destination.prefix)! } : {}),
        format: resolve(destination.format)! as 'parquet' | 'jsonl' | 'csv',
      };
    case 's3':
      return {
        name,
        ...destination,
        bucket: resolve(destination.bucket)!,
        ...(destination.prefix ? { prefix: resolve(destination.prefix)! } : {}),
        format: resolve(destination.format)! as 'parquet' | 'jsonl' | 'csv',
      };
    case 'dogsled_managed':
      throw new CommandError(MANAGED_DESTINATION_CORE_ERROR, 2);
  }
}

function fileDestinationOptions(
  destination: { stream_subfolder?: string | undefined },
  env: NodeJS.ProcessEnv
): Pick<PipelineOptions, 'streamSubfolder'> {
  return {
    ...(destination.stream_subfolder
      ? { streamSubfolder: resolveValue(destination.stream_subfolder, env)! }
      : {}),
  };
}

function resolveSingleDestinationOptions(
  destination: DestinationConfig,
  env: NodeJS.ProcessEnv,
  pipelineLoadStrategy?: PipelineOptions['loadStrategy'],
  pipelineSchemaBehavior?: PipelineOptions['schemaBehavior'],
  destinationWarehouse?: string
): Partial<PipelineOptions> {
  assertDeclaredEnvironmentReferences(destination, destination.auth_env_vars);
  if (destinationWarehouse !== undefined && destination.type !== 'snowflake') {
    throw new CommandError(
      'destinationWarehouse is only supported for a singular materialized Snowflake destination.',
      2
    );
  }
  const loadStrategy = pipelineLoadStrategy ?? destination.load_strategy;
  const loadStrategyOption = loadStrategy ? { loadStrategy } : {};
  const schemaBehavior = pipelineSchemaBehavior ?? destination.schema_behavior;
  const schemaBehaviorOption = schemaBehavior ? { schemaBehavior } : {};
  switch (destination.type) {
    case 'duckdb':
      return {
        dest: 'duckdb',
        dbPath: resolveValue(destination.db_path, env)!,
        ...(destination.schema ? { targetSchema: resolveValue(destination.schema, env)! } : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'databricks':
      return {
        dest: 'databricks',
        databricksHost: resolveValue(destination.server_hostname, env)!,
        databricksHttpPath: resolveValue(destination.http_path, env)!,
        databricksCatalog: resolveValue(destination.catalog, env)!,
        databricksSchema: resolveValue(destination.schema, env)!,
        ...(destination.credentials_access_token
          ? { databricksToken: destination.credentials_access_token }
          : {}),
        ...(destination.oauth_client_id
          ? { databricksOauthClientId: resolveValue(destination.oauth_client_id, env)! }
          : {}),
        ...(destination.oauth_client_secret
          ? { databricksOauthClientSecret: destination.oauth_client_secret }
          : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'bigquery':
      return {
        dest: 'bigquery',
        projectId: resolveValue(destination.project, env)!,
        datasetId: resolveValue(destination.dataset, env)!,
        ...(destination.location ? { location: resolveValue(destination.location, env)! } : {}),
        ...(destination.credentials_access_token
          ? { bqAccessToken: resolveValue(destination.credentials_access_token, env)! }
          : {}),
        ...(destination.credentials_token_command
          ? { bqTokenCommand: resolveValue(destination.credentials_token_command, env)! }
          : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'snowflake':
      return {
        dest: 'snowflake',
        sfAccount: resolveValue(destination.account, env)!,
        sfUsername: resolveValue(destination.username, env)!,
        sfWarehouse: destinationWarehouse ?? resolveValue(destination.warehouse, env)!,
        sfDatabase: resolveValue(destination.database, env)!,
        ...(destination.password ? { sfPassword: resolveValue(destination.password, env)! } : {}),
        ...(destination.private_key_path
          ? { sfPrivateKeyPath: resolveValue(destination.private_key_path, env)! }
          : {}),
        ...(destination.private_key_passphrase
          ? {
              sfPrivateKeyPassphrase: resolveValue(destination.private_key_passphrase, env)!,
            }
          : {}),
        ...(destination.credentials_access_token
          ? { sfAccessToken: resolveValue(destination.credentials_access_token, env)! }
          : {}),
        ...(destination.credentials_workload_identity_token !== undefined
          ? {
              sfWorkloadIdentityToken: resolveValue(
                destination.credentials_workload_identity_token,
                env
              )!,
            }
          : {}),
        ...(destination.credentials_token_command
          ? { sfTokenCommand: resolveValue(destination.credentials_token_command, env)! }
          : {}),
        ...(destination.schema ? { targetSchema: resolveValue(destination.schema, env)! } : {}),
        ...(destination.role ? { sfRole: resolveValue(destination.role, env)! } : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'postgres':
      return {
        dest: 'postgres',
        postgresHost: resolveValue(destination.host, env)!,
        postgresPort: destination.port,
        postgresDatabase: resolveValue(destination.database, env)!,
        postgresUser: resolveValue(destination.username, env)!,
        ...(destination.password
          ? { postgresPassword: resolveValue(destination.password, env)! }
          : {}),
        ...(destination.schema ? { postgresSchema: resolveValue(destination.schema, env)! } : {}),
        ...(destination.ssl ? { postgresSsl: true } : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'mysql':
      return {
        dest: 'mysql',
        mysqlHost: resolveValue(destination.host, env)!,
        mysqlPort: destination.port,
        mysqlDatabase: resolveValue(destination.database, env)!,
        mysqlUser: resolveValue(destination.user, env)!,
        ...(destination.password
          ? { mysqlPassword: resolveValue(destination.password, env)! }
          : {}),
        ...(destination.ssl ? { mysqlSsl: true } : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'clickhouse':
      return {
        dest: 'clickhouse',
        clickhouseHost: resolveValue(destination.host, env)!,
        clickhousePort: destination.port,
        clickhouseDatabase: resolveValue(destination.database, env)!,
        ...(destination.username
          ? { clickhouseUsername: resolveValue(destination.username, env)! }
          : {}),
        ...(destination.password
          ? { clickhousePassword: resolveValue(destination.password, env)! }
          : {}),
        ...(destination.ssl ? { clickhouseSsl: true } : {}),
        ...(destination.vector_index ? { clickhouseVectorIndex: true } : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'turbopuffer':
      return {
        dest: 'turbopuffer',
        turbopufferApiKey: resolveValue(destination.api_key, env)!,
        ...(destination.region
          ? { turbopufferRegion: resolveValue(destination.region, env)! }
          : {}),
        ...(destination.namespace_prefix
          ? { turbopufferNamespacePrefix: resolveValue(destination.namespace_prefix, env)! }
          : {}),
        ...(destination.distance_metric
          ? { turbopufferDistanceMetric: destination.distance_metric }
          : {}),
        ...(destination.full_text_columns?.length
          ? { turbopufferFullTextColumns: destination.full_text_columns.join(',') }
          : {}),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'local':
      return {
        dest: 'local',
        format: resolveValue(destination.format, env)!,
        ...fileDestinationOptions(destination, env),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'gcs':
      return {
        dest: 'gcs',
        format: resolveValue(destination.format, env)!,
        gcsBucket: resolveValue(destination.bucket, env)!,
        ...(destination.prefix ? { gcsPrefix: resolveValue(destination.prefix, env)! } : {}),
        ...fileDestinationOptions(destination, env),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 's3':
      return {
        dest: 's3',
        format: resolveValue(destination.format, env)!,
        s3Bucket: resolveValue(destination.bucket, env)!,
        ...(destination.prefix ? { s3Prefix: resolveValue(destination.prefix, env)! } : {}),
        ...fileDestinationOptions(destination, env),
        ...loadStrategyOption,
        ...schemaBehaviorOption,
      };
    case 'dogsled_managed':
      throw new CommandError(MANAGED_DESTINATION_CORE_ERROR, 2);
  }
}
