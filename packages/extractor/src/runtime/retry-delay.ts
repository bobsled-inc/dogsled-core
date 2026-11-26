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
const BASE_DELAY_MS = 1000;
const MAX_EXPONENTIAL_DELAY_MS = 30_000;

export function resolveRetryBackoffPolicy(config: RetryConfig | undefined): RetryBackoffPolicy {
  return {
    maxRetries: config?.max_retries ?? DEFAULT_RETRY_BACKOFF.maxRetries,
    backoff: config?.backoff ?? DEFAULT_RETRY_BACKOFF.backoff,
    retryAfterHeader: config?.retry_after_header ?? DEFAULT_RETRY_BACKOFF.retryAfterHeader,
  };
}

/** The wait a provider asked for with Retry-After, capped, when the policy honors it. */
function requestedDelayMs(
  policy: Pick<RetryBackoffPolicy, 'retryAfterHeader'>,
  response: Response | undefined
): number | undefined {
  if (!policy.retryAfterHeader || !response) return undefined;
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds)) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/** Delay before retry `attempt + 1`, honoring a capped Retry-After when enabled. */
export function retryDelayMs(
  policy: Pick<RetryBackoffPolicy, 'backoff' | 'retryAfterHeader'>,
  response: Response | undefined,
  attempt: number
): number {
  const requested = requestedDelayMs(policy, response);
  if (requested !== undefined) return requested;

  if (policy.backoff === 'exponential') {
    return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_EXPONENTIAL_DELAY_MS);
  }
  return BASE_DELAY_MS;
}

/**
 * Delay before retry `attempt + 1` of a page request. A provider's capped
 * Retry-After is exact. Exponential backoff waits a random time up to 1 s,
 * 2 s, 4 s and so on, never above 30 s, so retries from many requests do not
 * arrive together. `fixed` backoff stays 1 s.
 */
export function jitteredRetryDelayMs(
  policy: Pick<RetryBackoffPolicy, 'backoff' | 'retryAfterHeader'>,
  response: Response | undefined,
  attempt: number,
  random: () => number = Math.random
): number {
  const requested = requestedDelayMs(policy, response);
  if (requested !== undefined) return requested;

  if (policy.backoff === 'exponential') {
    const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_EXPONENTIAL_DELAY_MS);
    return Math.floor(random() * ceiling);
  }
  return BASE_DELAY_MS;
}
