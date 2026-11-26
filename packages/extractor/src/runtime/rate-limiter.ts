/**
 * Token bucket rate limiter with retries.
 *
 * A read retries each attempt on its own timeout. A timeout, a dropped
 * connection, a failed read of the response body and a retryable HTTP status
 * each use up one attempt. The wait between attempts follows the provider's
 * Retry-After header when it sends one, and otherwise uses exponential backoff
 * with full jitter. A request that changes data keeps the earlier loop.
 */

import {
  attachProviderResponseBody,
  safeFetch,
  sanitizeUrlForError,
} from '../framework/core/index.js';
import {
  RateLimitTimeoutError,
  runAttempt,
  type FetchRetryOptions,
  type FinalRetryableResponseDetail,
  type FinalRetryableResponseHandler,
  type RequestRetryEvent,
} from './request-attempt.js';
import { DEFAULT_RETRY_BACKOFF, jitteredRetryDelayMs, retryDelayMs } from './retry-delay.js';

export { RateLimitTimeoutError, RequestRetryError } from './request-attempt.js';
export type {
  FetchRetryOptions,
  FinalRetryableResponseDetail,
  FinalRetryableResponseHandler,
  RequestRetryEvent,
} from './request-attempt.js';

export interface RateLimiterOptions {
  requestsPerSecond: number;
  burst: number;
  /** HTTP statuses that are retried. */
  retryOn: number[];
  /** Retries after the first attempt, so a request makes at most `maxRetries + 1` attempts. */
  maxRetries: number;
  backoff: 'exponential' | 'fixed';
  retryAfterHeader: boolean;
}

/**
 * Defaults of a request that changes data. A read uses `READ_RETRY_ON` and
 * `READ_MAX_RETRIES` where the options set none.
 */
export const DEFAULT_RATE_LIMIT: RateLimiterOptions = {
  requestsPerSecond: 10,
  burst: 20,
  retryOn: [429, 503],
  ...DEFAULT_RETRY_BACKOFF,
};

/** The statuses a read retries where the options set none. */
const READ_RETRY_ON: readonly number[] = [429, 502, 503, 504];

/** The retries a read makes where the options set none: 5 attempts in all. */
const READ_MAX_RETRIES = 4;

/** Time each attempt of a read gets, response body included, when the caller sets none. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly options: RateLimiterOptions;
  private readonly retryOnConfigured: boolean;
  private readonly maxRetriesConfigured: boolean;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_RATE_LIMIT, ...options };
    this.retryOnConfigured = options.retryOn !== undefined;
    this.maxRetriesConfigured = options.maxRetries !== undefined;

    if (this.options.requestsPerSecond <= 0) {
      throw new Error('requestsPerSecond must be positive');
    }
    if (this.options.burst <= 0) {
      throw new Error('burst must be positive');
    }
    if (this.options.maxRetries < 0) {
      throw new Error('maxRetries must be non-negative');
    }

    this.tokens = this.options.burst;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume one.
   */
  async acquire(signal?: AbortSignal | null): Promise<void> {
    signal?.throwIfAborted();
    this.refill();

    while (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      const waitMs = (deficit / this.options.requestsPerSecond) * 1000;
      await sleep(Math.max(1, waitMs), signal);
      this.refill();
    }

    this.tokens -= 1;
  }

  /**
   * Execute a fetch with rate limiting and retry logic.
   *
   * A read gets `timeoutMs` for each attempt, covering the response body until
   * it is read, and makes up to 5 attempts unless `maxRetries` says otherwise.
   * It fails with an error that names the attempts and why the last one failed.
   * A caller cancellation through `init.signal` ends the request at once and is
   * never retried.
   *
   * A request that changes data passes `idempotent: false` and keeps the
   * earlier loop: `timeoutMs` is one deadline for every attempt and wait, only
   * the statuses in `retryOn` (429 and 503 by default) and errors before a
   * response are retried, and the caller reads the body after the loop.
   */
  async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    beforeAttempt?: () => void,
    onFinalRetryableResponse?: FinalRetryableResponseHandler,
    options: FetchRetryOptions = {}
  ): Promise<Response> {
    if (options.idempotent === false) {
      return await this.fetchWithSharedDeadline(
        url,
        init,
        timeoutMs,
        beforeAttempt,
        onFinalRetryableResponse
      );
    }

    const maxAttempts =
      (this.maxRetriesConfigured ? this.options.maxRetries : READ_MAX_RETRIES) + 1;
    const retryOn = this.retryOnConfigured ? this.options.retryOn : READ_RETRY_ON;

    for (let attempt = 1; ; attempt++) {
      await this.acquire(init.signal);
      beforeAttempt?.();

      const result = await runAttempt(url, init, {
        timeoutMs,
        retryOn,
        lastAttempt: attempt === maxAttempts,
        onFinalRetryableResponse,
        readBody: options.readBody,
      });
      if (result.ok) return result.response;

      if (attempt === maxAttempts) {
        throw result.toError(attempt);
      }

      const waitMs = jitteredRetryDelayMs(this.options, result.response, attempt - 1);
      await notifyRetry(options.onRetry, {
        attempt,
        maxAttempts,
        category: result.category,
        reason: result.label,
        ...(result.status !== undefined ? { status: result.status } : {}),
        waitMs,
      });
      await sleep(waitMs, init.signal);
    }
  }

  /**
   * The loop that every request used before reads got their own timeout per
   * attempt, kept as it was for a request that changes data.
   */
  private async fetchWithSharedDeadline(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    beforeAttempt?: () => void,
    onFinalRetryableResponse?: FinalRetryableResponseHandler
  ): Promise<Response> {
    let lastError: Error | undefined;
    const deadlineAt = Date.now() + timeoutMs;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      await this.acquire(init.signal);

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new RateLimitTimeoutError(
          `Request timed out after ${timeoutMs}ms: ${sanitizeUrlForError(url)}`
        );
      }
      const deadlineSignal = AbortSignal.timeout(remainingMs);
      const requestSignal = init.signal
        ? AbortSignal.any([init.signal, deadlineSignal])
        : deadlineSignal;
      beforeAttempt?.();
      try {
        const response = await safeFetch(url, { ...init, signal: requestSignal });

        if (!this.options.retryOn.includes(response.status)) {
          // Keep requestSignal attached to the returned response: aborting at
          // the original deadline also terminates a slow response body.
          return response;
        }

        let finalResponse: FinalRetryableResponseDetail | undefined;
        if (attempt === this.options.maxRetries && onFinalRetryableResponse) {
          // Diagnostics are best effort. A response-body read must never mask
          // the exhausted provider status or alter retry behavior.
          try {
            finalResponse = await onFinalRetryableResponse(response);
          } catch {
            finalResponse = undefined;
          }
        }
        await response.body?.cancel().catch(() => undefined);
        const detail = finalResponse?.detail;
        lastError = attachProviderResponseBody(
          Object.assign(
            new Error(
              `HTTP ${response.status}: ${response.statusText}${detail ? ` - ${detail}` : ''}`
            ),
            { status: response.status }
          ),
          finalResponse?.body
        );

        if (attempt < this.options.maxRetries) {
          const waitMs = this.getRetryDelay(response, attempt);
          if (Date.now() + waitMs >= deadlineAt) {
            throw new RateLimitTimeoutError(
              `Request timed out after ${timeoutMs}ms: ${sanitizeUrlForError(url)}`
            );
          }
          await sleep(waitMs, init.signal);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (deadlineSignal.aborted) {
          if (init.signal?.aborted) {
            throw init.signal.reason instanceof Error
              ? init.signal.reason
              : new DOMException('The operation was aborted.', 'AbortError');
          }
          throw new RateLimitTimeoutError(
            `Request timed out after ${timeoutMs}ms: ${sanitizeUrlForError(url)}`
          );
        }
        // An upstream cancellation is intentional and must not be retried.
        if (init.signal?.aborted || lastError.name === 'AbortError') throw lastError;

        if (attempt < this.options.maxRetries) {
          const waitMs = this.getRetryDelay(undefined, attempt);
          if (Date.now() + waitMs >= deadlineAt) {
            throw new RateLimitTimeoutError(
              `Request timed out after ${timeoutMs}ms: ${sanitizeUrlForError(url)}`
            );
          }
          await sleep(waitMs, init.signal);
        }
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.options.requestsPerSecond;
    this.tokens = Math.min(this.options.burst, this.tokens + newTokens);
    this.lastRefill = now;
  }

  private getRetryDelay(response: Response | undefined, attempt: number): number {
    return retryDelayMs(this.options, response, attempt);
  }
}

/** A failure to report a retry must never change the retry. */
async function notifyRetry(
  onRetry: FetchRetryOptions['onRetry'],
  event: RequestRetryEvent
): Promise<void> {
  try {
    await onRetry?.(event);
  } catch {
    // Diagnostics are best effort.
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError')
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
