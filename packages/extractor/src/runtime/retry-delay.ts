/**
 * Backoff shared by transport retries and custom-token requests.
 */

import type { RetryConfig } from '../framework/core/index.js';

export interface RetryBackoffPolicy {
  maxRetries: number;
  backoff: 'exponential' | 'fixed';
  retryAfterHeader: boolean;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoffPolicy = {
  maxRetries: 3,
  backoff: 'exponential',
  retryAfterHeader: true,
};

const MAX_RETRY_AFTER_MS = 300_000;
const MAX_EXPONENTIAL_DELAY_MS = 30_000;

export function resolveRetryBackoffPolicy(config: RetryConfig | undefined): RetryBackoffPolicy {
  return {
    maxRetries: config?.max_retries ?? DEFAULT_RETRY_BACKOFF.maxRetries,
    backoff: config?.backoff ?? DEFAULT_RETRY_BACKOFF.backoff,
    retryAfterHeader: config?.retry_after_header ?? DEFAULT_RETRY_BACKOFF.retryAfterHeader,
  };
}

/** Delay before retry `attempt + 1`, honoring a capped Retry-After when enabled. */
export function retryDelayMs(
  policy: Pick<RetryBackoffPolicy, 'backoff' | 'retryAfterHeader'>,
  response: Response | undefined,
  attempt: number
): number {
  if (policy.retryAfterHeader && response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds)) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
      }
    }
  }

  if (policy.backoff === 'exponential') {
    return Math.min(1000 * 2 ** attempt, MAX_EXPONENTIAL_DELAY_MS);
  }
  return 1000;
}
