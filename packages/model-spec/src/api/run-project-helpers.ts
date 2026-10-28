import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';

import {
  normalizeIncrementalFilterForState,
  normalizeUniqueKeyForState,
  stateKey,
  type CurrentRunConfigSnapshot,
  type ModelExecutionResult,
  type ModelRunState,
  type RunState,
  type SqlRunner,
  type SupportedDialect,
} from '../compiler/index.js';
import { createSchemaIfNotExistsStatement } from '../compiler/dialect.js';

import type { IntegrationCompileContext } from './integration-context.js';
import type { SelectStateColumn } from '../compiler/state.js';

type PlannedConfigSnapshot = Pick<
  ModelRunState,
  | 'strategy'
  | 'uniqueKey'
  | 'incrementalFilter'
  | 'onSchemaChange'
  | 'targetSchema'
  | 'targetDatabase'
  | 'priorFqName'
>;

export type BuiltConfigSnapshot = PlannedConfigSnapshot & {
  targetSchema: string;
  priorFqName: string;
};

export interface PlannedMaterializedModel {
  node: IntegrationCompileContext['orderedNodes'][number];
  selectSignature: string;
  columns: SelectStateColumn[];
  configSnapshot: BuiltConfigSnapshot;
}

export interface PlannedPublishedModel extends PlannedMaterializedModel {
  targetHandle: string;
  targetSchema?: string;
  targetDatabase?: string;
  preDdl?: string[];
}

export function buildConfigSnapshot(args: {
  materialization: string;
  materializationConfig:
    | {
        strategy?: string;
        unique_key?: string | string[];
        incremental_filter?: string;
        authored_incremental_filter?: string;
        on_schema_change?: string;
      }
    | undefined;
  effectiveSchema: string;
  effectiveDatabase: string | undefined;
  fqName: string;
}): BuiltConfigSnapshot {
  const snapshot: BuiltConfigSnapshot = {
    targetSchema: args.effectiveSchema,
    priorFqName: args.fqName,
  };
  if (args.effectiveDatabase !== undefined) snapshot.targetDatabase = args.effectiveDatabase;

  const config = args.materializationConfig;
  if (args.materialization === 'incremental') {
    snapshot.strategy = config?.strategy ?? 'merge';
    const filter = normalizeIncrementalFilterForState(
      config?.authored_incremental_filter ?? config?.incremental_filter
    );
    if (filter !== undefined) snapshot.incrementalFilter = filter;
  }
  if (args.materialization === 'incremental' || args.materialization === 'snapshot') {
    const uniqueKey = normalizeUniqueKeyForState(config?.unique_key);
    if (uniqueKey !== undefined) snapshot.uniqueKey = uniqueKey;
    snapshot.onSchemaChange = config?.on_schema_change ?? 'fail';
  }
  return snapshot;
}

export function toCurrentRunSnapshot(
  snapshot: BuiltConfigSnapshot,
  materialization: string
): CurrentRunConfigSnapshot {
  const result: CurrentRunConfigSnapshot = {
    materialization,
    targetSchema: snapshot.targetSchema,
    fqName: snapshot.priorFqName,
  };
  if (snapshot.strategy !== undefined) result.strategy = snapshot.strategy;
  if (snapshot.uniqueKey !== undefined) result.uniqueKey = snapshot.uniqueKey;
  if (snapshot.incrementalFilter !== undefined) {
    result.incrementalFilter = snapshot.incrementalFilter;
  }
  if (snapshot.onSchemaChange !== undefined) result.onSchemaChange = snapshot.onSchemaChange;
  if (snapshot.targetDatabase !== undefined) result.targetDatabase = snapshot.targetDatabase;
  return result;
}

export function emitDriftWarning(
  handle: string,
  modelName: string,
  changes: string[] | undefined,
  warnings: string[],
  onWarn: ((msg: string) => void) | undefined
): void {
  if (!changes || changes.length === 0) return;
  const message = `[${handle}] ${modelName}: config drift — ${changes.join(', ')}; rebuilding destination.`;
  warnings.push(message);
  onWarn?.(message);
}

export function findBlockedDependency(
  model: PlannedPublishedModel,
  executionResults: ModelExecutionResult[]
): { name: string; status: 'failed' | 'skipped' | 'cancelled' } | undefined {
  const blocked = new Map<string, 'failed' | 'skipped' | 'cancelled'>();
  for (const result of executionResults) {
    if (
      result.status === 'failed' ||
      result.status === 'skipped' ||
      result.status === 'cancelled'
    ) {
      blocked.set(result.modelName.toLowerCase(), result.status);
    }
  }
  for (const ref of model.node.refs) {
    const status = blocked.get(ref.toLowerCase());
    if (status) return { name: ref, status };
  }
  return undefined;
}

export function toModelMetadata(
  handle: string,
  models: Array<PlannedMaterializedModel | PlannedPublishedModel>,
  state: RunState
): Array<{ name: string; materializationType: string; lastRunAt?: string }> {
  return models.map((entry) => {
    const stateHandle = 'targetHandle' in entry ? entry.targetHandle : handle;
    const current = state.models[stateKey(stateHandle, entry.node.name)];
    return {
      name: entry.node.name,
      materializationType: entry.node.materialization,
      lastRunAt: current?.lastRunAt,
    };
  });
}

interface SchemaBootstrapCallbacks {
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string) => void;
}

export async function ensureTargetSchemasExist(
  materializedModels: PlannedMaterializedModel[],
  dialect: SupportedDialect,
  run: SqlRunner,
  callbacks: SchemaBootstrapCallbacks = {},
  warnings?: string[],
  signal?: AbortSignal
): Promise<void> {
  const seen = new Set<string>();
  for (const model of materializedModels) {
    throwIfCancelled(signal);
    const { targetSchema, targetDatabase } = model.configSnapshot;
    const dedupeKey = `${targetDatabase ?? ''} ${targetSchema}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const sql = createSchemaIfNotExistsStatement(targetSchema, dialect, targetDatabase);
    callbacks.onInfo?.(`Ensuring schema exists: ${sql}`);
    try {
      if (signal) await run(sql, { signal });
      else await run(sql);
    } catch (error) {
      if (isCancellationError(error, signal)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Could not ensure schema exists (${sql}): ${message}. Proceeding; model execution will fail if the schema is actually missing.`;
      callbacks.onWarn?.(warning);
      warnings?.push(warning);
    }
  }
}

export interface CancellationResultContext {
  handle: string;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  statements: import('../compiler/index.js').SqlStatement[];
  plannedModels: Array<PlannedMaterializedModel | PlannedPublishedModel>;
  executionResults: ModelExecutionResult[];
  state: RunState;
  completedStateKeys: ReadonlySet<string>;
}

export function buildCancelledIntegrationResult(context: CancellationResultContext): {
  handle: string;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  statements: import('../compiler/index.js').SqlStatement[];
  models: Array<{ name: string; materializationType: string; lastRunAt?: string }>;
  executionResults: ModelExecutionResult[];
} {
  const plannedByName = new Map(context.plannedModels.map((model) => [model.node.name, model]));
  // A warehouse statement can return success immediately before cancellation
  // interrupts post-write verification. Until this invocation advances state,
  // that model is not complete under runProject's contract, so replace the
  // provisional success with a single cancelled result. Checking the current
  // state object alone is insufficient because it may contain a successful
  // entry from an earlier invocation. Preserve only successes whose state key
  // was committed during this run (for example before a later publisher was
  // cancelled).
  const reconciledResults = context.executionResults.filter((result) => {
    if (result.status !== 'success') return true;
    const planned = plannedByName.get(result.modelName);
    if (!planned) return true;
    const stateHandle = 'targetHandle' in planned ? planned.targetHandle : context.handle;
    return context.completedStateKeys.has(stateKey(stateHandle, result.modelName));
  });
  const completedNames = new Set(reconciledResults.map((result) => result.modelName));
  return {
    handle: context.handle,
    dialect: context.dialect,
    targetSchema: context.targetSchema,
    targetDatabase: context.targetDatabase,
    statements: context.statements,
    models: toModelMetadata(context.handle, context.plannedModels, context.state),
    executionResults: [
      ...reconciledResults,
      ...context.plannedModels
        .filter((model) => !completedNames.has(model.node.name))
        .map((model) => ({
          modelName: model.node.name,
          status: 'cancelled' as const,
          error: 'Cancelled before execution completed.',
        })),
    ],
  };
}
