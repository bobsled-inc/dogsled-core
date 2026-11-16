import * as crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  interpolateSecrets,
  isCancellationError,
  resolveSnowflakeWarehouseOverride,
  resolveRunner,
  runCancellable,
  throwIfCancelled,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { queryResource, type QueryFilterInput } from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import {
  buildFqNameWithDatabase,
  buildModelRegistry,
  generateSelectSql,
  getSourceEntry,
  materializeSql,
  parseTransformSpecFromParsed,
  quoteIdentifier,
  quoteLiteral,
  stateKey,
  type ResolvedTransformSpec,
  type SourceEntryColumn,
  type SourceEntryRegistry,
  type SourceRegistry,
  type SourceRegistryEntry,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import {
  type PlannedPublishedModel,
  type CrossWarehousePublishContext,
  type CrossWarehousePublishResult,
} from '@bobsled-inc/model-spec/project';
import { RecordBuffer, createDefaultDatabaseDestination } from '@bobsled-inc/loader';
import { CommandError, type LoadStrategy, type SchemaColumn } from '@bobsled-inc/protocol';

import {
  resolvePublishTarget,
  targetFqName,
  type PublishTarget,
} from './cross-warehouse-destinations.js';
import {
  columnsForPublishedModel,
  projectColumns,
  sourceSelectSql,
  stageTableName,
  toSchemaColumns,
  withExtractedAt,
} from './cross-warehouse-rows.js';
import { enforceSchemaDrift } from './cross-warehouse-schema.js';
import {
  convertJsonlChunksToParquet,
  encodingFor,
  formatMs,
  resolveSourceTimeoutMs,
  resolveStagingFormat,
  runSql,
  sourceTimeoutError,
  withSourceDeadline,
} from './cross-warehouse-execution.js';

interface BaseSourcePlan {
  ref: string;
  stageName: string;
  stageRef: string;
  stageFqn: string;
  columns: SchemaColumn[];
}

/** A warehouse_table leaf: read via its own SQL runner, UNLOAD or stream-staged. */
interface WarehouseSourcePlan extends BaseSourcePlan {
  kind: 'warehouse';
  entry: Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;
  dialect: SupportedDialect;
  runner: SqlRunnerModule;
}

/**
 * An api_resource (live/lazy) leaf: there is no SQL runner — rows are fetched
 * from the API via `queryResource` and loaded into the publish target's stage
 * table through the same loader path the warehouse stream-fallback uses.
 */
interface ApiSourcePlan extends BaseSourcePlan {
  kind: 'api';
  entry: Extract<SourceRegistryEntry, { kind: 'api_resource' }>;
}

type SourcePlan = WarehouseSourcePlan | ApiSourcePlan;

const STAGE_FLUSH_THRESHOLD = 10_000;

async function runDestinationOperation<T>(
  destination: DatabaseDestinationHandle,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return await runCancellable(signal, (register) => {
    if (destination.cancel) {
      register(() => destination.cancel!());
    }
    return operation();
  });
}

/** SCD-2-friendly stable timestamp captured once per publish invocation. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Collect every resolved-secret string value so error messages can be scrubbed
 * before any operator-visible callback fires. We only collect non-trivial
 * values (≥8 chars) to avoid replacing innocuous tokens like "main" / "us".
 */
function collectSecretValues(integration: unknown, into: Set<string>): void {
  walkObject(integration as unknown, (value) => {
    if (typeof value === 'string' && value.length >= 8) {
      into.add(value);
    }
  });
}

function walkObject(value: unknown, visit: (v: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkObject(entry, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      walkObject(entry, visit);
    }
  }
}

function redactMessage(message: string, secrets: Set<string>): string {
  if (secrets.size === 0) return message;
  let redacted = message;
  // Replace longer secrets first so a shorter secret that's a prefix of a
  // longer one doesn't shadow the longer match (e.g. redacting "abc" before
  // "abcdef" would leave "def" exposed).
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

export async function publishCrossWarehouse(
  model: PlannedPublishedModel,
  context: CrossWarehousePublishContext
): Promise<CrossWarehousePublishResult> {
  const signal = context.signal;
  throwIfCancelled(signal);
  const secrets = new Set<string>();
  const stagingFormat = resolveStagingFormat();
  let target: PublishTarget;
  try {
    target = await resolvePublishTarget(model, context);
    throwIfCancelled(signal);
  } catch (error) {
    if (isCancellationError(error, signal)) {
      return {
        executionResult: {
          modelName: model.node.name,
          status: 'cancelled',
          error: 'Cancelled while resolving the publish target.',
        },
      };
    }
    throw error;
  }
  collectSecretValues(target.integration.integration, secrets);

  const safeModelDir = model.node.name.replace(/[^A-Za-z0-9_-]/g, '_');
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `bobsled-xwh-${safeModelDir}-`));
  // mkdtemp creates 0700 on POSIX, but enforce explicitly so callers on
  // platforms that don't honor that default still get private staging.
  try {
    await fs.chmod(workDir, 0o700);
  } catch {
    // Windows or stripped-down filesystems may not implement chmod — accept
    // the platform default rather than failing the whole publish.
  }
  const cleanup = async (): Promise<void> => {
    await fs.rm(workDir, { recursive: true, force: true });
  };
  // Installing a SIGINT/SIGTERM listener suppresses Node's default exit
  // behavior, so after best-effort cleanup we must terminate. Re-raise the
  // signal via `process.kill(pid, signal)` after removing our listener —
  // Node's default handler then runs and exits with the conventional
  // 128+signal exit code. This avoids the explicit-exit path forbidden by
  // the repo-wide structural invariant while preserving the
  // operator-visible semantics that Ctrl-C actually kills the publisher.
  // The handler uses `rmSync` because the process is about to exit and
  // async cleanup wouldn't get a chance to finish.
  const signalCleanup = (signal: NodeJS.Signals): void => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Swallow — we're already on the termination path.
    }
    process.removeListener('SIGINT', signalCleanup);
    process.removeListener('SIGTERM', signalCleanup);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', signalCleanup);
  process.once('SIGTERM', signalCleanup);

  const runId = crypto.randomBytes(6).toString('hex');
  let destination: Awaited<ReturnType<typeof createDefaultDatabaseDestination>> | undefined;
  let destinationClosed = true;
  let destRunner: SqlRunnerModule | undefined;
  let destRunnerClosed = true;
  let sourcePlans: SourcePlan[] = [];
  let resultFqn: string | undefined;

  const startMs = Date.now();
  let stageMsTotal = 0;
  try {
    throwIfCancelled(signal);
    const destinationConfig =
      target.config.dest === 'snowflake' &&
      target.integration.integration.source_type === 'snowflake'
        ? {
            ...target.config,
            warehouse:
              resolveSnowflakeWarehouseOverride(
                target.integration.integration.connection,
                context.warehouse
              ) ?? target.config.warehouse,
          }
        : target.config;
    destination = await createDefaultDatabaseDestination(destinationConfig, {
      tokenProvider: context.tokenProvider,
      queryTag: context.queryTag,
    });
    destinationClosed = false;
    await runDestinationOperation(destination, signal, () => destination!.initialize());

    throwIfCancelled(signal);
    destRunner = await resolveRunner(target.integration.integration, {
      secretResolver: context.secretResolver,
      customRunners: context.customRunners,
      warehouse: context.warehouse,
      queryTag: context.queryTag,
      tokenProvider: context.tokenProvider,
    });
    destRunnerClosed = false;
    if (signal?.aborted) {
      await destRunner.close?.().catch(() => undefined);
      destRunnerClosed = true;
      throwIfCancelled(signal);
    }

    const dialect = target.integration.dialect;
    const targetFqn = targetFqName(target);
    const publishColumns = columnsForPublishedModel(model);

    sourcePlans = await resolveSourcePlans(model, context, target, runId, secrets);
    const { registry, entryRegistry } = buildStagedRegistries(sourcePlans, target);
    const modelRegistry = buildModelRegistry([model.node.name], target.schema, dialect);
    const parsed = parseTransformSpecFromParsed(model.node.parsedSpec, registry, modelRegistry);
    if (!parsed.ok) {
      throw new CommandError(`[${model.targetHandle}] ${model.node.name}: ${parsed.error}`, 2);
    }

    const previous = context.state.models[stateKey(model.targetHandle, model.node.name)];
    let isFirstRun = Boolean(context.fullRefresh) || !previous?.publishedSnapshotId;
    let schemaFullRefresh = false;
    if (!isFirstRun && parsed.spec.materialization !== 'table') {
      const policy = parsed.spec.materializationConfig?.on_schema_change ?? 'fail';
      const drift = await enforceSchemaDrift(
        destRunner,
        publishColumns,
        {
          database: target.database,
          schema: target.schema,
          table: target.table,
          fqn: targetFqn,
          dialect,
        },
        policy,
        { dropOnFullRefresh: false, signal }
      );
      if (drift.fullRefresh) {
        isFirstRun = true;
        schemaFullRefresh = true;
      }
    }

    for (const source of sourcePlans) {
      throwIfCancelled(signal);
      const sourceStartMs = Date.now();
      if (source.kind === 'api') {
        // Live/lazy API leaf: no SQL runner — fetch and load into the stage table.
        await stageApiSourceToDestination(
          source,
          target,
          destination,
          workDir,
          stagingFormat,
          secrets,
          context.apiSecrets,
          signal
        );
      } else {
        const whereClause = await computeSourcePruning(
          destRunner,
          parsed.spec,
          source,
          targetFqn,
          isFirstRun,
          dialect,
          signal
        );
        const sourceSql = sourceSelectSql(
          source.entry.fqRef,
          source.entry.columns,
          source.dialect,
          whereClause
        );
        await stageSourceToDestination(
          source,
          sourceSql,
          model,
          target,
          destination,
          workDir,
          secrets,
          stagingFormat,
          context
        );
      }
      stageMsTotal += Date.now() - sourceStartMs;
    }

    await destination.close();
    destinationClosed = true;
    throwIfCancelled(signal);
    try {
      await destRunner.close?.();
    } catch (error) {
      context.onWarn?.(
        `[${model.targetHandle}] Failed to refresh publish destination runner cleanly: ${redactMessage(
          stringifyError(error),
          secrets
        )}`
      );
    }
    destRunnerClosed = true;
    destRunner = await resolveRunner(target.integration.integration, {
      secretResolver: context.secretResolver,
      customRunners: context.customRunners,
      warehouse: context.warehouse,
      queryTag: context.queryTag,
      tokenProvider: context.tokenProvider,
    });
    destRunnerClosed = false;
    if (signal?.aborted) {
      await destRunner.close?.().catch(() => undefined);
      destRunnerClosed = true;
      throwIfCancelled(signal);
    }

    const selectSql = generateSelectSql(parsed.spec, dialect, undefined, {
      targetSchema: target.schema,
      isFullRefresh: isFirstRun,
      entryRegistry,
    });

    const resultTable = transientTableName('result', model.node.name, runId);
    resultFqn = buildFqNameWithDatabase(target.schema, resultTable, dialect, target.database);
    await safeDropTable(destRunner, resultFqn, context, secrets, signal);
    await runSql(destRunner, `CREATE TABLE ${resultFqn} AS ${selectSql}`, signal);
    const rowsAffected = await countRows(destRunner, resultFqn, signal);

    if (schemaFullRefresh) {
      await runSql(destRunner, `DROP TABLE IF EXISTS ${targetFqn}`, signal);
    }

    // Run any preDdl supplied by `planTransition` before the materialize DDL.
    // For published models, `recreate` transitions (e.g. view → table) emit
    // `DROP <prior_type> IF EXISTS ${targetFqn}` here so the warehouse no
    // longer holds an incompatible object when `CREATE TABLE` runs.
    if (model.preDdl) {
      for (const sql of model.preDdl) {
        throwIfCancelled(signal);
        await runSql(destRunner, sql, signal);
      }
    }

    const ddlStatements = materializeSql(
      `SELECT * FROM ${resultFqn}`,
      parsed.spec,
      target.schema,
      dialect,
      { isFirstRun },
      target.database
    );
    for (const sql of ddlStatements) {
      throwIfCancelled(signal);
      await runSql(destRunner, sql, signal);
    }

    throwIfCancelled(signal);
    const publishedAt = nowIso();
    const totalMs = Date.now() - startMs;
    const publishMs = Math.max(0, totalMs - stageMsTotal);
    const substrate = crossWarehouseStagingUri(target.integration.integration)
      ? 'unload-or-stream'
      : 'stream';
    context.onSuccess?.(
      `[${model.targetHandle}] Published ${model.node.name} (${rowsAffected} row(s)) in ${formatMs(totalMs)}; ` +
        `stage=${formatMs(stageMsTotal)} publish=${formatMs(publishMs)} ` +
        `format=${stagingFormat} substrate=${substrate}`
    );
    return {
      executionResult: {
        modelName: model.node.name,
        status: 'success',
        rowsAffected,
      },
      publishedSnapshotId: runId,
      publishedAt,
    };
  } catch (error) {
    const message = redactMessage(stringifyError(error), secrets);
    if (isCancellationError(error, signal) || signal?.aborted) {
      return {
        executionResult: {
          modelName: model.node.name,
          status: 'cancelled',
          error: message,
        },
      };
    }
    context.onError?.(`[${model.targetHandle}] ${model.node.name}: ${message}`);
    return {
      executionResult: {
        modelName: model.node.name,
        status: 'failed',
        error: message,
        exitCode: error instanceof CommandError ? error.exitCode : undefined,
      },
    };
  } finally {
    process.removeListener('SIGINT', signalCleanup);
    process.removeListener('SIGTERM', signalCleanup);
    // Drop stage + result tables on the destination warehouse. The cached
    // `destRunner` may be closed if the post-stage re-open at the staging
    // boundary threw (creds, network, transient warehouse error), in which
    // case we open a fresh runner just for cleanup. Without this fallback,
    // transient `_xwh_stage_*` and `_xwh_result_*` tables leak on the
    // destination after any re-open failure.
    const transientFqns: string[] = sourcePlans.map((source) => source.stageFqn);
    if (resultFqn) transientFqns.push(resultFqn);
    if (transientFqns.length > 0) {
      let cleanupRunner: SqlRunnerModule | undefined;
      let openedFreshRunnerForCleanup = false;
      if (destRunner && !destRunnerClosed) {
        cleanupRunner = destRunner;
      } else {
        try {
          cleanupRunner = await resolveRunner(target.integration.integration, {
            secretResolver: context.secretResolver,
            customRunners: context.customRunners,
            warehouse: context.warehouse,
            queryTag: context.queryTag,
            tokenProvider: context.tokenProvider,
          });
          openedFreshRunnerForCleanup = true;
        } catch (cleanupError) {
          context.onWarn?.(
            `[${model.targetHandle}] Could not open destination runner to drop transient cross-warehouse tables; ` +
              `manual cleanup may be required for: ${transientFqns.join(', ')}. ` +
              `Cause: ${redactMessage(stringifyError(cleanupError), secrets)}`
          );
        }
      }
      if (cleanupRunner) {
        for (const fqn of transientFqns) {
          await safeDropTable(cleanupRunner, fqn, context, secrets);
        }
        if (openedFreshRunnerForCleanup) {
          try {
            await cleanupRunner.close?.();
          } catch {
            // Already on the cleanup path; the per-original-runner close
            // block below handles the cached runner, and we don't want to
            // mask the original publish error with a close-time warning.
          }
        }
      }
    }
    for (const source of sourcePlans) {
      // API leaves have no SQL runner to close.
      if (source.kind !== 'warehouse') continue;
      if (typeof source.runner.close === 'function') {
        try {
          await source.runner.close();
        } catch (error) {
          context.onWarn?.(
            `[${model.targetHandle}] Failed to close source runner for ${source.ref}: ${redactMessage(
              stringifyError(error),
              secrets
            )}`
          );
        }
      }
    }
    if (destRunner && !destRunnerClosed) {
      try {
        await destRunner.close?.();
      } catch (error) {
        context.onWarn?.(
          `[${model.targetHandle}] Failed to close publish destination runner cleanly: ${redactMessage(
            stringifyError(error),
            secrets
          )}`
        );
      }
      destRunnerClosed = true;
    }
    if (destination && !destinationClosed) {
      try {
        await destination.close();
      } catch (error) {
        context.onWarn?.(
          `[${model.targetHandle}] Failed to close publish destination cleanly: ${redactMessage(
            stringifyError(error),
            secrets
          )}`
        );
      }
      destinationClosed = true;
    }
    try {
      await cleanup();
    } catch (error) {
      context.onWarn?.(
        `[${model.targetHandle}] Failed to clean up cross-warehouse temp directory: ${redactMessage(
          stringifyError(error),
          secrets
        )}`
      );
    }
  }
}

async function resolveSourcePlans(
  model: PlannedPublishedModel,
  context: CrossWarehousePublishContext,
  target: PublishTarget,
  runId: string,
  secrets: Set<string>
): Promise<SourcePlan[]> {
  const plans: SourcePlan[] = [];
  try {
    for (const ref of model.node.sourceRefs) {
      throwIfCancelled(context.signal);
      const entry = getSourceEntry(context.project.sourceEntries, ref);
      if (!entry) {
        throw new CommandError(`Model "${model.node.name}" references unknown source "${ref}".`, 2);
      }

      const stageName = transientTableName('stage', ref, runId);
      const stageFqn = buildFqNameWithDatabase(
        target.schema,
        stageName,
        target.integration.dialect,
        target.database
      );

      if (entry.kind === 'api_resource') {
        plans.push({
          kind: 'api',
          ref,
          entry,
          stageName,
          stageRef: stageFqn,
          stageFqn,
          columns: toSchemaColumns(entry.columns),
        });
        continue;
      }

      const sourceIntegration = context.project.integrations.get(entry.connection);
      if (!sourceIntegration) {
        throw new CommandError(
          `Model "${model.node.name}" references source "${ref}" from unknown integration "${entry.connection}".`,
          2
        );
      }
      collectSecretValues(sourceIntegration.integration, secrets);

      const integration = await interpolateSecrets(
        sourceIntegration.integration,
        context.secretResolver
      );
      throwIfCancelled(context.signal);
      collectSecretValues(integration, secrets);
      let runner: SqlRunnerModule | undefined;
      try {
        runner = await resolveRunner(integration, {
          secretResolver: context.secretResolver,
          customRunners: context.customRunners,
          queryTag: context.queryTag,
          tokenProvider: context.tokenProvider,
        });
        throwIfCancelled(context.signal);
        plans.push({
          kind: 'warehouse',
          ref,
          entry,
          dialect: sourceIntegration.dialect,
          runner,
          stageName,
          stageRef: stageFqn,
          stageFqn,
          columns: toSchemaColumns(entry.columns),
        });
      } catch (error) {
        await runner?.close?.().catch(() => undefined);
        throw error;
      }
    }
    return plans;
  } catch (error) {
    await Promise.allSettled(
      plans.flatMap((plan) =>
        plan.kind === 'warehouse' && plan.runner.close ? [plan.runner.close()] : []
      )
    );
    throw error;
  }
}

function buildStagedRegistries(
  sources: SourcePlan[],
  target: PublishTarget
): { registry: SourceRegistry; entryRegistry: SourceEntryRegistry } {
  const registry: SourceRegistry = new Map();
  const entryRegistry: SourceEntryRegistry = new Map();
  for (const source of sources) {
    registry.set(source.ref, source.stageRef);
    entryRegistry.set(source.ref, {
      kind: 'warehouse_table',
      fqRef: source.stageRef,
      connection: target.integration.handle,
      columns: source.columns.map((column): SourceEntryColumn => {
        const type = column.type === 'vector' ? 'array' : column.type;
        return {
          name: column.name,
          sqlType: type,
          type,
        };
      }),
    });
  }
  return { registry, entryRegistry };
}

async function stageSourceToDestination(
  source: WarehouseSourcePlan,
  sourceSql: string,
  model: PlannedPublishedModel,
  target: PublishTarget,
  destination: Awaited<ReturnType<typeof createDefaultDatabaseDestination>>,
  workDir: string,
  secrets: Set<string>,
  stagingFormat: 'jsonl' | 'parquet',
  context: CrossWarehousePublishContext
): Promise<void> {
  const signal = context.signal;
  throwIfCancelled(signal);
  const destStagingUri = crossWarehouseStagingUri(target.integration.integration);
  if (destStagingUri && hasUnload(source.runner) && hasLoadFromUri(destination)) {
    const unloadUri = joinUri(destStagingUri, `run_${source.stageName}`, source.stageName);
    try {
      const result = await source.runner.unload(sourceSql, unloadUri, {
        format: 'parquet',
        ...(signal ? { signal } : {}),
      });
      await runDestinationOperation(destination, signal, () =>
        destination.loadFromUri!(target.schema, source.stageName, result.uris, source.columns)
      );
      return;
    } catch (error) {
      if (isCancellationError(error, signal) || signal?.aborted) throw error;
      context.onWarn?.(
        `[${model.targetHandle}] UNLOAD failed for source ${source.ref}; falling back to JSONL streaming. ` +
          `Cause: ${redactMessage(stringifyError(error), secrets)}`
      );
    }
  }

  await runDestinationOperation(destination, signal, () =>
    destination.ensureTable(target.schema, source.stageName, source.columns)
  );
  const extractedAt = nowIso();
  const jsonlFiles = await writeSourceRows(
    source.ref,
    source.runner,
    sourceSql,
    source.columns,
    workDir,
    extractedAt,
    signal
  );
  const stageFiles =
    stagingFormat === 'parquet'
      ? await convertJsonlChunksToParquet(
          jsonlFiles,
          source.columns,
          workDir,
          stageTableName(source.ref),
          signal
        )
      : jsonlFiles;
  if (stageFiles.length === 0) {
    const emptyFile = await emptyJsonlFile(workDir);
    await runDestinationOperation(destination, signal, () =>
      destination.loadAndFinalize(
        target.schema,
        source.stageName,
        emptyFile,
        source.columns,
        'full_refresh',
        [],
        { format: 'jsonl' }
      )
    );
    return;
  }

  const stageEncoding = encodingFor(stagingFormat);
  for (let i = 0; i < stageFiles.length; i += 1) {
    throwIfCancelled(signal);
    const strategy: LoadStrategy = i === 0 ? 'full_refresh' : 'append';
    await runDestinationOperation(destination, signal, () =>
      destination.loadAndFinalize(
        target.schema,
        source.stageName,
        stageFiles[i]!,
        source.columns,
        strategy,
        [],
        stageEncoding
      )
    );
  }
}

/**
 * Stage a live/lazy `api_resource` leaf into the publish target. Mirrors the
 * stream-fallback half of `stageSourceToDestination`, but the rows come from the
 * API via `queryResource` instead of a SQL runner. The staged table is
 * identical in shape to a warehouse stage, so the model SELECT and
 * `buildStagedRegistries` treat it the same.
 *
 * v1 limitations: full fetch on every publish (no `max_age`/incremental
 * pushdown yet, so `live` and `lazy` behave identically here), and API auth
 * resolves from the process environment (`$TOKEN` indirection), not from
 * `context.secretResolver`.
 */
async function stageApiSourceToDestination(
  source: ApiSourcePlan,
  target: PublishTarget,
  destination: DatabaseDestinationHandle,
  workDir: string,
  stagingFormat: 'jsonl' | 'parquet',
  secrets: Set<string>,
  apiSecrets: Record<string, string | undefined> | undefined,
  signal?: AbortSignal
): Promise<void> {
  throwIfCancelled(signal);
  let loaded: ReturnType<typeof loadQueryableResourceSpecs>;
  try {
    loaded = loadQueryableResourceSpecs(source.entry.integration, source.entry.resource);
  } catch (error) {
    // Surface a catalog-lookup failure as a validation CommandError so it keeps
    // a stable exit code instead of bubbling up as an untyped Error.
    throw new CommandError(
      `Failed to load query surface for "${source.entry.integration}.${source.entry.resource}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      2
    );
  }
  if (!loaded) {
    throw new CommandError(
      `Resource "${source.entry.integration}.${source.entry.resource}" has no query surface; ` +
        'add a query: block to the resource YAML so it can be staged into the publish target.',
      2
    );
  }
  // Collect secret-shaped values from the catalog integration, the resource
  // spec, AND any programmatically-supplied API credentials so a queryResource
  // failure is redacted by the caller's outer catch before reaching onError.
  collectSecretValues(loaded.integration, secrets);
  collectSecretValues(loaded.resource, secrets);
  if (apiSecrets !== undefined) {
    collectSecretValues(apiSecrets, secrets);
  }

  // Honor BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S for API fetches too, matching warehouse
  // staging — otherwise a hung live/lazy fetch would never time out.
  const timeoutMs = resolveSourceTimeoutMs();
  const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;
  const result = await withSourceDeadline(
    queryResource({
      integration: loaded.integration,
      resource: loaded.resource,
      ...(source.entry.filter !== undefined
        ? { filter: source.entry.filter as QueryFilterInput }
        : {}),
      // Programmatic API credentials (lakehouse) override process.env when set.
      ...(apiSecrets !== undefined ? { secrets: apiSecrets } : {}),
      ...(signal ? { signal } : {}),
    }),
    deadlineMs,
    timeoutMs,
    source.ref,
    signal
  );

  await runDestinationOperation(destination, signal, () =>
    destination.ensureTable(target.schema, source.stageName, source.columns)
  );
  const extractedAt = nowIso();
  const buffer = new RecordBuffer({
    stream: stageTableName(source.ref),
    flushThreshold: STAGE_FLUSH_THRESHOLD,
    tempDir: workDir,
  });
  for (const record of result.records) {
    throwIfCancelled(signal);
    await buffer.addRecord(
      withExtractedAt(
        projectColumns(record as Record<string, unknown>, source.columns),
        extractedAt
      )
    );
  }
  await buffer.flush();
  const jsonlFiles = buffer.flushAll();
  const stageFiles =
    stagingFormat === 'parquet'
      ? await convertJsonlChunksToParquet(
          jsonlFiles,
          source.columns,
          workDir,
          stageTableName(source.ref),
          signal
        )
      : jsonlFiles;

  if (stageFiles.length === 0) {
    const emptyFile = await emptyJsonlFile(workDir);
    await runDestinationOperation(destination, signal, () =>
      destination.loadAndFinalize(
        target.schema,
        source.stageName,
        emptyFile,
        source.columns,
        'full_refresh',
        [],
        { format: 'jsonl' }
      )
    );
    return;
  }

  const stageEncoding = encodingFor(stagingFormat);
  for (let i = 0; i < stageFiles.length; i += 1) {
    throwIfCancelled(signal);
    const strategy: LoadStrategy = i === 0 ? 'full_refresh' : 'append';
    await runDestinationOperation(destination, signal, () =>
      destination.loadAndFinalize(
        target.schema,
        source.stageName,
        stageFiles[i]!,
        source.columns,
        strategy,
        [],
        stageEncoding
      )
    );
  }
}

async function writeSourceRows(
  ref: string,
  runner: SqlRunnerModule,
  sql: string,
  columns: SchemaColumn[],
  tempDir: string,
  extractedAt: string,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfCancelled(signal);
  const buffer = new RecordBuffer({
    stream: stageTableName(ref),
    flushThreshold: STAGE_FLUSH_THRESHOLD,
    tempDir,
  });
  // Per-source timeout (opt-in via BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S, default no
  // limit). The earlier between-rows check only fired after a row arrived; a
  // driver that stalls inside query() or iterator.next() would never trip it.
  // Race each awaited source I/O call against the remaining deadline so a
  // stuck source surfaces as a clean CommandError.
  const timeoutMs = resolveSourceTimeoutMs();
  const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;
  const checkDeadline = (): void => {
    if (deadlineMs !== null && timeoutMs !== null && Date.now() > deadlineMs) {
      throw sourceTimeoutError(ref, timeoutMs);
    }
  };

  if (hasStreamingRows(runner)) {
    const iterable = signal
      ? runner.streamQueryRows(sql, undefined, { signal })
      : runner.streamQueryRows(sql);
    const iterator = iterable[Symbol.asyncIterator]();
    let completed = false;
    try {
      for (;;) {
        const next = await withSourceDeadline(iterator.next(), deadlineMs, timeoutMs, ref, signal);
        if (next.done) {
          completed = true;
          break;
        }
        checkDeadline();
        throwIfCancelled(signal);
        await buffer.addRecord(withExtractedAt(projectColumns(next.value, columns), extractedAt));
      }
    } finally {
      if (!completed) {
        const closePromise = iterator.return?.();
        if (closePromise) closePromise.catch(() => undefined);
      }
    }
  } else {
    if (!runner.query) {
      throw new CommandError('Source runner must support query() or streamQueryRows().', 1);
    }
    const rows = await withSourceDeadline(
      signal ? runner.query(sql, undefined, { signal }) : runner.query(sql),
      deadlineMs,
      timeoutMs,
      ref,
      signal
    );
    for (const row of rows) {
      checkDeadline();
      throwIfCancelled(signal);
      await buffer.addRecord(withExtractedAt(projectColumns(row, columns), extractedAt));
    }
  }
  await buffer.flush();
  return buffer.flushAll();
}

async function emptyJsonlFile(tempDir: string): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, 'empty.jsonl');
  await fs.writeFile(filePath, '');
  return filePath;
}

function hasStreamingRows(runner: SqlRunnerModule): runner is SqlRunnerModule & {
  streamQueryRows: NonNullable<SqlRunnerModule['streamQueryRows']>;
} {
  return typeof (runner as { streamQueryRows?: unknown }).streamQueryRows === 'function';
}

function hasUnload(
  runner: SqlRunnerModule
): runner is SqlRunnerModule & { unload: NonNullable<SqlRunnerModule['unload']> } {
  return typeof runner.unload === 'function';
}

type DatabaseDestinationHandle = Awaited<ReturnType<typeof createDefaultDatabaseDestination>>;

function hasLoadFromUri(
  destination: DatabaseDestinationHandle
): destination is DatabaseDestinationHandle & {
  loadFromUri: NonNullable<DatabaseDestinationHandle['loadFromUri']>;
} {
  return typeof destination.loadFromUri === 'function';
}

async function computeSourcePruning(
  destRunner: SqlRunnerModule,
  spec: ResolvedTransformSpec,
  source: WarehouseSourcePlan,
  targetFqn: string,
  isFirstRun: boolean,
  destDialect: SupportedDialect,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (isFirstRun) return undefined;
  if (spec.materialization !== 'incremental') return undefined;
  const cursor = spec.materializationConfig?.cursor_field;
  if (!cursor) return undefined;
  if (source.ref !== spec.sourceRef) return undefined;

  const cursorColumn = source.entry.columns.find(
    (column) => column.name.toLowerCase() === cursor.toLowerCase()
  );
  if (!cursorColumn) return undefined;
  if (!destRunner.query) return undefined;

  const sql = `SELECT MAX(${quoteIdentifier(cursor, destDialect)}) AS watermark FROM ${targetFqn}`;
  const rows = signal
    ? await destRunner.query(sql, undefined, { signal })
    : await destRunner.query(sql);
  const watermark = readRowValue(rows[0] ?? {}, 'watermark');
  if (watermark === null || watermark === undefined) return undefined;

  const literal = formatSqlLiteral(watermark, source.dialect, cursorColumn.type);
  return `${quoteIdentifier(cursor, source.dialect)} > ${literal}`;
}

async function countRows(
  runner: SqlRunnerModule,
  fqn: string,
  signal?: AbortSignal
): Promise<number> {
  if (!runner.query) return 0;
  const sql = `SELECT COUNT(*) AS c FROM ${fqn}`;
  const rows = signal ? await runner.query(sql, undefined, { signal }) : await runner.query(sql);
  const raw = readRowValue(rows[0] ?? {}, 'c');
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function safeDropTable(
  runner: SqlRunnerModule,
  fqn: string,
  context: Pick<CrossWarehousePublishContext, 'onWarn'>,
  secrets: Set<string>,
  signal?: AbortSignal
): Promise<void> {
  try {
    await runSql(runner, `DROP TABLE IF EXISTS ${fqn}`, signal);
  } catch (error) {
    if (isCancellationError(error, signal) || signal?.aborted) throw error;
    context.onWarn?.(
      `Failed to drop cross-warehouse temporary table ${fqn}: ${redactMessage(
        stringifyError(error),
        secrets
      )}`
    );
  }
}

function formatSqlLiteral(
  value: unknown,
  dialect: SupportedDialect,
  type: SourceEntryColumn['type']
): string {
  if (value === null || value === undefined) return 'NULL';
  switch (type) {
    case 'integer':
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
      return quoteLiteral(String(value), dialect);
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      return /^(true|1)$/i.test(String(value)) ? 'TRUE' : 'FALSE';
    case 'timestamp': {
      const raw = value instanceof Date ? value.toISOString() : String(value);
      return `TIMESTAMP ${quoteLiteral(raw, dialect)}`;
    }
    case 'array':
    case 'object':
      return quoteLiteral(JSON.stringify(value), dialect);
    case 'string':
      return quoteLiteral(String(value), dialect);
  }
}

function readRowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
}

function crossWarehouseStagingUri(integration: unknown): string | undefined {
  const staging = (integration as { cross_warehouse_staging?: { uri?: unknown } })
    .cross_warehouse_staging;
  return typeof staging?.uri === 'string' && staging.uri.length > 0 ? staging.uri : undefined;
}

function joinUri(base: string, ...parts: string[]): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanParts = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return [cleanBase, ...cleanParts].join('/');
}

function transientTableName(prefix: 'stage' | 'result', value: string, runId: string): string {
  const slug =
    value
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^_+/, '')
      .slice(0, 40) || 'x';
  const digest = crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
  return `_xwh_${prefix}_${slug}_${digest}_${runId}`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// targetFqName is re-exported via cross-warehouse-destinations.ts for callers
// that still expect the previous public surface.
export { targetFqName };
