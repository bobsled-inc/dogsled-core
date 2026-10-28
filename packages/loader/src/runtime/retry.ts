export class CircuitBreakerError extends Error {
  constructor(consecutiveFailures: number) {
    super(`Circuit breaker tripped after ${consecutiveFailures} consecutive failures`);
    this.name = 'CircuitBreakerError';
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delay: number, error: Error) => void;
  maxConsecutiveFailures?: number;
  jitterFactor?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

/** Check if an error is retryable based on HTTP status codes and network error codes. */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Network errors (string codes like ECONNRESET)
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'];
  const code = (error as { code?: string | number }).code;
  if (typeof code === 'string' && networkCodes.includes(code)) return true;

  // Numeric HTTP status codes (some libraries set error.code as number)
  if (typeof code === 'number') {
    if (code === 429 || (code >= 500 && code <= 599)) return true;
  }

  // BigQuery / GCP errors include status text in the message
  const message = error.message;
  if (/rate limit/i.test(message)) return true;
  if (/rateLimitExceeded/i.test(message)) return true;
  if (/quotaExceeded/i.test(message)) return true;
  if (/service unavailable/i.test(message)) return true;

  // AWS S3-specific retryable error codes
  if (/ThrottlingException/i.test(message)) return true;
  if (/SlowDown/i.test(message)) return true;
  if (/ServiceUnavailable/i.test(message)) return true;
  if (/RequestTimeout/i.test(message)) return true;

  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryable = options?.retryable ?? isRetryableError;
  const onRetry = options?.onRetry;
  const maxConsecutiveFailures = options?.maxConsecutiveFailures;
  const jitterFactor = options?.jitterFactor ?? 1;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new Error('initialDelayMs must be a finite number >= 0');
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('maxDelayMs must be a finite number >= 0');
  }

  let lastError: unknown;
  let consecutiveFailures = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      consecutiveFailures++;

      if (maxConsecutiveFailures !== undefined && consecutiveFailures >= maxConsecutiveFailures) {
        throw new CircuitBreakerError(consecutiveFailures);
      }

      if (attempt === maxAttempts || !retryable(error)) {
        throw error;
      }

      // Exponential backoff with configurable jitter; 0 = no jitter for deterministic delays
      const baseDelay = initialDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelay * jitterFactor;
      const delay = Math.min(baseDelay + jitter, maxDelayMs);

      if (onRetry) {
        onRetry(attempt, delay, error instanceof Error ? error : new Error(String(error)));
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError instanceof Error ? lastError : new Error('Retry failed');
}
