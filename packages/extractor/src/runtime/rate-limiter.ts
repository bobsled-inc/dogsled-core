/**
 * Token bucket rate limiter that retries each attempt of a request.
 *
 * Every attempt has its own timeout. A timeout, a dropped connection, a failed
 * read of the response body and a retryable HTTP status each use up one attempt.
 * The wait between attempts follows the provider's Retry-After header when it
 * sends one, and otherwise uses exponential backoff with full jitter.
 */

import {
  runAttempt,
  type FetchRetryOptions,
  type FinalRetryableResponseHandler,
  type RequestRetryEvent,
} from './request-attempt.js';
import { DEFAULT_RETRY_BACKOFF, jitteredRetryDelayMs } from './retry-delay.js';

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

export const DEFAULT_RATE_LIMIT: RateLimiterOptions = {
  requestsPerSecond: 10,
  burst: 20,
  retryOn: [429, 502, 503, 504],
  ...DEFAULT_RETRY_BACKOFF,
  maxRetries: 4,
};

/** Time each attempt gets, response body included, when the caller sets none. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/** Statuses a gateway sends while the provider may still be doing the work. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 504]);

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly options: RateLimiterOptions;
  private readonly retryOnConfigured: boolean;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_RATE_LIMIT, ...options };
    this.retryOnConfigured = options.retryOn !== undefined;

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
   * Each attempt gets `timeoutMs`, covering the response body until it is read.
   * The request fails after `maxRetries + 1` attempts, with an error that names
   * the attempts and why the last one failed. A caller cancellation through
   * `init.signal` ends the request at once and is never retried.
   */
  async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    beforeAttempt?: () => void,
    onFinalRetryableResponse?: FinalRetryableResponseHandler,
    options: FetchRetryOptions = {}
  ): Promise<Response> {
    const maxAttempts = this.options.maxRetries + 1;
    const idempotent = options.idempotent ?? true;
    const retryOn = this.statusesToRetry(idempotent);

    for (let attempt = 1; ; attempt++) {
      await this.acquire(init.signal);
      beforeAttempt?.();

      const result = await runAttempt(url, init, {
        timeoutMs,
        retryOn,
        idempotent,
        lastAttempt: attempt === maxAttempts,
        onFinalRetryableResponse,
        readBody: options.readBody,
      });
      if (result.ok) return result.response;

      if (!result.retry || attempt === maxAttempts) {
        throw result.toError(attempt);
      }

      const waitMs = jitteredRetryDelayMs(this.options, result.response, attempt - 1);
      await notifyRetry(options.onRetry, {
        attempt,
        maxAttempts,
        category: result.category,
        reason: result.reason,
        ...(result.status !== undefined ? { status: result.status } : {}),
        waitMs,
      });
      await sleep(waitMs, init.signal);
    }
  }

  /** A `retryOn` list that was configured wins; the default gateway statuses suit reads only. */
  private statusesToRetry(idempotent: boolean): readonly number[] {
    if (idempotent || this.retryOnConfigured) return this.options.retryOn;
    return this.options.retryOn.filter((status) => !GATEWAY_STATUSES.has(status));
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.options.requestsPerSecond;
    this.tokens = Math.min(this.options.burst, this.tokens + newTokens);
    this.lastRefill = now;
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
