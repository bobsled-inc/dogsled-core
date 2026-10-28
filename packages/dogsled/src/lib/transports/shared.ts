import { DOGSLED_RUNTIME_ERROR_KINDS, type DogsledRuntimeErrorKind } from '@bobsled-inc/protocol';

import type { ActionErrorCode } from '../action-executor.js';

export interface TransportErrorClassification {
  code: ActionErrorCode;
  message: string;
  retryable: boolean;
}

export interface TransportStatusClassification {
  code: ActionErrorCode;
  retryable: boolean;
}

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;
const TIMEOUT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);
const DOGSLED_RUNTIME_ERROR_KIND_SET: ReadonlySet<string> = new Set(DOGSLED_RUNTIME_ERROR_KINDS);

interface RuntimeFailure {
  kind: DogsledRuntimeErrorKind;
  providerStatus?: number;
}

/** Return an error message that does not include upstream URLs, bodies, or credentials. */
export function safeTransportErrorMessage(code: ActionErrorCode): string {
  switch (code) {
    case 'auth_error':
      return 'The external service rejected authentication.';
    case 'not_found':
      return 'The external target was not found.';
    case 'conflict':
      return 'The external service reported a conflict.';
    case 'rate_limited':
      return 'The external service rate-limited the Action.';
    case 'timeout':
      return 'The Action timed out.';
    case 'cancelled':
      return 'The Action was cancelled.';
    case 'server_error':
      return 'The external service failed.';
    case 'network_error':
      return 'The external service could not be reached.';
    case 'validation_error':
      return 'The Action request was invalid.';
    case 'unknown':
      return 'The Action failed.';
  }
}

function collectErrorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [];
  let current = error;
  while (
    current &&
    typeof current === 'object' &&
    'cause' in current &&
    (current as { cause?: unknown }).cause !== undefined
  ) {
    current = (current as { cause?: unknown }).cause;
    causes.push(current);
  }
  return causes;
}

function extractErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }

  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function readRuntimeFailure(error: unknown): RuntimeFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { name, kind, providerStatus } = error as {
    name?: unknown;
    kind?: unknown;
    providerStatus?: unknown;
  };
  if (name !== 'DogsledRuntimeError') return undefined;
  if (typeof kind !== 'string' || !DOGSLED_RUNTIME_ERROR_KIND_SET.has(kind)) return undefined;
  return {
    kind: kind as DogsledRuntimeErrorKind,
    ...(isHttpStatus(providerStatus) ? { providerStatus } : {}),
  };
}

function classifyRuntimeFailure(errorChain: unknown[]): TransportStatusClassification | undefined {
  for (const candidate of errorChain) {
    const failure = readRuntimeFailure(candidate);
    if (!failure) continue;
    if (failure.providerStatus !== undefined) return mapStatusToError(failure.providerStatus);
    switch (failure.kind) {
      case 'auth':
        return { code: 'auth_error', retryable: false };
      case 'timeout':
        return { code: 'timeout', retryable: true };
      case 'cancellation':
        return errorChain.some((cause) => isTimeoutError(cause))
          ? { code: 'timeout', retryable: true }
          : { code: 'cancelled', retryable: false };
      case 'validation':
      case 'provider':
      case 'internal':
        return undefined;
    }
  }
  return undefined;
}

/** Maps transport-layer HTTP status codes to action error semantics. */
export function mapStatusToError(status: number): TransportStatusClassification {
  switch (status) {
    case 401:
    case 403:
      return { code: 'auth_error', retryable: false };
    case 404:
      return { code: 'not_found', retryable: false };
    case 409:
      return { code: 'conflict', retryable: false };
    case 400:
    case 422:
      return { code: 'validation_error', retryable: false };
    case 408:
      return { code: 'timeout', retryable: true };
    case 429:
      return { code: 'rate_limited', retryable: true };
    default:
      if (status >= 500) {
        return { code: 'server_error', retryable: true };
      }
      return { code: 'unknown', retryable: false };
  }
}

/** Normalizes transport exceptions into action error semantics. */
export function classifyTransportError(
  error: unknown,
  statusPattern?: RegExp
): TransportErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const errorChain = [error, ...collectErrorCauses(error)];
  const errorCodes = errorChain
    .map((candidate) => extractErrorCode(candidate))
    .filter((candidate): candidate is string => candidate !== undefined);

  const runtimeClassification = classifyRuntimeFailure(errorChain);
  if (runtimeClassification) {
    return { ...runtimeClassification, message };
  }

  if (statusPattern) {
    const statusMatch = statusPattern.exec(message);
    if (statusMatch) {
      const status = Number.parseInt(statusMatch[1]!, 10);
      return {
        ...mapStatusToError(status),
        message,
      };
    }
  }

  if (errorChain.some((candidate) => isAbortError(candidate))) {
    return { code: 'timeout', message, retryable: true };
  }

  if (errorCodes.some((code) => TIMEOUT_ERROR_CODES.has(code))) {
    return { code: 'timeout', message, retryable: true };
  }

  if (errorCodes.some((code) => NETWORK_ERROR_CODES.has(code))) {
    return { code: 'network_error', message, retryable: true };
  }

  return { code: 'unknown', message, retryable: false };
}
