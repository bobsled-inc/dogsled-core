import { assertExhaustive as assertExhaustiveBase } from '@bobsled-inc/ai';

import {
  isDocumentFileSource,
  isFileStorageResource,
  isLookupOnlyApiResource,
} from '../framework/extractor/index.js';
import {
  reportFileStorageFailure,
  runFileStorageResourceExtraction,
} from '../commands/extract-file-storage.js';
import type { Emitter } from './emitter.js';
import type { ControlLogger } from './control.js';
import { extractDocumentResource } from './document-extraction.js';
import { ExtractorDataError, type ResourceCircuitBreaker } from './errors.js';
import type { ResourceResult } from './run-summary.js';
import type { StateStore } from './state.js';
import { isFileStorageSource } from './file-storage-extractor.js';
import {
  extractWarehouseResource,
  isWarehouseResource,
  isWarehouseSource,
} from './warehouse-extractor.js';
import type { ExtractorState, IntegrationSpec, ResourceSpec } from '../types/index.js';

export type SourceKind =
  'api' | 'lookup_only' | 'warehouse' | 'file_storage_structured' | 'file_storage_document';

export function classifySourceKind(
  integration: IntegrationSpec,
  resource: ResourceSpec
): SourceKind {
  if (isFileStorageSource(integration) && isFileStorageResource(resource)) {
    // `isDocumentFileSource` honors both the explicit `kind: document` discriminator
    // and the user-facing `format: document` alias (per the Resource Grammar
    // Contract). The single helper keeps alias logic in one place.
    return isDocumentFileSource(resource.source)
      ? 'file_storage_document'
      : 'file_storage_structured';
  }
  if (isWarehouseSource(integration) && isWarehouseResource(resource)) {
    return 'warehouse';
  }
  if (isLookupOnlyApiResource(resource)) {
    return 'lookup_only';
  }
  return 'api';
}

/** Re-export with a domain-specific default message; the implementation is shared. */
export function assertExhaustive(value: never, message = 'Unhandled source_kind variant'): never {
  return assertExhaustiveBase(value, message);
}

export interface DispatchContext {
  integration: IntegrationSpec;
  resource: ResourceSpec;
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  advanceState: boolean;
  fullRefresh?: boolean;
  limit?: number;
  warehouse?: string;
  queryTag?: string;
  startedAt: number;
  circuitBreaker: ResourceCircuitBreaker;
}

export interface DispatchResult {
  /**
   * True when the case fully handled the resource. The caller should `continue` its
   * resource loop. False means the caller falls through to the API/MCP transport-client
   * path (the `api` source kind today).
   */
  handled: boolean;
  recordsEmitted: number;
  resourceResult?: ResourceResult;
  failed: boolean;
}

/**
 * Single dispatch over `SourceKind`, per the SourceKind Dispatch Contract.
 * `assertExhaustive` guarantees future kinds cannot land without a matching case.
 */
export async function dispatchSourceKind(ctx: DispatchContext): Promise<DispatchResult> {
  const sourceKind = classifySourceKind(ctx.integration, ctx.resource);
  switch (sourceKind) {
    case 'file_storage_structured': {
      // Type predicate narrows `resource` for the call below. The classifier already
      // checked `isFileStorageResource`; this re-check satisfies the type system at
      // the case-body level and matches the warehouse branch's pattern.
      if (!isFileStorageResource(ctx.resource)) {
        throw new ExtractorDataError(
          `Resource "${ctx.resource.name}" classified as file_storage_structured but failed type narrowing.`
        );
      }
      const result = await runFileStorageResourceExtraction({
        integration: ctx.integration,
        resource: ctx.resource,
        integrationName: ctx.integrationName,
        emitter: ctx.emitter,
        logger: ctx.logger,
        state: ctx.state,
        stateStore: ctx.stateStore,
        advanceState: ctx.advanceState,
        fullRefresh: ctx.fullRefresh,
        limit: ctx.limit,
        startedAt: ctx.startedAt,
        circuitBreaker: ctx.circuitBreaker,
      });
      return {
        handled: true,
        recordsEmitted: result.recordsEmitted,
        resourceResult: result.resourceResult,
        failed: result.failed,
      };
    }
    case 'file_storage_document': {
      if (!isFileStorageResource(ctx.resource)) {
        throw new ExtractorDataError(
          `Resource "${ctx.resource.name}" classified as file_storage_document but failed type narrowing.`
        );
      }
      let result: Awaited<ReturnType<typeof extractDocumentResource>>;
      try {
        result = await extractDocumentResource({
          integration: ctx.integration,
          resource: ctx.resource,
          integrationName: ctx.integrationName,
          emitter: ctx.emitter,
          logger: ctx.logger,
          state: ctx.state,
          stateStore: ctx.stateStore,
          advanceState: ctx.advanceState,
          fullRefresh: ctx.fullRefresh,
          limit: ctx.limit,
          startedAt: ctx.startedAt,
        });
      } catch (error) {
        const failure = await reportFileStorageFailure({
          error,
          integrationName: ctx.integrationName,
          resource: ctx.resource,
          logger: ctx.logger,
          startedAt: ctx.startedAt,
          circuitBreaker: ctx.circuitBreaker,
        });
        return { handled: true, ...failure };
      }
      const duration = Date.now() - ctx.startedAt;
      const totalRecords =
        result.documentsEmitted + result.chunksEmitted + result.parseErrorsEmitted;
      await ctx.logger.info(
        `Completed: ${ctx.integrationName}/${ctx.resource.name} (${result.documentsEmitted} docs, ${result.chunksEmitted} chunks, ${result.parseErrorsEmitted} parse errors)`
      );
      ctx.circuitBreaker.recordSuccess();
      await ctx.logger.progress('resource_complete', ctx.resource.name, {
        records_emitted: totalRecords,
        api_calls: 0,
        duration_ms: duration,
      });
      return {
        handled: true,
        recordsEmitted: totalRecords,
        resourceResult: {
          resource: ctx.resource.name,
          status: 'success',
          records_emitted: totalRecords,
          api_calls: 0,
          duration_ms: duration,
        },
        failed: false,
      };
    }
    case 'warehouse': {
      // Type predicate narrows `resource` from the union type for the call below.
      if (!isWarehouseResource(ctx.resource)) {
        throw new ExtractorDataError(
          `Resource "${ctx.resource.name}" classified as warehouse but failed type narrowing.`
        );
      }
      const whResult = await extractWarehouseResource({
        integration: ctx.integration,
        resource: ctx.resource,
        integrationName: ctx.integrationName,
        emitter: ctx.emitter,
        logger: ctx.logger,
        state: ctx.state,
        stateStore: ctx.stateStore,
        advanceState: ctx.advanceState,
        fullRefresh: ctx.fullRefresh,
        limit: ctx.limit,
        warehouse: ctx.warehouse,
        queryTag: ctx.queryTag,
      });

      const whDuration = Date.now() - ctx.startedAt;
      await ctx.logger.metric(ctx.resource.name, {
        records_emitted: whResult.recordCount,
        api_calls: 0,
        duration_ms: whDuration,
      });
      await ctx.logger.info(
        `Completed: ${ctx.integrationName}/${ctx.resource.name} (${whResult.recordCount} records)`
      );
      ctx.circuitBreaker.recordSuccess();
      await ctx.logger.progress('resource_complete', ctx.resource.name, {
        records_emitted: whResult.recordCount,
        api_calls: 0,
        duration_ms: whDuration,
      });
      return {
        handled: true,
        recordsEmitted: whResult.recordCount,
        resourceResult: {
          resource: ctx.resource.name,
          status: 'success',
          records_emitted: whResult.recordCount,
          api_calls: 0,
          duration_ms: whDuration,
        },
        failed: false,
      };
    }
    case 'api':
      // Caller falls through to the API/MCP transport-client path.
      return { handled: false, recordsEmitted: 0, failed: false };
    case 'lookup_only':
      throw new ExtractorDataError(
        `Resource "${ctx.resource.name}" only supports lookup and cannot be extracted.`
      );
    default:
      assertExhaustive(sourceKind);
  }
}
