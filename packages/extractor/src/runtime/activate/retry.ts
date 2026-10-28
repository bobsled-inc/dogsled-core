export type ActivationErrorCode =
  | 'validation_error'
  | 'auth_error'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network_error'
  | 'unknown';

const RETRYABLE_ERROR_CODES = new Set<ActivationErrorCode>([
  'rate_limited',
  'timeout',
  'server_error',
  'network_error',
]);

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
};

export function isRetryable(errorCode: ActivationErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(errorCode);
}

export function computeBackoffMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.pow(2, attempt);
}

export function classifyHttpStatus(status: number): ActivationErrorCode {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'validation_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

function asRetryError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim().length > 0) return new Error(error);
  return new Error(fallbackMessage);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  if (!Number.isFinite(config.maxRetries) || config.maxRetries < 0) {
    throw new TypeError('maxRetries must be a non-negative finite number');
  }
  if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0) {
    throw new TypeError('baseDelayMs must be a non-negative finite number');
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < config.maxRetries && shouldRetry(error)) {
        const delayMs = computeBackoffMs(attempt, config.baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw asRetryError(error, 'retry failed: no error captured');
    }
  }
  throw asRetryError(lastError, 'retry failed: no error captured');
}
