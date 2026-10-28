import { DogsledRuntimeError } from '@bobsled-inc/protocol';

import { ExtractorClient, type ClientResponse } from '../client.js';
import { ExtractorConfigError, ExtractorDataError, ExtractorTransientError } from '../errors.js';
import { mapFields } from './field-mapper.js';
import { computeIdempotencyKey } from './idempotency.js';
import {
  classifyHttpStatus,
  isRetryable,
  withRetry,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type ActivationErrorCode,
} from './retry.js';
import type { ActivationResult, ActivationRecord } from './result-emitter.js';
import type { ApiIntegrationSpec } from '../../framework/extractor/resource.js';
import type { ApiAction } from '../../framework/extractor/action.js';

export type { ActivationRecord, ActivationResult } from './result-emitter.js';

export interface ActivationSummary {
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface ActivateDispatchOptions {
  /** Parsed, validated action spec. */
  actionSpec: ApiAction;
  /** Parsed, validated integration spec for the action's integration. */
  integrationSpec: ApiIntegrationSpec;
  /** Records already read from the projection table. */
  records: ActivationRecord[];
  /** Fully-qualified projection table name — used for idempotency key computation. */
  projectionRef: string;
  syncName: string;
  dryRun?: boolean;
  /** Optional limit on the number of records to process. */
  limit?: number;
  idempotencyNamespace?: string;
  /** Stop after this many consecutive failures. Defaults to 5. */
  consecutiveFailureThreshold?: number;
  /** Override retry loop behavior for HTTP/network dispatches. */
  retryConfig?: RetryConfig;
  /** Pre-built ExtractorClient for injection (useful in tests). Falls back to constructing one. */
  client?: ExtractorClient;
  /** Called once per processed record with the result. */
  onResult?: (result: ActivationResult) => Promise<void>;
}

const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 5;

// Allow all 4xx/5xx responses to be returned to the dispatcher for classification.
// Without this, client.request() throws a plain Error before the dispatcher can inspect
// the status code and apply retry logic.
const HTTP_ALLOW_STATUS = Array.from({ length: 200 }, (_, i) => 400 + i);

const VALID_ACTIVATION_ERROR_CODES = new Set<string>([
  'validation_error',
  'auth_error',
  'not_found',
  'conflict',
  'rate_limited',
  'timeout',
  'server_error',
  'network_error',
  'unknown',
]);

function getErrorCode(err: unknown): ActivationErrorCode {
  if (err instanceof ExtractorDataError) return 'validation_error';
  if (err instanceof ExtractorConfigError) return 'auth_error';
  if (err instanceof ExtractorTransientError) return 'network_error';
  if (err instanceof Error && 'code' in err) {
    const code = (err as Error & { code: unknown }).code;
    if (typeof code === 'string' && VALID_ACTIVATION_ERROR_CODES.has(code)) {
      return code as ActivationErrorCode;
    }
  }
  return 'unknown';
}

function getRuntimeErrorCode(err: DogsledRuntimeError): ActivationErrorCode | undefined {
  if (err.providerStatus !== undefined) return classifyHttpStatus(err.providerStatus);
  if (err.kind === 'auth') return 'auth_error';
  if (err.kind === 'timeout') return 'timeout';
  if (err.code === 'EXTRACTOR_HTTP_NETWORK_FAILURE') return 'network_error';
  return undefined;
}

export async function runActivateDispatcher(
  options: ActivateDispatchOptions
): Promise<ActivationSummary> {
  const {
    actionSpec,
    integrationSpec,
    records,
    projectionRef,
    syncName,
    dryRun = false,
    idempotencyNamespace,
    onResult,
  } = options;

  const consecutiveFailureThreshold =
    options.consecutiveFailureThreshold ??
    actionSpec.error_handling?.consecutive_failure_threshold ??
    DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
  const retryConfig = options.retryConfig ?? {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: actionSpec.error_handling?.max_retries ?? DEFAULT_RETRY_CONFIG.maxRetries,
  };

  const limit = options.limit ?? records.length;
  const slice = records.slice(0, limit);

  const summary: ActivationSummary = { succeeded: 0, failed: 0, skipped: 0 };
  let consecutiveFails = 0;
  let client: ExtractorClient | undefined = options.client;

  for (const record of slice) {
    const entityId = String(record.entity_id);
    const idempotencyKey = computeIdempotencyKey({
      action: actionSpec.name,
      targetRecordKey: entityId,
      projectionRef,
      namespace: idempotencyNamespace,
    });

    const attemptedAt = new Date().toISOString();
    const startedAt = Date.now();

    if (dryRun) {
      const result: ActivationResult = {
        entity_id: entityId,
        cluster_id: record.cluster_id,
        status: 'skipped',
        idempotency_key: idempotencyKey,
        action: actionSpec.name,
        sync_name: syncName,
        projection_ref: projectionRef,
        duration_ms: 0,
        attempted_at: attemptedAt,
      };
      summary.skipped++;
      await onResult?.(result);
      continue;
    }

    let mappedRecord: Record<string, unknown>;
    try {
      mappedRecord = mapFields(actionSpec.field_mapping, record);
    } catch (mappingError) {
      if (!(mappingError instanceof ExtractorDataError)) {
        throw mappingError;
      }
      const result: ActivationResult = {
        entity_id: entityId,
        cluster_id: record.cluster_id,
        status: 'failed',
        idempotency_key: idempotencyKey,
        action: actionSpec.name,
        sync_name: syncName,
        projection_ref: projectionRef,
        duration_ms: Date.now() - startedAt,
        attempted_at: attemptedAt,
        error: {
          code: 'validation_error',
          message: mappingError instanceof Error ? mappingError.message : String(mappingError),
          retryable: false,
        },
      };
      summary.failed++;
      consecutiveFails++;
      await onResult?.(result);
      if (consecutiveFails >= consecutiveFailureThreshold) {
        break;
      }
      continue;
    }

    let status: ActivationResult['status'] = 'failed';
    let errorResult: ActivationResult['error'] | undefined;

    client ??= new ExtractorClient({
      integration: integrationSpec,
      secrets: process.env,
      env: process.env,
    });

    try {
      await withRetry(
        async () => {
          let response: ClientResponse;
          try {
            response = await client!.request({
              operation: { api: actionSpec.api, input: actionSpec.input },
              input: mappedRecord,
              allowStatus: HTTP_ALLOW_STATUS,
            });
          } catch (requestError) {
            if (
              requestError instanceof ExtractorConfigError ||
              requestError instanceof ExtractorDataError
            ) {
              throw requestError;
            }
            if (requestError instanceof ExtractorTransientError) {
              throw Object.assign(requestError, {
                code: 'network_error' as ActivationErrorCode,
                retryable: true,
              });
            }
            if (requestError instanceof DogsledRuntimeError) {
              const code = getRuntimeErrorCode(requestError);
              if (code === undefined) throw requestError;
              const message =
                requestError.providerStatus !== undefined
                  ? `HTTP ${requestError.providerStatus}`
                  : requestError.message;
              throw Object.assign(new Error(message, { cause: requestError }), {
                code,
                retryable: isRetryable(code),
              });
            }
            if (requestError instanceof Error && requestError.name === 'TypeError') {
              throw Object.assign(new ExtractorTransientError(requestError.message, requestError), {
                code: 'network_error' as ActivationErrorCode,
                retryable: true,
              });
            }
            throw requestError;
          }
          if (response.status >= 400) {
            const code = classifyHttpStatus(response.status);
            throw Object.assign(new Error(`HTTP ${response.status}`), {
              code,
              retryable: isRetryable(code),
            });
          }
        },
        (err) => {
          if (err instanceof Error && 'retryable' in err) {
            return Boolean((err as Error & { retryable: boolean }).retryable);
          }
          return false;
        },
        retryConfig
      );
      status = 'succeeded';
      consecutiveFails = 0;
    } catch (dispatchError) {
      if (
        dispatchError instanceof ExtractorConfigError ||
        dispatchError instanceof ExtractorDataError
      ) {
        throw dispatchError;
      }
      const code = getErrorCode(dispatchError);
      errorResult = {
        code,
        message: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
        retryable: isRetryable(code),
      };
      status = 'failed';
      consecutiveFails++;
    }

    const result: ActivationResult = {
      entity_id: entityId,
      cluster_id: record.cluster_id,
      status,
      idempotency_key: idempotencyKey,
      action: actionSpec.name,
      sync_name: syncName,
      projection_ref: projectionRef,
      duration_ms: Date.now() - startedAt,
      attempted_at: attemptedAt,
      error: errorResult,
    };

    if (status === 'succeeded') {
      summary.succeeded++;
    } else {
      summary.failed++;
    }

    await onResult?.(result);

    if (consecutiveFails >= consecutiveFailureThreshold) {
      break;
    }
  }

  return summary;
}
