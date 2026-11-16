import type { AgenticRunOptions } from '../agentic/run.js';
/**
 * `runProject` — Layer 3 orchestrator for `bobsled model run`.
 *
 * Accepts a Model Spec project directory (or pre-loaded `LoadedProject`) and executes
 * every referenced integration's materialized models via its resolved runner.
 * Side effects limited to runner I/O + state-file writes (both optional);
 * stdout output stays in the CLI handler.
 *
 * Preserves the multi-integration state-key migration from `commands/run.ts` —
 * a pre-multi-integration Model Spec run-state is detected and cleared with a
 * warning, and the next run behaves as `--full-refresh`.
 */

import type { ExperimentalAgenticProbe } from '../agentic/probe.js';
import { runAgenticProject } from './run-agentic-project.js';
import {
  createTokenCommandProvider,
  interpolateSecrets,
  withDeclaredSecretNames,
  isCancellationError,
  resolveRunner,
  validateQueryTag,
  type BigQueryTokenProvider,
  type CustomRunnerRegistry,
  type SecretResolver,
} from '@bobsled-inc/connections';

import {
  computeChecksum,
  computeSelectState,
  dropStatementForMaterialization,
  executeSqlStatements,
  generateSelectSql,
  getExecutionEngine,
  isFirstRun,
  loadState,
  materializeSql,
  materializeMatchKeySecretPlaceholders,
  planConfigDrift,
  planSchemaChange,
  planTransition,
  parseTransformSpecFromParsed,
  saveState,
  stateKey,
  trackEphemeralModel,
  type ModelExecutionResult,
  type RunState,
  type SqlStatement,
  type SupportedDialect,
} from '../compiler/index.js';
import { buildFqName, buildFqNameWithDatabase } from '../compiler/dialect.js';
import { buildSecretResolver } from '../integrations.js';
import { CommandError } from '../errors.js';

import type { IntegrationCompileContext } from './integration-context.js';
import { preflightBigQueryPlan } from './bigquery-preflight.js';
import { verifyViewsWritten } from './view-write-verify.js';
import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';
import {
  buildCancelledIntegrationResult,
  buildConfigSnapshot,
  emitDriftWarning,
  ensureTargetSchemasExist,
  findBlockedDependency,
  toCurrentRunSnapshot,
  toModelMetadata,
  type PlannedMaterializedModel,
  type PlannedPublishedModel,
} from './run-project-helpers.js';
import { warnLegacySettings } from '@bobsled-inc/protocol';

export type { PlannedPublishedModel } from './run-project-helpers.js';

export interface RunProjectOptions {
  /** Explicit non-durable host capability for the bounded fake executor proof. */
  experimentalAgenticProbe?: ExperimentalAgenticProbe;
  /** Durable agentic run identity and optional host checkpoint store. */
  agentic?: AgenticRunOptions;
  /** Narrow to a single integration handle. Omit for fan-out. */
  integration?: string;
  /**
   * Model selection — dbt-style selector tokens (`X`, `+X`, `X+`, `+X+`,
   * `tag:foo`) resolved by `@bobsled-inc/model-spec/selection`. A bare name
   * selects EXACTLY that model (no upstream closure). Omit for all models.
   */
  models?: string[];
  /**
   * Force full refresh (CREATE TABLE) for the models in the resolved selection.
   * Scoped to the selection — models outside `models` keep their prior state.
   */
  fullRefresh?: boolean;
  /** Build the plan without opening runners or persisting state. */
  dryRun?: boolean;
  /**
   * Path to a flat YAML map overlaying env-var values for secret resolution.
   * Ignored when `secretResolver` is explicitly provided.
   */
  secrets?: string;
  /** Caller-provided secret resolver. Takes precedence over `secrets`. */
  secretResolver?: SecretResolver;
  declaredSecretNames?: readonly string[];
  /**
   * Flat secret map (e.g. `{ MY_API_TOKEN: '...' }`) handed to the API fetch
   * when a published model stages an `api_resource` leaf. Lets a programmatic
   * host application supply API credentials instead of relying on
   * `process.env`. Forwarded to the cross-warehouse publisher.
   */
  apiSecrets?: Record<string, string | undefined>;
  /** Runner registry for dialect/auth combos without a built-in runner. */
  customRunners?: CustomRunnerRegistry;
  /**
   * Refreshable managed-credential provider. When set, the resolved warehouse
   * runner re-mints the orchestrator's short-lived token mid-run (proactively
   * before expiry, reactively on a 401) so a multi-hour model run does not die
   * when the ~1h token lapses. Takes precedence over `credentialsTokenCommand`.
   */
  tokenProvider?: BigQueryTokenProvider;
  /**
   * Shell command that prints a fresh `{"access_token","expires_at"}` token —
   * the SAME `credentials_token_command` the loader consumes. Converted to a
   * {@link tokenProvider} when one isn't supplied directly. Used by the Bobsled Core
   * CLI to forward `credentials_token_command` from bobsled.yml to model runs.
   */
  credentialsTokenCommand?: string;
  /**
   * Pipeline-level warehouse selector for the run. Custom runners receive the
   * stable selector unchanged; Bobsled Core's built-in Snowflake runner resolves it
   * through `connection.warehouses` when that map is declared. One per run —
   * warehouse selection is pipeline-grained only. Does not affect
   * dynamic-table DDL (`targetWarehouse`).
   */
  warehouse?: string;
  /**
   * Trusted, per-run query metadata forwarded to the resolved runner. For
   * Snowflake this becomes the session `QUERY_TAG`; it is not integration YAML.
   */
  queryTag?: string;
  /**
   * Optional host-provided publisher for models that set `publish:`.
   * `@bobsled-inc/model-spec` stays loader-free; the Bobsled Core CLI injects the
   * implementation that stages foreign sources and writes the target warehouse.
   */
  crossWarehousePublisher?: (
    model: PlannedPublishedModel,
    context: CrossWarehousePublishContext
  ) => Promise<CrossWarehousePublishResult>;
  /** Pre-loaded project to reuse. */
  project?: LoadedProject;
  /**
   * Prior `RunState` supplied in-memory. Presence (not truthiness — `{ models: {} }`
   * is a valid value meaning "first run") flips Bobsled Core into programmatic mode:
   * `.bobsled/model-spec/run-state.json` is neither read nor written. The new state is returned
   * on `result.state` for the caller to persist.
   *
   * Combined with `fullRefresh: true`, the supplied state is preserved on the
   * read side; full-refresh is scoped to the resolved selection, so only the
   * selected models are forced to first-run while every other supplied state
   * entry survives into `result.state`. The on-disk file is still skipped.
   *
   * `RunState` is a JSON-compatible plain object — callers can JSON.stringify
   * it for persistence and JSON.parse it back on the next invocation.
   */
  state?: RunState;
  /**
   * Cooperative cancellation for the whole run.
   *
   * Semantics, in the order they are enforced:
   *   - an ALREADY-aborted signal returns before any warehouse work starts — no
   *     project load, no secret resolution, no runner opened, no statement sent;
   *   - an abort mid-statement reaches the active runner operation, which asks
   *     the driver to cancel it (`interrupt()` / `job.cancel()` /
   *     `statement.cancel()` / `operation.cancel()` / `pg_cancel_backend`);
   *   - no later statement, integration, or published model begins;
   *   - cancelled models are reported `status: 'cancelled'` and never advance
   *     run state. Models that genuinely completed BEFORE the abort keep their
   *     state — the run is cancelled, not rolled back.
   *
   * The outcome is detectable without string matching: {@link RunProjectResult.cancelled}
   * is true and `ok` is false. Runners are always closed on the way out.
   */
  signal?: AbortSignal;
  /** Live progress callbacks mirroring the CLI's stderr output. */
  onInfo?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
  onWarn?: (msg: string) => void;
  verbose?: boolean;
}

export interface RunProjectModelMetadata {
  name: string;
  materializationType: string;
  lastRunAt?: string;
}

export interface RunProjectIntegrationResult {
  handle: string;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  /** The compile+materialize plan, in execution order. */
  statements: SqlStatement[];
  /**
   * Execution results. Present when `dryRun` is false and the runner resolved;
   * omitted when the plan is a dry run or runner resolution failed.
   */
  executionResults?: ModelExecutionResult[];
  /** Per-integration failure reason (runner dispatch or execution). */
  error?: string;
  /**
   * Models whose warehouse dry run waited until upstream models built earlier
   * in this run existed (BigQuery only). Omitted when none were deferred.
   */
  deferredModels?: string[];
  /** Per-model materialization metadata for agent-consumable output. */
  models: RunProjectModelMetadata[];
}

export interface RunProjectResult {
  ok: boolean;
  dryRun: boolean;
  byIntegration: RunProjectIntegrationResult[];
  /** Run-state snapshot after the run (or unchanged on dry run / no-op). */
  state: RunState;
  warnings: string[];
  /** Integrations declared but with no referencing model. */
  skipped: Array<{ handle: string; message: string }>;
  /**
   * True when {@link RunProjectOptions.signal} aborted and the run stopped
   * early. Always accompanied by `ok: false`.
   *
   * This is the stable, typed cancellation outcome: callers branch on it
   * instead of pattern-matching an error string, and a cancelled run is never
   * reported as an ordinary model failure. Per-model detail lives in
   * `byIntegration[].executionResults[].status === 'cancelled'`.
   */
  cancelled: boolean;
}

export interface CrossWarehousePublishContext {
  project: LoadedProject;
  state: RunState;
  fullRefresh?: boolean;
  secretResolver: SecretResolver;
  /** Flat API-secret map for staging an `api_resource` leaf (see RunProjectOptions). */
  apiSecrets?: Record<string, string | undefined>;
  customRunners?: CustomRunnerRegistry;
  /** Shared managed-credential provider for source/target publish runners. */
  tokenProvider?: BigQueryTokenProvider;
  /** Pipeline warehouse selector for the publish target session. */
  warehouse?: string;
  /** Trusted query metadata applied to every Snowflake session opened by the publish. */
  queryTag?: string;
  /**
   * Cooperative cancellation for the publish. The publisher must forward this to
   * every runner/loader operation it opens and settle with a `cancelled`
   * execution result rather than a failure — see
   * {@link RunProjectOptions.signal}.
   */
  signal?: AbortSignal;
  onInfo?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
  onWarn?: (msg: string) => void;
}

export interface CrossWarehousePublishResult {
  executionResult: ModelExecutionResult;
  publishedSnapshotId?: string;
  publishedAt?: string;
}

interface IntegrationPlan {
  ictx: IntegrationCompileContext;
  statements: SqlStatement[];
  materializedModels: PlannedMaterializedModel[];
  publishedModels: PlannedPublishedModel[];
  /**
   * Models that couldn't be planned because of an incompatible
   * materialization transition (`planTransition` returned `kind: 'fail'`) or
   * schema-drift failure (`planSchemaChange` with `on_schema_change: fail`).
   *
   * Surfaced as failed `ModelExecutionResult` rows in the per-integration
   * result so `bobsled model run --json` consumers see the suggested DROP
   * statement in the per-model `error` field instead of losing it to a
   * top-level `CommandError`. The caller is still responsible for translating
   * a non-empty `planFailures` into exit code 3.
   */
  planFailures: ModelExecutionResult[];
}

/**
 * Compile each referenced integration, execute its plan, and return structured
 * per-integration results. Throws `CommandError` only on non-recoverable
 * project-structure problems; runner and execution failures surface as
 * per-integration `error` fields with the top-level `ok` set to false.
 */
export async function runProject(
  cwd: string,
  opts: RunProjectOptions = {}
): Promise<RunProjectResult> {
  warnLegacySettings(opts.onWarn);
  if (opts.declaredSecretNames !== undefined) {
    opts = {
      ...opts,
      secretResolver: withDeclaredSecretNames(opts.secretResolver, opts.declaredSecretNames),
    };
  }
  const queryTag = validateQueryTag(opts.queryTag);
  // Requirement: an already-aborted signal must prevent warehouse execution
  // from STARTING. Checked before the project load so an aborted run touches
  // neither the filesystem nor any credential/runner path.
  if (opts.signal?.aborted) {
    return {
      ok: false,
      cancelled: true,
      dryRun: Boolean(opts.dryRun),
      byIntegration: [],
      state: opts.state ?? { models: {} },
      warnings: [],
      skipped: [],
    };
  }

  const project = opts.project ?? (await loadProject(cwd));

  const skipped: RunProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models: opts.models,
    onSkipped: (reason) => skipped.push(reason),
  });

  if (
    perIntegration.some((context) =>
      context.orderedNodes.some((node) => node.parsedSpec.model_kind === 'agentic')
    )
  ) {
    return runAgenticProject(project, perIntegration, opts, runProject);
  }

  // Load + migrate state once across all integrations. When `opts.state` is
  // supplied (programmatic mode), use it directly and skip the on-disk read.
  //
  // `--full-refresh` is SELECTION-SCOPED: it no longer wipes the whole state
  // object on the read side. Each model in the resolved selection is forced to
  // first-run inside `buildIntegrationPlan` (`firstRun = fullRefresh ||
  // isFirstRun(...)`), and because the plan only iterates the selected
  // `orderedNodes`, every model OUTSIDE the selection keeps its prior state.
  // So `model run X --full-refresh` rebuilds exactly X and leaves siblings'
  // run-state (and their incremental cursors) intact.
  const useProgrammaticState = opts.state !== undefined;
  const rawState: RunState = useProgrammaticState ? opts.state! : loadState(project.cwd);
  if (Object.keys(rawState.models).some((key) => !key.includes('.'))) {
    throw new CommandError('Run state keys must be scoped to an integration.', 2);
  }
  const state: RunState = rawState;
  // Record only state writes made by this invocation. Cancellation
  // reconciliation cannot infer completion from `state.models` because
  // programmatic callers may supply entries from earlier successful runs.
  const completedStateKeys = new Set<string>();
  const warnings: string[] = [...project.warnings];

  const plans: IntegrationPlan[] = perIntegration.map((ictx) =>
    buildIntegrationPlan(ictx, state, {
      fullRefresh: opts.fullRefresh,
      verbose: opts.verbose ?? false,
      warnings,
      onWarn: opts.onWarn,
    })
  );

  const totalStatements = plans.reduce((acc, p) => acc + p.statements.length, 0);
  const totalPublishedModels = plans.reduce((acc, p) => acc + p.publishedModels.length, 0);
  const anyPlanFailures = plans.some((p) => p.planFailures.length > 0);

  if (opts.dryRun || totalStatements + totalPublishedModels === 0) {
    return {
      ok: !anyPlanFailures,
      cancelled: false,
      dryRun: Boolean(opts.dryRun),
      byIntegration: plans.map((p) => {
        const handle = p.ictx.integration.handle;
        const plannedModels = [...p.materializedModels, ...p.publishedModels];
        const result: RunProjectIntegrationResult = {
          handle,
          dialect: p.ictx.dialect,
          targetSchema: p.ictx.targetSchema,
          targetDatabase: p.ictx.targetDatabase,
          statements: p.statements,
          models: toModelMetadata(handle, plannedModels, state),
        };
        if (p.planFailures.length > 0) {
          result.executionResults = [...p.planFailures];
          result.error = `${p.planFailures.length} model(s) failed to plan.`;
        }
        return result;
      }),
      state,
      warnings,
      skipped,
    };
  }

  const secretResolver =
    opts.secretResolver ?? (await buildSecretResolver(project.cwd, opts.secrets));
  // Refreshable managed credential — provider wins over the command string,
  // which in turn wins over the `BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND` env var. The
  // env fallback is how the standalone `bobsled model run` subprocess + the Cloud
  // Run Jobs executor receive the SAME `credentials_token_command` the loader
  // gets from bobsled.yml, without threading a flag through every CLI verb. Built
  // once per run and shared by every integration's runner. Undefined leaves the
  // runners on their static credentials (behaviour unchanged).
  const credentialsTokenCommand =
    opts.credentialsTokenCommand ?? process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
  const tokenProvider: BigQueryTokenProvider | undefined =
    opts.tokenProvider ??
    (credentialsTokenCommand ? createTokenCommandProvider(credentialsTokenCommand) : undefined);
  const byIntegration: RunProjectIntegrationResult[] = [];
  let ok = true;
  let cancelled = false;
  const signal = opts.signal;

  // Fail fast if any plan requires a cross-warehouse publisher and no callback
  // was injected. Otherwise we could execute local SQL for one integration and
  // then bail mid-run when the first published model is encountered, leaving
  // half-applied state across integrations.
  if (plans.some((p) => p.publishedModels.length > 0) && !opts.crossWarehousePublisher) {
    throw new CommandError(
      'cross-warehouse models require a publisher (Bobsled Core CLI provides this; programmatic callers must inject).',
      2
    );
  }

  for (const plan of plans) {
    // No later integration begins once the run has been cancelled.
    if (signal?.aborted) {
      cancelled = true;
      ok = false;
      break;
    }
    const { ictx, statements, materializedModels, publishedModels, planFailures } = plan;
    const handle = ictx.integration.handle;
    const plannedModels = [...materializedModels, ...publishedModels];

    if (statements.length === 0 && publishedModels.length === 0) {
      const result: RunProjectIntegrationResult = {
        handle,
        dialect: ictx.dialect,
        targetSchema: ictx.targetSchema,
        targetDatabase: ictx.targetDatabase,
        statements: [],
        models: [],
      };
      if (planFailures.length > 0) {
        ok = false;
        result.executionResults = [...planFailures];
        result.error = `${planFailures.length} model(s) failed to plan.`;
      }
      byIntegration.push(result);
      continue;
    }

    const executionResults: ModelExecutionResult[] = [...planFailures];
    let deferredModels: string[] = [];

    try {
      if (statements.length > 0) {
        const interpolated = await interpolateSecrets(ictx.integration.integration, secretResolver);

        let runnerModule;
        try {
          runnerModule = await resolveRunner(interpolated, {
            secretResolver,
            customRunners: opts.customRunners,
            warehouse: opts.warehouse,
            queryTag,
            tokenProvider,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ok = false;
          byIntegration.push({
            handle,
            dialect: ictx.dialect,
            targetSchema: ictx.targetSchema,
            targetDatabase: ictx.targetDatabase,
            statements,
            models: toModelMetadata(handle, plannedModels, state),
            executionResults: executionResults.length > 0 ? executionResults : undefined,
            error: `runner dispatch failed: ${message}`,
          });
          continue;
        }

        try {
          // dbt-parity: ensure the destination schema(s) exist before
          // materializing. Runs before the BigQuery preflight on purpose —
          // that preflight dry-runs each CREATE TABLE, which BigQuery rejects
          // with "Not found: Dataset" until the destination dataset exists.
          await ensureTargetSchemasExist(
            materializedModels,
            ictx.dialect,
            runnerModule.run,
            { onInfo: opts.onInfo, onWarn: opts.onWarn },
            warnings,
            signal
          );

          // Models whose upstream is built by this run are dry-run just
          // before they execute, through the executor's `beforeModel` guard.
          const preflight = await preflightBigQueryPlan(ictx, statements, runnerModule, signal, {
            onInfo: opts.onInfo,
            onWarn: opts.onWarn,
            publishedModels: publishedModels.map((model) => model.node.name),
            planFailedModels: planFailures.map((failure) => failure.modelName),
          });
          deferredModels = preflight.deferredModels;
          const preflightFailures = preflight.failures;
          if (preflightFailures.length > 0) {
            ok = false;
            executionResults.push(...preflightFailures);
            byIntegration.push({
              handle,
              dialect: ictx.dialect,
              targetSchema: ictx.targetSchema,
              targetDatabase: ictx.targetDatabase,
              statements,
              models: toModelMetadata(handle, plannedModels, state),
              executionResults,
              error: `${preflightFailures.length} model(s) failed BigQuery preflight.`,
            });
            continue;
          }

          const executableStatements = statements.map((statement) => ({
            ...statement,
            sql: materializeMatchKeySecretPlaceholders(statement.sql, ictx.dialect),
          }));

          const results = await executeSqlStatements(executableStatements, runnerModule.run, {
            onInfo: opts.onInfo,
            onError: opts.onError,
            onSuccess: opts.onSuccess,
            ...(signal ? { signal } : {}),
            ...(preflight.beforeModel ? { beforeModel: preflight.beforeModel } : {}),
          });

          executionResults.push(...results);
          if (results.some((r) => r.status === 'cancelled')) {
            cancelled = true;
            ok = false;
          }

          // Verify that `view` materializations which reported success actually
          // landed in the warehouse. A thin DDL runner reports success on any
          // non-throwing run() without reading the object back, so a silent
          // no-op (swallowed/transient error, or stale input SQL right after a
          // deploy) would otherwise be recorded as success. Flip any missing
          // view to `failed` BEFORE the state-persistence loop below so its
          // stale success is never written to run state.
          const nonSuccessNames = new Set(
            results.filter((r) => r.status !== 'success').map((r) => r.modelName)
          );
          // Skip verification entirely on a cancelled run — it would issue fresh
          // catalog reads after the caller asked us to stop, and every cancelled
          // model is already excluded by `nonSuccessNames` anyway.
          const viewFailures = cancelled
            ? []
            : await verifyViewsWritten(
                ictx,
                materializedModels.filter((m) => !nonSuccessNames.has(m.node.name)),
                runnerModule,
                { onWarn: opts.onWarn },
                signal
              );
          for (const failure of viewFailures) {
            ok = false;
            const existing = results.find(
              (r) => r.modelName === failure.modelName && r.status === 'success'
            );
            if (existing) {
              existing.status = 'failed';
              existing.error = failure.error;
              existing.exitCode = failure.exitCode;
            } else {
              // Defensive: no matching success result (should not happen since we
              // only verify succeeded views). Surface it so it is not lost.
              executionResults.push(failure);
              results.push(failure);
            }
          }

          const failed = results.filter((r) => r.status === 'failed');
          if (failed.length > 0) ok = false;

          // Persist run state for models that succeeded.
          //
          // `cancelled` joins failed/skipped as a state-advancement blocker: a
          // statement the warehouse never finished must not look like a
          // completed run on the next invocation. An empty `nodeResults` is
          // treated the same way — a model whose statements never produced a
          // result did not run, so it has nothing to record.
          for (const model of materializedModels) {
            const node = model.node;
            const nodeResults = results.filter((r) => r.modelName === node.name);
            if (
              nodeResults.length === 0 ||
              nodeResults.some(
                (r) => r.status === 'failed' || r.status === 'skipped' || r.status === 'cancelled'
              )
            ) {
              continue;
            }
            const specContent = JSON.stringify(node.parsedSpec);
            const completedStateKey = stateKey(handle, node.name);
            state.models[completedStateKey] = {
              lastRunAt: new Date().toISOString(),
              materialization: node.materialization,
              specChecksum: computeChecksum(specContent),
              selectSignature: model.selectSignature,
              columns: model.columns,
              ...model.configSnapshot,
            };
            completedStateKeys.add(completedStateKey);
          }
        } finally {
          if (typeof runnerModule.close === 'function') {
            try {
              await runnerModule.close();
            } catch (err) {
              opts.onWarn?.(
                `[${handle}] Failed to close runner cleanly: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      }

      if (publishedModels.length > 0) {
        // crossWarehousePublisher presence verified above before any execution
        // started so we cannot leave partially-applied state across integrations.
        const publisher = opts.crossWarehousePublisher!;
        for (const model of publishedModels) {
          // No published model begins after cancellation. Publishing moves data
          // into a second warehouse, so starting one post-abort would be the
          // most expensive way to ignore the caller.
          if (cancelled || signal?.aborted) {
            cancelled = true;
            ok = false;
            executionResults.push({
              modelName: model.node.name,
              status: 'cancelled',
              error: 'Cancelled before publishing started.',
            });
            continue;
          }
          const blocked = findBlockedDependency(model, executionResults);
          if (blocked) {
            ok = false;
            executionResults.push({
              modelName: model.node.name,
              status: 'skipped',
              error: `Skipped: upstream "${blocked.name}" ${blocked.status === 'failed' ? 'failed' : 'was skipped'}`,
            });
            continue;
          }

          const publishResult = await publisher(model, {
            project,
            state,
            fullRefresh: opts.fullRefresh,
            secretResolver,
            apiSecrets: opts.apiSecrets,
            customRunners: opts.customRunners,
            tokenProvider,
            warehouse: opts.warehouse,
            queryTag,
            ...(signal ? { signal } : {}),
            onInfo: opts.onInfo,
            onSuccess: opts.onSuccess,
            onError: opts.onError,
            onWarn: opts.onWarn,
          });
          // Injected publishers may be legacy implementations that accept the
          // context but do not yet observe its signal. A success that arrives
          // after abort must not advance published state.
          if (signal?.aborted) {
            cancelled = true;
            ok = false;
            executionResults.push({
              modelName: model.node.name,
              status: 'cancelled',
              error: 'Cancelled before publishing completion was observed.',
            });
            continue;
          }
          executionResults.push(publishResult.executionResult);
          if (publishResult.executionResult.status === 'failed') {
            ok = false;
            continue;
          }
          if (publishResult.executionResult.status === 'cancelled') {
            cancelled = true;
            ok = false;
            continue;
          }
          if (publishResult.executionResult.status === 'skipped') {
            continue;
          }

          const specContent = JSON.stringify(model.node.parsedSpec);
          const nowIso = new Date().toISOString();
          const completedStateKey = stateKey(model.targetHandle, model.node.name);
          state.models[completedStateKey] = {
            lastRunAt: nowIso,
            materialization: model.node.materialization,
            specChecksum: computeChecksum(specContent),
            selectSignature: model.selectSignature,
            columns: model.columns,
            ...model.configSnapshot,
            publishedSnapshotId: publishResult.publishedSnapshotId,
            publishedAt: publishResult.publishedAt,
          };
          completedStateKeys.add(completedStateKey);
        }
      }

      if (planFailures.length > 0) ok = false;
      const totalFailed = executionResults.filter((r) => r.status === 'failed').length;
      byIntegration.push({
        handle,
        dialect: ictx.dialect,
        targetSchema: ictx.targetSchema,
        targetDatabase: ictx.targetDatabase,
        statements,
        executionResults,
        models: toModelMetadata(handle, plannedModels, state),
        error: totalFailed > 0 ? `${totalFailed} model(s) failed.` : undefined,
        ...(deferredModels.length > 0 ? { deferredModels } : {}),
      });
    } catch (err) {
      ok = false;
      // Cancellation surfaces as a cancelled integration, not a warehouse
      // error: reporting a misleading `error` string here is exactly the
      // "collapse cancellation into an ordinary failure" trap.
      if (isCancellationError(err, signal)) {
        cancelled = true;
        byIntegration.push(
          buildCancelledIntegrationResult({
            handle,
            dialect: ictx.dialect,
            targetSchema: ictx.targetSchema,
            targetDatabase: ictx.targetDatabase,
            statements,
            plannedModels,
            executionResults,
            state,
            completedStateKeys,
          })
        );
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      byIntegration.push({
        handle,
        dialect: ictx.dialect,
        targetSchema: ictx.targetSchema,
        targetDatabase: ictx.targetDatabase,
        statements,
        models: toModelMetadata(handle, plannedModels, state),
        executionResults: executionResults.length > 0 ? executionResults : undefined,
        error: message,
      });
    }
  }

  if (cancelled) {
    const accounted = new Set(byIntegration.map((result) => result.handle));
    for (const plan of plans) {
      if (accounted.has(plan.ictx.integration.handle)) continue;
      const plannedModels = [...plan.materializedModels, ...plan.publishedModels];
      byIntegration.push(
        buildCancelledIntegrationResult({
          handle: plan.ictx.integration.handle,
          dialect: plan.ictx.dialect,
          targetSchema: plan.ictx.targetSchema,
          targetDatabase: plan.ictx.targetDatabase,
          statements: plan.statements,
          plannedModels,
          executionResults: [...plan.planFailures],
          state,
          completedStateKeys,
        })
      );
    }
  }

  // Still persisted on a cancelled run: models that genuinely completed before
  // the abort keep their state (cancelled ones were never written above). A
  // cancel stops further work; it does not roll back finished work.
  if (!useProgrammaticState) {
    saveState(project.cwd, state);
  }

  return {
    ok,
    cancelled,
    dryRun: false,
    byIntegration,
    state,
    warnings,
    skipped,
  };
}

interface BuildIntegrationPlanOptions {
  fullRefresh: boolean | undefined;
  verbose: boolean;
  warnings: string[];
  onWarn?: (msg: string) => void;
}

/**
 * Build the DDL plan for a single integration's subgraph. Ephemeral models
 * are inlined as CTEs; materialized models contribute one or more DDL
 * statements to the returned plan.
 */
function buildIntegrationPlan(
  ictx: IntegrationCompileContext,
  state: RunState,
  options: BuildIntegrationPlanOptions
): IntegrationPlan {
  const { fullRefresh, verbose, warnings, onWarn } = options;
  const {
    dialect,
    targetSchema,
    targetDatabase,
    targetWarehouse,
    modelReg,
    orderedNodes,
    registry,
    entryRegistry,
    integration,
  } = ictx;
  const statements: SqlStatement[] = [];
  const materializedModels: IntegrationPlan['materializedModels'] = [];
  const publishedModels: IntegrationPlan['publishedModels'] = [];
  const planFailures: ModelExecutionResult[] = [];
  const ephemeralSqlMap = new Map<string, string>();
  const PERSISTED_PUBLISH_MATERIALIZATIONS = new Set(['table', 'incremental', 'snapshot']);

  for (const node of orderedNodes) {
    const parseResult = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
    if (!parseResult.ok) {
      throw new CommandError(`[${integration.handle}] ${node.name}: ${parseResult.error}`);
    }

    const { spec } = parseResult;

    // A warehouse `execution.engine` (without an explicit `publish:`) reuses the
    // cross-warehouse publish path: the engine is the declared co-location point
    // for a mixed model, so its foreign leaves stage into the engine and the
    // model materializes there. Only persisted materializations publish — a
    // `view`/`ephemeral` engine model is a live recompute handled outside this
    // block (the DuckDB live path). An explicit `publish:` always wins.
    const publishTarget =
      spec.publish ??
      (PERSISTED_PUBLISH_MATERIALIZATIONS.has(node.materialization)
        ? getExecutionEngine(node.parsedSpec.execution)
        : undefined);

    if (publishTarget) {
      const supportedPublishMaterializations = PERSISTED_PUBLISH_MATERIALIZATIONS;
      if (!supportedPublishMaterializations.has(node.materialization)) {
        throw new CommandError(
          [
            `[${integration.handle}] ${node.name}: publish: supports materialization.type: table, incremental, or snapshot.`,
            'view, materialized_view, dynamic_table, and ephemeral remain unsupported because',
            'they imply zero data movement and cannot be published into a separate warehouse.',
          ].join('\n'),
          2
        );
      }
      if (spec.includeAllColumns) {
        throw new CommandError(
          [
            `[${integration.handle}] ${node.name}: published models cannot use \`include_all_columns: true\`.`,
            'Enumerate output columns explicitly so Model Spec can stage and publish a stable schema.',
          ].join('\n'),
          2
        );
      }

      const key = stateKey(publishTarget, node.name);
      const previous = state.models[key];
      const selectState = computeSelectState(spec.columns);

      const effectiveSchema = spec.targetSchema ?? targetSchema;
      const effectiveDatabase = spec.targetDatabase ?? targetDatabase;
      const fqName = effectiveDatabase
        ? buildFqNameWithDatabase(effectiveSchema, spec.name, dialect, effectiveDatabase)
        : buildFqName(effectiveSchema, spec.name, dialect);

      const transitionDecision = planTransition(
        previous?.materialization,
        node.materialization,
        dialect,
        fqName,
        node.name
      );
      if (transitionDecision.kind === 'fail') {
        planFailures.push({
          modelName: node.name,
          status: 'failed',
          error: transitionDecision.message,
          exitCode: transitionDecision.exitCode,
        });
        continue;
      }

      const publishedConfigSnapshot = buildConfigSnapshot({
        materialization: node.materialization,
        materializationConfig: spec.materializationConfig,
        effectiveSchema,
        effectiveDatabase,
        fqName,
      });

      // Carry `recreate` preDdl through to the publisher. The destination
      // ictx already supplies the right dialect/schema/database because
      // `inferDagIntegrations` stamps published nodes with `spec.publish`, so
      // `fqName` above is already destination-quoted.
      const preDdl: string[] = [];
      if (transitionDecision.kind === 'recreate') {
        preDdl.push(...transitionDecision.preDdl);
      } else {
        // Config drift (strategy / unique_key / incremental_filter /
        // on_schema_change / target routing) — recreate at the prior fqName.
        // Skipped when planTransition already triggered a recreate; its DROP
        // covers the destination and a second one would be redundant.
        const driftDecision = planConfigDrift(
          previous,
          toCurrentRunSnapshot(publishedConfigSnapshot, node.materialization),
          node.name
        );
        if (driftDecision.kind === 'recreate') {
          preDdl.push(...driftDecision.preDdl);
          emitDriftWarning(publishTarget, node.name, driftDecision.changes, warnings, onWarn);
        }
      }

      publishedModels.push({
        node,
        targetHandle: publishTarget,
        targetSchema: spec.targetSchema,
        targetDatabase: spec.targetDatabase,
        selectSignature: selectState.signature,
        columns: selectState.columns,
        configSnapshot: publishedConfigSnapshot,
        preDdl: preDdl.length > 0 ? preDdl : undefined,
      });
      continue;
    }

    if (node.materialization === 'ephemeral') {
      const selectSql = generateSelectSql(spec, dialect, ephemeralSqlMap, { entryRegistry });
      trackEphemeralModel(node, selectSql, modelReg, ephemeralSqlMap);
      if (verbose) {
        /* intentionally silent in library; CLI layer surfaces through onInfo if needed */
      }
      continue;
    }

    const effectiveSchema = spec.targetSchema ?? targetSchema;
    const effectiveDatabase = spec.targetDatabase ?? targetDatabase;
    const fqName = effectiveDatabase
      ? buildFqNameWithDatabase(effectiveSchema, spec.name, dialect, effectiveDatabase)
      : buildFqName(effectiveSchema, spec.name, dialect);
    const key = stateKey(integration.handle, node.name);
    const previous = state.models[key];
    if (
      (node.materialization === 'incremental' || node.materialization === 'snapshot') &&
      spec.includeAllColumns
    ) {
      throw new CommandError(
        [
          `[${integration.handle}] ${node.name}: stateful materializations cannot use \`include_all_columns: true\`.`,
          'Enumerate output columns explicitly so Model Spec can compute schema-change signatures before incremental or snapshot runs.',
        ].join('\n'),
        2
      );
    }
    const selectState = computeSelectState(spec.columns);
    let firstRun = fullRefresh || isFirstRun(state, node.name, integration.handle);
    const configSnapshot = buildConfigSnapshot({
      materialization: node.materialization,
      materializationConfig: spec.materializationConfig,
      effectiveSchema,
      effectiveDatabase,
      fqName,
    });

    const transitionDecision = planTransition(
      previous?.materialization,
      node.materialization,
      dialect,
      fqName,
      node.name
    );
    if (transitionDecision.kind === 'fail') {
      if (firstRun) {
        // `--full-refresh` (the only way `firstRun` is forced while a prior
        // materialization exists) explicitly rebuilds from scratch. Drop the
        // incompatible prior object and recreate instead of hard-failing —
        // failing here would be a dead end, since the fail message's own
        // remediation is `--full-refresh`.
        statements.push({
          modelName: node.name,
          sql: dropStatementForMaterialization(
            previous?.materialization ?? node.materialization,
            fqName
          ),
          deps: node.refs,
        });
      } else {
        // Surface the DROP-statement-bearing message as a per-model failure so
        // `bobsled model run --json` consumers see it in `execution_results[].error`.
        // The integration is marked failed and the model is skipped from the plan;
        // downstream models that depend on it will fail at execution time, which
        // is the existing safety contract.
        planFailures.push({
          modelName: node.name,
          status: 'failed',
          error: transitionDecision.message,
          exitCode: transitionDecision.exitCode,
        });
        continue;
      }
    } else if (transitionDecision.kind === 'recreate') {
      for (const sql of transitionDecision.preDdl) {
        statements.push({ modelName: node.name, sql, deps: node.refs });
      }
      firstRun = true;
    } else if (!firstRun) {
      // Only check config drift when planTransition didn't already force a
      // recreate — its DROP already covers us. A separate drift recreate on
      // top would queue a redundant `DROP TABLE IF EXISTS` which is harmless
      // but noisy in the per-integration plan log. Skipped entirely under
      // `--full-refresh` (firstRun): the forced rebuild supersedes the prior
      // object, so a drift-recreate would be a redundant DROP and a spurious
      // "config drift" warning on a command whose whole job is to rebuild.
      const driftDecision = planConfigDrift(
        previous,
        toCurrentRunSnapshot(configSnapshot, node.materialization),
        node.name
      );
      if (driftDecision.kind === 'recreate') {
        for (const sql of driftDecision.preDdl) {
          statements.push({ modelName: node.name, sql, deps: node.refs });
        }
        emitDriftWarning(integration.handle, node.name, driftDecision.changes, warnings, onWarn);
        firstRun = true;
      }
    }

    if (
      !firstRun &&
      (node.materialization === 'incremental' || node.materialization === 'snapshot')
    ) {
      const mode = spec.materializationConfig?.on_schema_change ?? 'fail';
      const schemaDecision = planSchemaChange(
        node.name,
        previous?.selectSignature,
        selectState.signature,
        previous?.columns,
        selectState.columns,
        mode,
        node.materialization !== 'snapshot'
      );
      if (schemaDecision.kind === 'fail') {
        planFailures.push({
          modelName: node.name,
          status: 'failed',
          error: schemaDecision.message,
          exitCode: schemaDecision.exitCode,
        });
        continue;
      }
      if (schemaDecision.kind === 'full_refresh') {
        firstRun = true;
        const warning = `[${integration.handle}] ${node.name}: schema drift detected — rebuilding the table (\`on_schema_change: full_refresh\`). Prior data and history are discarded.`;
        warnings.push(warning);
        onWarn?.(warning);
      }
    }

    // Build SELECT after firstRun is finalized — both transition.recreate and
    // schema-change full_refresh promote firstRun to true, and the SELECT must
    // reflect that (incremental_filter is suppressed on full refresh; `self`
    // refs in the filter resolve to the target schema). The compile path goes
    // through `generateSql` which threads these args; the run path historically
    // omitted them, producing invalid SQL like `... FROM self WHERE ...`.
    const selectSql = generateSelectSql(spec, dialect, ephemeralSqlMap, {
      entryRegistry,
      targetSchema: effectiveSchema,
      targetDatabase: effectiveDatabase,
      isFullRefresh: firstRun,
    });

    materializedModels.push({
      node,
      selectSignature: selectState.signature,
      columns: selectState.columns,
      configSnapshot,
    });

    const ddlStatements = materializeSql(
      selectSql,
      spec,
      effectiveSchema,
      dialect,
      { isFirstRun: firstRun, defaultDynamicTableWarehouse: targetWarehouse },
      effectiveDatabase
    );

    for (const sql of ddlStatements) {
      statements.push({ modelName: node.name, sql, deps: node.refs });
    }
  }

  return { ictx, statements, materializedModels, publishedModels, planFailures };
}
