import { DogsledRuntimeError } from '@bobsled-inc/protocol';

import { isFileCopyResource } from '../framework/extractor/index.js';
import type {
  FileCopyResourceSpec,
  FileResourceSpec,
  ExtractorState,
  IntegrationSpec,
} from '../types/index.js';
import type { ControlLogger } from '../runtime/control.js';
import type { Emitter } from '../runtime/emitter.js';
import {
  ExtractorConfigError,
  classifyFailureReason,
  serializeExtractorErrorCause,
  type ResourceCircuitBreaker,
} from '../runtime/errors.js';
import { extractFileStorageResource } from '../runtime/file-storage-extractor.js';
import type { ResourceResult } from '../runtime/run-summary.js';
import type { StateStore } from '../runtime/state.js';
import { getErrorMessage } from '../framework/core/shared.js';

export interface FileStorageCommandResult {
  recordsEmitted: number;
  failed: boolean;
  resourceResult: ResourceResult;
}

export async function runFileStorageResourceExtraction({
  integration,
  resource,
  integrationName,
  emitter,
  logger,
  state,
  stateStore,
  advanceState,
  stateWriteDisabled,
  fullRefresh,
  limit,
  startedAt,
  circuitBreaker,
}: {
  integration: IntegrationSpec;
  resource: FileResourceSpec | FileCopyResourceSpec;
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  advanceState: boolean;
  stateWriteDisabled?: boolean;
  fullRefresh?: boolean;
  limit?: number;
  startedAt: number;
  circuitBreaker: ResourceCircuitBreaker;
}): Promise<FileStorageCommandResult> {
  const controller = new AbortController();
  const abortForSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return;
    const reason = new Error(`Received ${signal}; cancelling file extraction`);
    reason.name = 'AbortError';
    controller.abort(reason);
  };
  const onSigint = (): void => abortForSignal('SIGINT');
  const onSigterm = (): void => abortForSignal('SIGTERM');

  // File extraction owns a native DuckDB stream and a staged file. Handle
  // process cancellation only for this scoped operation so both can unwind
  // before the command reports a failed resource. Keep handlers installed during
  // cleanup: terminal signals can also be forwarded by the parent process.
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const shared = {
      integration,
      integrationName,
      emitter,
      logger,
      state,
      stateStore,
      advanceState,
      fullRefresh,
      limit,
      signal: controller.signal,
    };
    let recordCount = 0;
    let completed: string;
    if (isFileCopyResource(resource)) {
      if (!emitter.writesToPipe) {
        throw new ExtractorConfigError(
          `Resource "${resource.name}" copies files, so it must write to a pipe that a loader ` +
            'reads, not to a file or a terminal. Run it with "dogsled pipeline --dest local" ' +
            '(or --dest s3, --dest gcs), or pipe its output into "dogsled load run".'
        );
      }
      if (stateWriteDisabled) {
        throw new ExtractorConfigError(
          `Resource "${resource.name}" copies files, so it cannot run with --no-state-write: it ` +
            'saves its state only after the loader has written every file. A pipeline runs the ' +
            'extractor that way for several destinations, and for --destinations-json even with ' +
            'one, so give it a single destination.'
        );
      }
      // Loaded only for a copy, like the dialect clients of warehouse sources.
      const { extractFileCopyResource } = await import('../runtime/file-copy-extractor.js');
      const copied = await extractFileCopyResource({ ...shared, resource });
      completed = `${copied.filesCopied} file(s), ${copied.bytesCopied} bytes copied`;
    } else {
      recordCount = (await extractFileStorageResource({ ...shared, resource })).recordCount;
      completed = `${recordCount} records`;
    }
    controller.signal.throwIfAborted();
    const duration = Date.now() - startedAt;
    await logger.info(`Completed: ${integrationName}/${resource.name} (${completed})`);
    circuitBreaker.recordSuccess();
    await logger.progress('resource_complete', resource.name, {
      records_emitted: recordCount,
      api_calls: 0,
      duration_ms: duration,
    });
    return {
      recordsEmitted: recordCount,
      failed: false,
      resourceResult: {
        resource: resource.name,
        status: 'success',
        records_emitted: recordCount,
        api_calls: 0,
        duration_ms: duration,
      },
    };
  } catch (error) {
    return reportFileStorageFailure({
      error,
      integrationName,
      resource,
      logger,
      startedAt,
      circuitBreaker,
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

/** Report a failed file Resource the same way for structured and document extraction. */
export async function reportFileStorageFailure({
  error,
  integrationName,
  resource,
  logger,
  startedAt,
  circuitBreaker,
}: {
  error: unknown;
  integrationName: string;
  resource: { name: string };
  logger: ControlLogger;
  startedAt: number;
  circuitBreaker: ResourceCircuitBreaker;
}): Promise<FileStorageCommandResult> {
  const duration = Date.now() - startedAt;
  const message = getErrorMessage(error);
  const failureReason = classifyFailureReason(error);
  const cause = serializeExtractorErrorCause(error);
  const errorCode = error instanceof DogsledRuntimeError ? error.code : undefined;
  // The code rides as an attribute so it survives --quiet, which drops PROGRESS.
  await logger.log(
    'error',
    `Failed: ${integrationName}/${resource.name}: ${message}`,
    undefined,
    errorCode ? { error_code: errorCode } : undefined
  );
  circuitBreaker.recordFailure();
  await logger.progress('resource_error', resource.name, {
    error: message,
    failure_reason: failureReason,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(cause ? { cause: { ...cause } } : {}),
  });
  return {
    recordsEmitted: 0,
    failed: true,
    resourceResult: {
      resource: resource.name,
      status: 'error',
      records_emitted: 0,
      api_calls: 0,
      duration_ms: duration,
      error: message,
      ...(errorCode ? { error_code: errorCode } : {}),
      failure_reason: failureReason,
    },
  };
}
