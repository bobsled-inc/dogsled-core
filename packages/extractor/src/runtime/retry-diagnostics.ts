/**
 * Run-log warning for a request that is about to be tried again, so a host that
 * shows control messages can show the retries too.
 */

import type { JsonObject } from '@bobsled-inc/protocol';

import type { RequestRetryEvent } from './rate-limiter.js';

/** The `event` of the LOG message that reports a retry. */
export const REQUEST_RETRY_LOG_EVENT = 'http.request_retry';

interface RetryWarningLogger {
  log(level: 'warn', message: string, event: string, attributes: JsonObject): Promise<void>;
}

/**
 * Describe a retry without the URL, a host name, an address, the headers or the
 * provider's response body: `reason` is a fixed category and `detail` one of a
 * few fixed phrases.
 */
export function buildRequestRetryWarning(
  resourceName: string,
  retry: RequestRetryEvent
): { message: string; attributes: JsonObject } {
  const seconds = (retry.waitMs / 1000).toFixed(1);
  return {
    message:
      `Request for ${resourceName} failed on attempt ${retry.attempt} of ${retry.maxAttempts} ` +
      `(${retry.reason}). Retrying in ${seconds}s.`,
    attributes: {
      resource: resourceName,
      attempt: retry.attempt,
      max_attempts: retry.maxAttempts,
      reason: retry.category,
      detail: retry.reason,
      wait_ms: retry.waitMs,
      ...(retry.status !== undefined ? { status: retry.status } : {}),
    },
  };
}

export async function logRequestRetry(
  logger: RetryWarningLogger,
  resourceName: string,
  retry: RequestRetryEvent
): Promise<void> {
  const warning = buildRequestRetryWarning(resourceName, retry);
  await logger.log('warn', warning.message, REQUEST_RETRY_LOG_EVENT, warning.attributes);
}
