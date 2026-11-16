/**
 * Structured error taxonomy for extraction operations.
 * Classifies errors to enable automatic retry, skip, or fail-fast behavior.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  serializeErrorCause,
  BobsledRuntimeError,
  type SerializedErrorCause,
  type BobsledRuntimeErrorOptions,
} from '@bobsled-inc/protocol';
import { getErrorMessage, ResponseBodyLimitError } from '../framework/core/index.js';
import { RateLimitTimeoutError } from './rate-limiter.js';

/** Construct the shared Dogsled failure contract at an extractor boundary. */
export function toExtractorRuntimeError(options: BobsledRuntimeErrorOptions): BobsledRuntimeError {
  return new BobsledRuntimeError(options);
}

/** Preserve the original provider/runtime cause for the parent Dogsled process. */
export function serializeExtractorErrorCause(error: unknown): SerializedErrorCause | undefined {
  return serializeErrorCause(error instanceof BobsledRuntimeError ? error.cause : error);
}

type ErrorWithProviderStatus = Error & { status?: unknown };

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function providerStatus(error: Error): number | undefined {
  const status = (error as ErrorWithProviderStatus).status;
  if (typeof status === 'number' && Number.isInteger(status)) return status;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) return code;
  return error.cause instanceof Error ? providerStatus(error.cause) : undefined;
}

export function toExtractorHttpRuntimeError(
  cause: unknown,
  signal?: AbortSignal
): BobsledRuntimeError {
  if (cause instanceof BobsledRuntimeError) return cause;
  const error = asError(cause);
  if (signal?.aborted || error.name === 'AbortError') {
    return toExtractorRuntimeError({
      kind: 'cancellation',
      code: 'EXTRACTOR_HTTP_CANCELLED',
      operation: 'extractor.http.request',
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof RateLimitTimeoutError || error.name === 'TimeoutError') {
    return toExtractorRuntimeError({
      kind: 'timeout',
      code: 'EXTRACTOR_HTTP_TIMEOUT',
      operation: 'extractor.http.request',
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof ExtractorConfigError) {
    const authFailure = error.failureReason === 'auth_failure';
    return toExtractorRuntimeError({
      kind: authFailure ? 'auth' : 'validation',
      code: authFailure ? 'EXTRACTOR_HTTP_AUTH_FAILURE' : 'EXTRACTOR_HTTP_VALIDATION_FAILURE',
      operation: 'extractor.http.request',
      retryable: false,
      cause: error,
      providerStatus: providerStatus(error),
    });
  }
  if (error instanceof ExtractorDataError) {
    return toExtractorRuntimeError({
      kind: 'validation',
      code: 'EXTRACTOR_HTTP_VALIDATION_FAILURE',
      operation: 'extractor.http.request',
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof ResponseBodyLimitError) {
    return toExtractorRuntimeError({
      kind: 'validation',
      code: 'EXTRACTOR_HTTP_RESPONSE_BODY_LIMIT',
      operation: 'extractor.http.request',
      retryable: false,
      cause: error,
    });
  }
  const status = providerStatus(error);
  if (status !== undefined) {
    return toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
      operation: 'extractor.http.request',
      retryable: false,
      providerStatus: status,
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_NETWORK_FAILURE',
      operation: 'extractor.http.request',
      retryable: true,
      cause: error,
    });
  }
  return toExtractorRuntimeError({
    kind: 'internal',
    code: 'EXTRACTOR_HTTP_REQUEST_FAILURE',
    operation: 'extractor.http.request',
    retryable: false,
    cause: error,
  });
}

const TOKEN_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

/**
 * Classify a failure to obtain request credentials. Only a token endpoint that
 * refused the credentials (400, 401, 403) is an authentication failure; a
 * throttled or failing endpoint keeps its status and stays retryable.
 */
export function toExtractorAuthRuntimeError(
  cause: unknown,
  signal?: AbortSignal
): BobsledRuntimeError {
  if (cause instanceof BobsledRuntimeError) return cause;
  const error = asError(cause);
  if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') {
    return toExtractorHttpRuntimeError(error, signal);
  }
  const status = (error as ErrorWithProviderStatus).status;
  const providerStatusValue =
    typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  if (providerStatusValue !== undefined && !TOKEN_REJECTION_STATUSES.has(providerStatusValue)) {
    return toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_AUTH_PROVIDER_FAILURE',
      operation: 'extractor.http.request',
      retryable: providerStatusValue === 429 || providerStatusValue >= 500,
      providerStatus: providerStatusValue,
      cause: error,
    });
  }
  if (providerStatusValue === undefined && error instanceof TypeError) {
    return toExtractorHttpRuntimeError(error, signal);
  }
  return toExtractorRuntimeError({
    kind: 'auth',
    code: 'EXTRACTOR_HTTP_AUTH_FAILURE',
    operation: 'extractor.http.request',
    retryable: false,
    cause: error,
  });
}

export function toExtractorMcpRuntimeError(
  cause: unknown,
  signal?: AbortSignal
): BobsledRuntimeError {
  if (cause instanceof BobsledRuntimeError) return cause;
  const error = signal?.aborted && signal.reason instanceof Error ? signal.reason : asError(cause);
  if (signal?.aborted || error.name === 'AbortError') {
    return toExtractorRuntimeError({
      kind: 'cancellation',
      code: 'EXTRACTOR_MCP_CANCELLED',
      operation: 'extractor.mcp.call_tool',
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof ExtractorConfigError || error instanceof ExtractorDataError) {
    return toExtractorRuntimeError({
      kind: 'validation',
      code: 'EXTRACTOR_MCP_VALIDATION_FAILURE',
      operation: 'extractor.mcp.call_tool',
      retryable: false,
      cause: error,
      providerStatus: providerStatus(error),
    });
  }
  if (error instanceof ExtractorTransientError) {
    return toExtractorRuntimeError({
      kind: error.failureReason === 'timeout' ? 'timeout' : 'provider',
      code:
        error.failureReason === 'timeout'
          ? 'EXTRACTOR_MCP_TIMEOUT'
          : 'EXTRACTOR_MCP_TRANSIENT_ERROR',
      operation: 'extractor.mcp.call_tool',
      retryable: error.retryable,
      cause: error,
      providerStatus: providerStatus(error),
    });
  }
  return toExtractorRuntimeError({
    kind: 'internal',
    code: 'EXTRACTOR_MCP_CALL_FAILURE',
    operation: 'extractor.mcp.call_tool',
    retryable: false,
    cause: error,
  });
}

export class ExtractorTransientError extends Error {
  readonly retryable = true as const;
  readonly failureReason: Extract<
    FailureReason,
    'transient_error' | 'rate_limit_exhausted' | 'timeout'
  >;
  constructor(
    message: string,
    public readonly cause?: Error,
    failureReason: Extract<
      FailureReason,
      'transient_error' | 'rate_limit_exhausted' | 'timeout'
    > = 'transient_error'
  ) {
    super(message);
    this.name = 'ExtractorTransientError';
    this.failureReason = failureReason;
  }
}

export class ExtractorConfigError extends Error {
  readonly retryable = false as const;
  readonly failureReason: Extract<FailureReason, 'auth_failure' | 'config_error'>;
  constructor(
    message: string,
    public readonly cause?: Error,
    failureReason: Extract<FailureReason, 'auth_failure' | 'config_error'> = 'config_error'
  ) {
    super(message);
    this.name = 'ExtractorConfigError';
    this.failureReason = failureReason;
  }
}

export class ExtractorDataError extends Error {
  readonly retryable = false as const;
  readonly failureReason = 'data_error' as const;
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ExtractorDataError';
  }
}

export type ExtractorError = ExtractorTransientError | ExtractorConfigError | ExtractorDataError;

// ── Failure reason classification ──

export type { FailureReason } from '@bobsled-inc/protocol';

import type { FailureReason } from '@bobsled-inc/protocol';

export function classifyFailureReason(error: unknown): FailureReason {
  if (error instanceof BobsledRuntimeError) {
    switch (error.kind) {
      case 'auth':
        return 'auth_failure';
      case 'validation':
        return 'config_error';
      case 'provider':
        return error.retryable ? 'transient_error' : 'data_error';
      case 'timeout':
        return 'timeout';
      case 'cancellation':
      case 'internal':
        return 'transient_error';
    }
  }
  const classified =
    error instanceof ExtractorConfigError ||
    error instanceof ExtractorDataError ||
    error instanceof ExtractorTransientError
      ? error
      : error instanceof McpError
        ? classifyMcpError(error)
        : error;

  if (
    classified instanceof ExtractorConfigError ||
    classified instanceof ExtractorDataError ||
    classified instanceof ExtractorTransientError
  ) {
    return classified.failureReason;
  }
  return 'transient_error';
}

// ── Circuit breaker ──

export class ResourceCircuitBreaker {
  private consecutiveFailures = 0;

  constructor(private readonly maxFailures: number = 5) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
  }

  get isOpen(): boolean {
    return this.maxFailures > 0 && this.consecutiveFailures >= this.maxFailures;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }
}

/**
 * Classify structured MCP/JSON-RPC errors for retry decisions. Unknown values
 * remain transient; provider message text never affects the decision.
 */
export function classifyMcpError(error: unknown): ExtractorError {
  const message = typeof error === 'string' ? error : getErrorMessage(error);

  // Tier 1: Structured MCP/JSON-RPC error codes
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.MethodNotFound:
      case ErrorCode.InvalidRequest:
      case ErrorCode.InvalidParams:
        return new ExtractorConfigError(message, error);
      case ErrorCode.ConnectionClosed:
      case ErrorCode.InternalError:
        return new ExtractorTransientError(message, error);
      case ErrorCode.RequestTimeout:
        return new ExtractorTransientError(message, error, 'timeout');
    }
  }

  if (error instanceof StreamableHTTPError && error.code !== undefined) {
    const status = error.code;
    const classified =
      status === 429 || status >= 500
        ? new ExtractorTransientError(message, error)
        : new ExtractorConfigError(message, error);
    Object.assign(classified, { status });
    return classified;
  }

  return new ExtractorTransientError(message);
}

/** Check if an error indicates a transport/connection failure. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
    return true;
  }

  // Prefer structured error.code when available (Node.js system errors)
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EPIPE' ||
      code === 'ETIMEDOUT'
    ) {
      return true;
    }
  }

  return false;
}

/** Retry a function with exponential backoff for transient errors. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      opts.signal?.throwIfAborted();
      const isLast = attempt === maxRetries;

      if ((err as { retryable?: unknown } | null)?.retryable === false) {
        throw err; // Non-retryable, fail immediately
      }

      if (isLast) throw err;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5); // Add jitter
      opts.onRetry?.(attempt + 1, err as Error, jitter);
      await abortableDelay(jitter, opts.signal);
    }
  }

  throw new Error('withRetry: unreachable');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError')
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
