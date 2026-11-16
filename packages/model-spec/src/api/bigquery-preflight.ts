import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';

import {
  getSourceEntry,
  type ModelExecutionResult,
  type ModelGuardFailure,
  type SqlRunnerModule,
  type SqlStatement,
} from '../compiler/index.js';

import {
  parseBigQueryTableRef,
  probeBigQueryRelations,
  sameBigQueryTable,
  type BigQueryTableRef,
} from './bigquery-catalog.js';
import { preflightBigQuerySourceSchemas } from './bigquery-source-schema.js';
import {
  collectModelRelationInputs,
  createDeferredModelGuard,
  planDeferredModels,
  plannedModelOrder,
} from './dag-preflight.js';
import type { IntegrationCompileContext } from './integration-context.js';

export interface BigQueryPreflightCallbacks {
  onInfo?: (msg: string) => void;
  onWarn?: (msg: string) => void;
  /** Models this integration publishes after its local SQL runs. */
  publishedModels?: readonly string[];
  /** Models that failed to plan in this run, so they are not built. */
  planFailedModels?: readonly string[];
}

export interface BigQueryPreflightResult {
  /** Up-front failures. Any entry means no model SQL may execute. */
  failures: ModelExecutionResult[];
  /** Models whose dry run waits until upstream models built by this run exist. */
  deferredModels: string[];
  /**
   * Executor guard that dry-runs each deferred model just before it executes.
   * Undefined when every model was dry-run up front.
   */
  beforeModel?: (modelName: string) => Promise<ModelGuardFailure | undefined>;
}

/**
 * BigQuery run preflight, ordered by the model DAG.
 *
 * Source tables are checked against INFORMATION_SCHEMA up front. Each model's
 * SQL is dry-run before it executes: up front when every relation it reads
 * already exists, otherwise immediately before that model runs, once the
 * upstream models built earlier in this run exist. No model executes without a
 * passing dry run.
 */
export async function preflightBigQueryPlan(
  ictx: IntegrationCompileContext,
  statements: SqlStatement[],
  runner: SqlRunnerModule,
  signal?: AbortSignal,
  callbacks: BigQueryPreflightCallbacks = {}
): Promise<BigQueryPreflightResult> {
  if (ictx.dialect !== 'bigquery') return { failures: [], deferredModels: [] };

  if (!runner.query) {
    return {
      failures: [
        {
          modelName: '__bigquery_preflight__',
          status: 'failed' as const,
          error:
            'BigQuery source-schema preflight requires a query-capable runner so Bobsled Core can inspect INFORMATION_SCHEMA.COLUMNS before executing model SQL.',
          exitCode: 2,
        },
      ],
      deferredModels: [],
    };
  }
  const query = runner.query;
  const handle = ictx.integration.handle;

  const order = plannedModelOrder(statements);
  const inRunRelations = new Map<string, BigQueryTableRef>();
  for (const model of order) {
    const fqName = ictx.modelReg.get(model);
    const tableRef = fqName ? parseBigQueryTableRef(fqName) : undefined;
    if (tableRef) inRunRelations.set(model, tableRef);
  }
  const sourceToInRunModel = (sourceRef: string): string | undefined => {
    const entry = getSourceEntry(ictx.entryRegistry, sourceRef);
    if (!entry || entry.kind !== 'warehouse_table') return undefined;
    const tableRef = parseBigQueryTableRef(entry.fqRef);
    if (!tableRef) return undefined;
    for (const [model, relation] of inRunRelations) {
      if (sameBigQueryTable(tableRef, relation)) return model;
    }
    return undefined;
  };

  const builtSourceReads = new Set<string>();
  const inputs = collectModelRelationInputs(ictx, statements, {
    sourceToInRunModel,
    onBuiltSource: (reader, sourceRef) => builtSourceReads.add(`${reader}\u0000${sourceRef}`),
    onLateSource: (model, sourceRef, producer) =>
      callbacks.onWarn?.(
        `[${handle}] Source ${sourceRef} reads the table built by model ${producer}, which runs ` +
          `after ${model}; use \`ref: ${producer}\` so ${model} runs after it.`
      ),
  });

  const sourceFailures = await preflightBigQuerySourceSchemas(
    ictx,
    query,
    signal,
    (reader, sourceRef) => builtSourceReads.has(`${reader.toLowerCase()}\u0000${sourceRef}`)
  );
  if (sourceFailures.length > 0) return { failures: sourceFailures, deferredModels: [] };

  // Probe the relations of upstream models: in-run ones decide deferral, and
  // external ones must already exist.
  const probe = new Map<string, BigQueryTableRef>();
  for (const modelInputs of inputs.values()) {
    for (const model of [...modelInputs.inRunModels, ...modelInputs.externalModels]) {
      const fqName = ictx.modelReg.get(model);
      const tableRef = fqName ? parseBigQueryTableRef(fqName) : undefined;
      if (tableRef) probe.set(model, tableRef);
    }
  }
  const existing = await probeBigQueryRelations(query, probe, signal, (message) =>
    callbacks.onWarn?.(`[${handle}] ${message}`)
  );
  const relationExists = (model: string): boolean => !existing || existing.has(model);

  const failures: ModelExecutionResult[] = [];
  const failedModels = new Set<string>();
  for (const model of order) {
    for (const upstream of inputs.get(model)?.externalModels ?? []) {
      if (relationExists(upstream) || !probe.has(upstream)) continue;
      failedModels.add(model);
      failures.push({
        modelName: model,
        status: 'failed',
        error: missingUpstreamMessage(model, upstream, ictx.modelReg.get(upstream), callbacks),
        exitCode: 2,
      });
    }
  }

  const deferred = planDeferredModels(order, inputs, relationExists);
  if (!runner.dryRun) return { failures, deferredModels: [] };
  const dryRun = runner.dryRun;

  const statementsByModel = new Map<string, SqlStatement[]>();
  for (const statement of statements) {
    const model = statement.modelName.toLowerCase();
    const list = statementsByModel.get(model) ?? [];
    list.push(statement);
    statementsByModel.set(model, list);
  }

  const dryRunModel = async (model: string): Promise<ModelGuardFailure | undefined> => {
    for (const statement of statementsByModel.get(model) ?? []) {
      // The preflight runs before the statement executes, so a cancellation
      // here must abort the run rather than be recorded as a dry-run failure.
      throwIfCancelled(signal);
      try {
        // Preserve the original call arity when the caller opted out of cancellation.
        if (signal) await dryRun(statement.sql, { signal });
        else await dryRun(statement.sql);
      } catch (err) {
        if (isCancellationError(err, signal)) throw err;
        return {
          error: `BigQuery dry run failed before execution: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 2,
        };
      }
    }
    return undefined;
  };

  for (const model of order) {
    if (failedModels.has(model) || deferred.has(model)) continue;
    const failure = await dryRunModel(model);
    if (failure) failures.push({ modelName: model, status: 'failed', ...failure });
  }
  if (failures.length > 0) return { failures, deferredModels: [] };

  for (const [model, upstreams] of deferred) {
    callbacks.onInfo?.(
      `[${handle}] ${model} reads ${upstreams.join(', ')}, built earlier in this run; ` +
        'its BigQuery dry run will run just before it executes.'
    );
  }
  const beforeModel = createDeferredModelGuard(deferred, async (model) => {
    callbacks.onInfo?.(`[${handle}] Dry-running ${model} now that its upstream models exist...`);
    return dryRunModel(model);
  });
  return {
    failures,
    deferredModels: [...deferred.keys()],
    ...(beforeModel ? { beforeModel } : {}),
  };
}

export function missingUpstreamMessage(
  model: string,
  upstream: string,
  fqName: string | undefined,
  options: BigQueryPreflightCallbacks
): string {
  const prefix = `BigQuery preflight failed for ${model}: upstream model ${upstream} (${fqName}) does not exist`;
  const matches = (names: readonly string[] | undefined): boolean =>
    names?.some((name) => name.toLowerCase() === upstream) ?? false;
  if (matches(options.planFailedModels)) {
    return `${prefix} and failed to plan in this run; see its error, fix it, then rerun.`;
  }
  if (matches(options.publishedModels)) {
    return (
      `${prefix}. It is published after this integration's local SQL runs, so build it ` +
      `in a previous run (bobsled model run ${upstream}) before ${model}.`
    );
  }
  return (
    `${prefix} and this run does not build it before ${model}. ` +
    `Run ${upstream} first, or include it in the selection (for example +${model}).`
  );
}
