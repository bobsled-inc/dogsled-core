import type { JsonObject, SchemaBehavior } from '@bobsled-inc/protocol';

import type { EmbedConfigFile } from '../model-spec/embed-config-file.js';
import { resolveResourceEmbedConfig } from '../model-spec/embed-config-file.js';
import { generateModelSpecSource } from '../model-spec/generate-source.js';
import { ControlLogger } from '../runtime/control.js';
import { dispatchSourceKind } from '../runtime/dispatch.js';
import { Emitter } from '../runtime/emitter.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  FanOutPrimaryKeyTracker,
  MAX_FAN_OUT_PRIMARY_KEYS,
  assertCompleteFanOutContext,
  buildTargetedFanOutContext,
  extendFanOutContext,
  getContextProjectionValues,
  hasExplicitForEachInputs,
  normalizeForEachConfig,
  pickForEachBindingValues,
  runWithConcurrency,
  type FanOutContext,
  type FanOutWorkItem,
} from '../runtime/for-each.js';
import { evaluateResolvedPredicate, resolvePredicate } from '../runtime/predicates.js';
import { buildBookmarkPartition, type StateStore, type StreamBookmark } from '../runtime/state.js';
import {
  getResourceProgressMetadata,
  logSchemaBehaviorDefaultWarning,
} from '../runtime/schema-diagnostics.js';
import {
  classifyFailureReason,
  ResourceCircuitBreaker,
  serializeExtractorErrorCause,
} from '../runtime/errors.js';
import { TransportClientPool } from '../runtime/transport-client-pool.js';
import { getErrorMessage } from '../framework/core/shared.js';
import type {
  ApiResourceSpec,
  ExtractorState,
  IntegrationSpec,
  ResourceSpec,
} from '../types/index.js';
import type { ResourceResult } from '../runtime/run-summary.js';
import { extractResource, shouldAdvanceDurableState } from './extract-resource.js';
import { mergeResourceInputs, type ResourceInputsMap } from './resource-inputs.js';
import type { ExtractOptions } from './extract-command-options.js';
import { CommandError } from './common.js';

export type ForEachRecord = {
  input: Readonly<Record<string, unknown>>;
  output: Readonly<Record<string, unknown>>;
  context: FanOutContext;
};

function filterInputsForResource(
  inputs: Record<string, string>,
  inputSchema: ApiResourceSpec['input'] | undefined
): Record<string, string> {
  if (!inputSchema) return {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (Object.hasOwn(inputSchema, key)) filtered[key] = value;
  }
  return filtered;
}

export interface ExtractMatrixResourceEntry {
  spec: ResourceSpec;
  warnings: string[];
  filePath: string;
}

export interface ExtractResourcesWithMatricesParams {
  sortedResources: ExtractMatrixResourceEntry[];
  integrationName: string;
  integration: IntegrationSpec;
  clientPool: TransportClientPool | undefined;
  circuitBreaker: ResourceCircuitBreaker;
  opts: ExtractOptions;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  batchDir: string;
  cliInputs: Record<string, string>;
  resourceInputsMap: ResourceInputsMap | undefined;
  forEachCache: Map<string, ForEachRecord[]>;
  parentResources: Set<string>;
  presentResources: Set<string>;
  runStartedAt: Date;
  isTimedOut: () => boolean;
  defaultSchemaBehavior: SchemaBehavior | undefined;
  embedConfigFromFile: EmbedConfigFile | undefined;
  resourceResults: ResourceResult[];
}

export async function extractResourcesWithMatrices(
  context: ExtractResourcesWithMatricesParams
): Promise<{ totalRecords: number; failedResources: number }> {
  const {
    sortedResources,
    integrationName,
    integration,
    clientPool,
    circuitBreaker,
    opts,
    emitter,
    logger,
    state,
    stateStore,
    batchDir,
    cliInputs,
    resourceInputsMap,
    forEachCache,
    parentResources,
    presentResources,
    runStartedAt,
    isTimedOut,
    defaultSchemaBehavior,
    embedConfigFromFile,
    resourceResults,
  } = context;
  let totalRecords = 0;
  let failedResources = 0;

  for (const { spec: resource, warnings: resourceWarnings, filePath } of sortedResources) {
    const matrixInputs = opts.resourceInputMatrices?.[resource.name] ?? [Object.create(null)];
    const matrixConcurrency = opts.resourceInputMatrixConcurrency?.[resource.name] ?? 1;
    let matrixSchemaPromise: Promise<void> | undefined;
    const emitMatrixSchema = (): Promise<void> => {
      matrixSchemaPromise ??= emitter.emitSchema(resource, {
        fullRefresh: opts.fullRefresh,
      });
      return matrixSchemaPromise;
    };
    await runWithConcurrency(matrixInputs, matrixConcurrency, async (matrixInput) => {
      const matrixLabel =
        Object.keys(matrixInput).length > 0 ? ` (${JSON.stringify(matrixInput)})` : '';
      const matrixMetadata: JsonObject =
        Object.keys(matrixInput).length > 0
          ? { input_matrix: matrixInput, matrix_label: JSON.stringify(matrixInput) }
          : {};
      const resourceProgress = getResourceProgressMetadata(resource, filePath);

      // Check timeout before each resource
      if (isTimedOut()) {
        resourceResults.push({
          resource: resource.name,
          status: 'skipped',
          records_emitted: 0,
          api_calls: 0,
          duration_ms: 0,
        });
        await logger.progress('resource_skip', resource.name, {
          resource: resource.name,
          status: 'skipped',
          reason: 'timeout',
          ...matrixMetadata,
        });
        return;
      }

      // Check circuit breaker
      if (circuitBreaker.isOpen) {
        resourceResults.push({
          resource: resource.name,
          status: 'circuit_breaker',
          records_emitted: 0,
          api_calls: 0,
          duration_ms: 0,
          failure_reason: 'circuit_breaker',
        });
        await logger.progress('resource_skip', resource.name, {
          resource: resource.name,
          status: 'circuit_breaker',
          reason: 'circuit_breaker',
          consecutive_failures: circuitBreaker.failures,
          ...matrixMetadata,
        });
        return;
      }

      for (const warning of resourceWarnings) {
        await logger.warn(`resource spec ${resource.name}: normalized key: ${warning}`);
      }

      await logSchemaBehaviorDefaultWarning(logger, resource, defaultSchemaBehavior);

      // If this resource has for_each, resolve parent values and iterate
      const forEach = normalizeForEachConfig(
        resource.extract && 'for_each' in resource.extract ? resource.extract.for_each : undefined
      );
      const baseInputs = mergeResourceInputs(
        filterInputsForResource(cliInputs, 'input' in resource ? resource.input : undefined),
        resourceInputsMap,
        resource.name
      );
      const explicitInputs = {
        ...baseInputs,
        ...matrixInput,
      };
      const shouldFanOut = forEach !== undefined && !hasExplicitForEachInputs(forEach, baseInputs);
      // Targeting is deliberately all-or-nothing. A complete explicit
      // binding tuple is one direct lookup; a partial tuple remains a
      // normal fan-out, and every bound input is replaced from each
      // parent row below. Never combine caller and parent values into
      // a hybrid tuple.
      if (forEach && shouldFanOut) {
        const cachedParentRecords = forEachCache.get(forEach.resource);
        if (!cachedParentRecords || cachedParentRecords.length === 0) {
          if (!presentResources.has(forEach.resource)) {
            // The parent never ran in this process, so the child cannot
            // share its in-memory forEachCache. Fail loudly rather than
            // silently extracting zero rows.
            const message =
              `for_each parent "${forEach.resource}" did not run in this extraction ` +
              `process — cannot fan out ${resource.name}. Parent and child must extract ` +
              `together in the same process. Select both resources, for example: ` +
              `dogsled extract run --integration ${integrationName} ${forEach.resource} ${resource.name}.`;
            await logger.error(`Failed: ${integrationName}/${resource.name}: ${message}`);
            failedResources += 1;
            resourceResults.push({
              resource: resource.name,
              status: 'error',
              records_emitted: 0,
              api_calls: 0,
              duration_ms: 0,
              error: message,
              failure_reason: 'for_each_parent_not_co_scheduled',
            });
            await logger.progress('resource_error', resource.name, {
              status: 'error',
              error: message,
              failure_reason: 'for_each_parent_not_co_scheduled',
              for_each_parent: forEach.resource,
              ...matrixMetadata,
            });
            return;
          }
          // The parent ran in this process but emitted no records — a
          // legitimately empty parent (e.g. an account with zero workspaces).
          // Record a visible skip so it surfaces in the run summary, but keep
          // the run successful.
          await logger.warn(
            `for_each parent "${forEach.resource}" ran but returned zero records — ` +
              `nothing to fan out, skipping ${resource.name} ` +
              `(expected when the parent is legitimately empty)`
          );
          resourceResults.push({
            resource: resource.name,
            status: 'skipped',
            records_emitted: 0,
            api_calls: 0,
            duration_ms: 0,
          });
          await logger.progress('resource_skip', resource.name, {
            resource: resource.name,
            status: 'skipped',
            reason: 'for_each_parent_empty',
            for_each_parent: forEach.resource,
            ...matrixMetadata,
          });
          return;
        }

        // Apply for_each.where against parent OUTPUT records before
        // iterating. Highest-leverage filter — unmatched parents never
        // get a child fetch. Resolve relative-duration predicates
        // against the run-level timestamp so every resource in the
        // run sees the same cutoff (matters when two children look at
        // the same parent with different windows).
        let parentRecords = cachedParentRecords;
        if (forEach.where && forEach.where.length > 0) {
          const resolvedForEachPredicates = forEach.where.map((predicate) =>
            resolvePredicate(predicate, runStartedAt)
          );
          const beforeFilter = parentRecords.length;
          parentRecords = parentRecords.filter((parent) =>
            resolvedForEachPredicates.every((predicate) =>
              evaluateResolvedPredicate(parent.output, predicate)
            )
          );
          if (parentRecords.length === 0) {
            await logger.warn(
              `for_each.where dropped all ${beforeFilter} ${forEach.resource} parents — skipping ${resource.name}`
            );
            // Surface the skip in run summary + progress accounting so
            // a fully-filtered child isn't invisible to operators.
            resourceResults.push({
              resource: resource.name,
              status: 'skipped',
              records_emitted: 0,
              api_calls: 0,
              duration_ms: 0,
            });
            await logger.progress('resource_skip', resource.name, {
              resource: resource.name,
              status: 'skipped',
              reason: 'for_each_where_filtered_all',
              for_each_parent: forEach.resource,
              for_each_parents_before_filter: beforeFilter,
              ...matrixMetadata,
            });
            return;
          }
          if (parentRecords.length < beforeFilter) {
            await logger.info(
              `for_each.where filtered ${forEach.resource}: ${parentRecords.length}/${beforeFilter} parents passed`
            );
          }
        }

        const iterationInputs = new Map<string, FanOutWorkItem>();
        const filteredCliInputs = explicitInputs;
        for (const parentRecord of parentRecords) {
          const nextInputs: Record<string, unknown> = { ...filteredCliInputs };
          let isComplete = true;

          for (const binding of forEach.bindings) {
            const sourceRecord =
              binding.source === 'input' ? parentRecord.input : parentRecord.output;
            const value = sourceRecord[binding.field];
            if (value === undefined || value === null) {
              isComplete = false;
              break;
            }
            // Fan-out owns the complete bound tuple. This replacement
            // is intentional even when the caller supplied only some
            // of the bound inputs.
            nextInputs[binding.input] = value;
          }

          if (!isComplete) {
            continue;
          }

          const dedupeKey = JSON.stringify([
            forEach.bindings.map((binding) => nextInputs[binding.input]),
            getContextProjectionValues(resource.output, parentRecord.context),
          ]);
          iterationInputs.set(
            dedupeKey,
            Object.freeze({
              inputs: Object.freeze(nextInputs),
              context: parentRecord.context,
            })
          );
        }

        if (iterationInputs.size === 0) {
          // Parent ran and emitted records, but none yielded a complete set of
          // binding values. Surface it as a visible skip (not silent), but keep
          // the run successful — a data-shape issue, not the isolation bug.
          await logger.warn(
            `for_each parent "${forEach.resource}" did not produce complete bindings — skipping ${resource.name}`
          );
          resourceResults.push({
            resource: resource.name,
            status: 'skipped',
            records_emitted: 0,
            api_calls: 0,
            duration_ms: 0,
          });
          await logger.progress('resource_skip', resource.name, {
            resource: resource.name,
            status: 'skipped',
            reason: 'for_each_incomplete_bindings',
            for_each_parent: forEach.resource,
            ...matrixMetadata,
          });
          return;
        }

        await logger.info(
          `Starting extraction: ${integrationName}/${resource.name} (for_each: ${iterationInputs.size} ${forEach.resource})`
        );
        await logger.progress('resource_start', resource.name, {
          ...resourceProgress,
          integration: integrationName,
          configured_limit: opts.limit ?? null,
          full_refresh: opts.fullRefresh === true,
          batch: opts.batch === true,
          for_each_parent: forEach.resource,
          for_each_iterations: iterationInputs.size,
          ...matrixMetadata,
        });

        // Emit schema once before iterating, not per iteration.
        await emitMatrixSchema();

        const startedAt = Date.now();
        let totalForEachRecords = 0;
        let totalForEachApiCalls = 0;
        const primaryKeyTracker = new FanOutPrimaryKeyTracker(resource as ApiResourceSpec);
        // STATE messages are deferred until every iteration completes.
        // Emitting one per iteration forces streaming loaders to flush
        // and durably load a micro-batch per parent record (one
        // destination load job per iteration), which serializes the
        // pipeline behind the destination instead of the source API.
        const deferredStates: Array<{
          bookmark: StreamBookmark;
          partition: string | undefined;
        }> = [];

        await runWithConcurrency(
          [...iterationInputs.values()],
          forEach.concurrency,
          async (workItem) => {
            const mergedInputs = { ...workItem.inputs };
            try {
              assertCompleteFanOutContext(resource.name, resource.output, workItem.context);
              const shouldCacheParent = parentResources.has(resource.name);
              const currentInputs = Object.freeze({ ...mergedInputs });
              const onRecord =
                shouldCacheParent || primaryKeyTracker.enabled
                  ? (record: Record<string, unknown>) => {
                      primaryKeyTracker.observe(record, workItem.context);
                      if (!shouldCacheParent) return;
                      const records = forEachCache.get(resource.name) ?? [];
                      records.push({
                        input: currentInputs,
                        output: record,
                        context: extendFanOutContext(workItem.context, resource.name, record),
                      });
                      forEachCache.set(resource.name, records);
                    }
                  : undefined;

              if (!clientPool) {
                throw new CommandError(
                  `Resource "${resource.name}" requires an API/source integration.`
                );
              }
              const resolvedClient = await clientPool.getForResource(resource as ApiResourceSpec);
              const partition = buildBookmarkPartition(
                pickForEachBindingValues(forEach.bindings, mergedInputs)
              );
              const result = await extractResource({
                integration: resolvedClient.integration,
                integrationName: integrationName,
                resource: resource as ApiResourceSpec,
                client: resolvedClient.client,
                emitter,
                logger,
                state,
                stateStore,
                batchDir,
                opts,
                onRecord,
                inputOverrides: mergedInputs,
                inputContext: currentInputs,
                fanOutContext: workItem.context,
                ...(partition !== undefined ? { partition } : {}),
                skipSchema: true,
                deferStateEmission: true,
              });
              totalForEachRecords += result.recordCount;
              totalForEachApiCalls += result.apiCalls;
              deferredStates.push({ bookmark: result.bookmark, partition });
            } catch (iterationError) {
              const message =
                iterationError instanceof Error ? iterationError.message : String(iterationError);
              await logger.warn(`${resource.name} (${JSON.stringify(mergedInputs)}): ${message}`);
            }
          }
        );

        // Emit the per-partition STATE messages in one trailing burst.
        // Downstream loaders see all of the stream's records first, so
        // the STATE-triggered flush happens once instead of per parent.
        for (const deferred of deferredStates) {
          await emitter.emitState(resource.name, deferred.bookmark, deferred.partition);
        }

        const primaryKeyReport = primaryKeyTracker.report();
        if (primaryKeyReport.collisions > 0) {
          await logger.warn(
            `${resource.name}: declared primary key [${(resource as ApiResourceSpec).extract.table?.primary_key?.join(', ') ?? ''}] collided across ${primaryKeyReport.collisions} distinct fan-out context(s)`
          );
        }
        if (primaryKeyReport.truncated) {
          await logger.warn(
            `${resource.name}: exact cross-context primary-key collision checking was truncated; checked at most ${MAX_FAN_OUT_PRIMARY_KEYS} unique keys across ${primaryKeyReport.observed} records`
          );
        }

        totalRecords += totalForEachRecords;
        const forEachDuration = Date.now() - startedAt;
        await logger.metric(resource.name, {
          records_emitted: totalForEachRecords,
          api_calls: totalForEachApiCalls,
          duration_ms: forEachDuration,
        });
        await logger.info(
          `Completed: ${integrationName}/${resource.name} (${totalForEachRecords} records across ${iterationInputs.size} iterations)`
        );

        resourceResults.push({
          resource: resource.name,
          status: 'success',
          records_emitted: totalForEachRecords,
          api_calls: totalForEachApiCalls,
          duration_ms: forEachDuration,
        });
        circuitBreaker.recordSuccess();
        await logger.progress('resource_complete', resource.name, {
          status: 'success',
          records_emitted: totalForEachRecords,
          api_calls: totalForEachApiCalls,
          duration_ms: forEachDuration,
          elapsed_ms: forEachDuration,
          for_each_iterations: iterationInputs.size,
          ...matrixMetadata,
        });
        return;
      }

      await logger.info(`Starting extraction: ${integrationName}/${resource.name}${matrixLabel}`);
      await logger.progress('resource_start', resource.name, {
        ...resourceProgress,
        integration: integrationName,
        configured_limit: opts.limit ?? null,
        full_refresh: opts.fullRefresh === true,
        batch: opts.batch === true,
        ...matrixMetadata,
      });
      const startedAt = Date.now();

      // Single dispatch over source_kind, per the SourceKind Dispatch
      // Contract. Case bodies live in runtime/dispatch.ts.
      const dispatch = await dispatchSourceKind({
        integration,
        resource,
        integrationName,
        emitter,
        logger,
        state,
        stateStore,
        advanceState: shouldAdvanceDurableState(opts),
        fullRefresh: opts.fullRefresh,
        limit: opts.limit,
        warehouse: opts.warehouse,
        queryTag: opts.queryTag,
        startedAt,
        circuitBreaker,
      });
      if (dispatch.handled) {
        totalRecords += dispatch.recordsEmitted;
        if (dispatch.resourceResult) resourceResults.push(dispatch.resourceResult);
        if (dispatch.failed) failedResources += 1;
        return;
      }

      try {
        await emitMatrixSchema();
        // If this resource is a for_each parent, collect field values from emitted records.
        const shouldCacheParent = parentResources.has(resource.name);
        const currentInputs = Object.freeze({ ...explicitInputs });
        const currentFanOutContext = forEach
          ? buildTargetedFanOutContext(resource as ApiResourceSpec, forEach, explicitInputs)
          : EMPTY_FAN_OUT_CONTEXT;
        assertCompleteFanOutContext(resource.name, resource.output, currentFanOutContext);
        const onRecord = shouldCacheParent
          ? (record: Record<string, unknown>) => {
              const records = forEachCache.get(resource.name) ?? [];
              records.push({
                input: currentInputs,
                output: record,
                context: extendFanOutContext(currentFanOutContext, resource.name, record),
              });
              forEachCache.set(resource.name, records);
            }
          : undefined;

        if (!clientPool) {
          throw new CommandError(`Resource "${resource.name}" requires an API/source integration.`);
        }
        const resolvedClient = await clientPool.getForResource(resource as ApiResourceSpec);
        const result = await extractResource({
          integration: resolvedClient.integration,
          integrationName: integrationName,
          resource: resource as ApiResourceSpec,
          client: resolvedClient.client,
          emitter,
          logger,
          state,
          stateStore,
          batchDir,
          opts,
          onRecord,
          inputOverrides: currentInputs,
          inputContext: currentInputs,
          fanOutContext: currentFanOutContext,
          skipSchema: true,
        });

        const resourceDuration = Date.now() - startedAt;
        totalRecords += result.recordCount;
        await logger.metric(resource.name, {
          records_emitted: result.recordCount,
          api_calls: result.apiCalls,
          duration_ms: resourceDuration,
          ...(result.batchFiles != null
            ? {
                batch_files: result.batchFiles,
                batch_bytes: result.batchBytes,
              }
            : {}),
        });

        if (opts.emitModelSpecSource) {
          const resourceEmbedConfig = embedConfigFromFile
            ? resolveResourceEmbedConfig(embedConfigFromFile, resource.name)
            : undefined;
          await logger.info(
            `MODEL_SPEC source spec:\n${generateModelSpecSource(resource, integrationName, resourceEmbedConfig)}`
          );
        }

        await logger.info(
          `Completed: ${integrationName}/${resource.name}${matrixLabel} (${result.recordCount} records)`
        );

        resourceResults.push({
          resource: resource.name,
          status: 'success',
          records_emitted: result.recordCount,
          api_calls: result.apiCalls,
          duration_ms: resourceDuration,
          cursor_value: result.bookmark.cursor_value,
          ...(result.fieldCoverage ? { field_coverage: result.fieldCoverage } : {}),
        });
        circuitBreaker.recordSuccess();
        await logger.progress('resource_complete', resource.name, {
          status: 'success',
          records_emitted: result.recordCount,
          api_calls: result.apiCalls,
          duration_ms: resourceDuration,
          elapsed_ms: resourceDuration,
          ...matrixMetadata,
          ...(result.batchFiles != null
            ? {
                batch_files: result.batchFiles,
                batch_bytes: result.batchBytes,
              }
            : {}),
        });
      } catch (resourceError) {
        failedResources += 1;
        const resourceDuration = Date.now() - startedAt;
        const message = getErrorMessage(resourceError);
        const failureReason = classifyFailureReason(resourceError);
        const cause = serializeExtractorErrorCause(resourceError);
        await logger.error(`Failed: ${integrationName}/${resource.name}${matrixLabel}: ${message}`);

        resourceResults.push({
          resource: resource.name,
          status: 'error',
          records_emitted: 0,
          api_calls: 0,
          duration_ms: resourceDuration,
          error: message,
          failure_reason: failureReason,
        });
        circuitBreaker.recordFailure();
        await logger.progress('resource_error', resource.name, {
          status: 'error',
          error: message,
          failure_reason: failureReason,
          ...matrixMetadata,
          ...(cause ? { cause: { ...cause } } : {}),
          duration_ms: resourceDuration,
          elapsed_ms: resourceDuration,
        });
      }
    });
  }
  return { totalRecords, failedResources };
}
