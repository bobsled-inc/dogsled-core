/**
 * Token bucket rate limiter with exponential backoff retry.
 *
 * Supports Retry-After header parsing.
 */

import {
  attachProviderResponseBody,
  safeFetch,
  sanitizeUrlForError,
} from '../framework/core/index.js';
import { DEFAULT_RETRY_BACKOFF, retryDelayMs } from './retry-delay.js';

export interface RateLimiterOptions {
  requestsPerSecond: number;
  burst: number;
  retryOn: number[];
  maxRetries: number;
  backoff: 'exponential' | 'fixed';
  retryAfterHeader: boolean;
}

export const DEFAULT_RATE_LIMIT: RateLimiterOptions = {
  requestsPerSecond: 10,
  burst: 20,
  retryOn: [429, 503],
  ...DEFAULT_RETRY_BACKOFF,
};

export class RateLimitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitTimeoutError';
  }
}

export interface FinalRetryableResponseDetail {
  detail?: string;
  body?: string;
}

/**
 * Reads the final response from an exhausted retry sequence. The callback is
 * deliberately owned by the caller so it can apply request-specific redaction
 * before the detail is copied into an error message and the body is attached.
 */
export type FinalRetryableResponseHandler = (
  response: Response
) => Promise<FinalRetryableResponseDetail | undefined>;

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly options: RateLimiterOptions;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_RATE_LIMIT, ...options };

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
   */
  async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
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
