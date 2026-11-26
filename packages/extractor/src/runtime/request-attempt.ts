/**
 * One attempt of a request: its own timeout, the response body read inside it,
 * and the decision whether a failure is worth another attempt.
 */

import {
  attachProviderResponseBody,
  safeFetch,
  sanitizeUrlForError,
} from '../framework/core/index.js';
import {
  describeNetworkFailure,
  isTransientNetworkFailure,
  statusReason,
  timeoutReason,
  type RequestFailureCategory,
} from './request-failure.js';

export class RateLimitTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RateLimitTimeoutError';
  }
}

/**
 * The last of several attempts failed on the network. `cause` holds the failure
 * itself, so classification and diagnostics still see what went wrong.
 */
export class RequestRetryError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number, cause: Error) {
    super(message, { cause });
    this.name = 'RequestRetryError';
    this.attempts = attempts;
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

/** One failed attempt that will be followed by another. */
export interface RequestRetryEvent {
  /** The attempt that just failed, counting from 1. */
  attempt: number;
  /** The most attempts the request makes. */
  maxAttempts: number;
  category: RequestFailureCategory;
  /** Why the attempt failed, in words that are safe to log. */
  reason: string;
  /** The HTTP status, when the provider answered. */
  status?: number;
  /** Milliseconds before the next attempt starts. */
  waitMs: number;
}

export interface FetchRetryOptions {
  /**
   * Reads the body of a response that is not retried. It runs inside the
   * attempt, under the attempt's timeout, so a body that stalls or drops is
   * retried with the request instead of failing the run later. Only an error
   * from a dropped connection is retried; a size limit or a parse error is not.
   */
  readBody?: (response: Response) => Promise<void>;
  /** Called before each wait between attempts. An error it throws is ignored. */
  onRetry?: (event: RequestRetryEvent) => void | Promise<void>;
  /**
   * Whether the provider may receive this request twice. Defaults to true. A
   * request that changes data sets false, and then a timeout, a failed body
   * read and the gateway statuses 502 and 504 are not retried, because the
   * provider may already have acted. HTTP 429, 503 and a connection that failed
   * before any response are still retried. A `retryOn` list the caller set
   * explicitly is always honored.
   */
  idempotent?: boolean;
}

export interface AttemptPlan {
  timeoutMs: number;
  retryOn: readonly number[];
  idempotent: boolean;
  lastAttempt: boolean;
  onFinalRetryableResponse?: FinalRetryableResponseHandler;
  readBody?: FetchRetryOptions['readBody'];
}

export interface FailedAttempt {
  ok: false;
  category: RequestFailureCategory;
  reason: string;
  status?: number;
  /** The provider's response, kept for its Retry-After header. */
  response?: Response;
  retry: boolean;
  /** The error to throw when no attempt is left, given how many ran. */
  toError(attempts: number): Error;
}

export type AttemptResult = { ok: true; response: Response } | FailedAttempt;

/**
 * Make one attempt. Returns the response to hand back, or the failure to retry
 * or report. Throws at once for a failure no further attempt can fix.
 */
export async function runAttempt(
  url: string,
  init: RequestInit,
  plan: AttemptPlan
): Promise<AttemptResult> {
  const timeout = startAttemptTimeout(plan.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  let phase: 'request' | 'body' = 'request';
  let keepTimer = false;
  try {
    const response = await safeFetch(url, { ...init, signal });

    if (plan.retryOn.includes(response.status)) {
      return await failedStatus(response, plan);
    }

    if (plan.readBody) {
      phase = 'body';
      await plan.readBody(response);
    }
    // A body that was read has nothing left for the timer to bound. One left
    // unread keeps the timer, so a later read still stops at this attempt's timeout.
    keepTimer = !response.bodyUsed;
    return { ok: true, response };
  } catch (thrown) {
    return failedAttempt(thrown, init.signal, timeout, phase, url, plan);
  } finally {
    if (!keepTimer) timeout.stop();
  }
}

async function failedStatus(response: Response, plan: AttemptPlan): Promise<FailedAttempt> {
  let finalResponse: FinalRetryableResponseDetail | undefined;
  if (plan.lastAttempt && plan.onFinalRetryableResponse) {
    // Diagnostics are best effort. A response-body read must never mask
    // the exhausted provider status or alter retry behavior.
    try {
      finalResponse = await plan.onFinalRetryableResponse(response);
    } catch {
      finalResponse = undefined;
    }
  }
  await response.body?.cancel().catch(() => undefined);

  const { status, statusText } = response;
  const detail = finalResponse?.detail;
  return {
    ok: false,
    category: 'http_status',
    reason: statusReason(status, statusText),
    status,
    response,
    retry: true,
    toError: (attempts) =>
      attachProviderResponseBody(
        Object.assign(
          new Error(
            `HTTP ${status}: ${statusText}${detail ? ` - ${detail}` : ''}${attemptsNote(attempts)}`
          ),
          { status }
        ),
        finalResponse?.body
      ),
  };
}

/** Classify an error thrown during an attempt. Throws when no attempt can fix it. */
function failedAttempt(
  thrown: unknown,
  callerSignal: AbortSignal | null | undefined,
  timeout: AttemptTimeout,
  phase: 'request' | 'body',
  url: string,
  plan: AttemptPlan
): FailedAttempt {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));

  // An upstream cancellation is intentional and must not be retried.
  if (callerSignal?.aborted) {
    if (!timeout.expired) throw error;
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }

  if (timeout.expired) {
    return {
      ok: false,
      category: 'timeout',
      reason: timeoutReason(plan.timeoutMs),
      // The provider may have acted before the timeout, so only a request that is safe to repeat goes again.
      retry: plan.idempotent,
      toError: (attempts) =>
        new RateLimitTimeoutError(
          attempts > 1
            ? exhaustedMessage(url, attempts, timeoutReason(plan.timeoutMs))
            : `Request ${timeoutReason(plan.timeoutMs)}: ${sanitizeUrlForError(url)}`,
          { cause: timeout.signal.reason }
        ),
    };
  }

  if (error.name === 'AbortError' || !isTransientNetworkFailure(error)) throw error;

  const duringBody = phase === 'body';
  const reason = duringBody
    ? `response body read failed: ${describeNetworkFailure(error)}`
    : describeNetworkFailure(error);
  return {
    ok: false,
    category: duringBody ? 'response_body' : 'connection',
    reason,
    // A failed body read means the provider already handled the request.
    retry: plan.idempotent || !duringBody,
    toError: (attempts) =>
      attempts > 1
        ? new RequestRetryError(exhaustedMessage(url, attempts, reason), attempts, error)
        : error,
  };
}

function exhaustedMessage(url: string, attempts: number, reason: string): string {
  return `Request failed after ${attempts} attempts; last failure: ${reason}: ${sanitizeUrlForError(url)}`;
}

function attemptsNote(attempts: number): string {
  return attempts > 1 ? ` (after ${attempts} attempts)` : '';
}

interface AttemptTimeout {
  signal: AbortSignal;
  readonly expired: boolean;
  stop(): void;
}

/**
 * A timer of our own rather than `AbortSignal.timeout`, so a test with fake
 * timers can move it, and so a finished attempt can stop it.
 */
function startAttemptTimeout(timeoutMs: number): AttemptTimeout {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(
      new DOMException(`The request timed out after ${timeoutMs}ms`, 'TimeoutError')
    );
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    stop: () => clearTimeout(timer),
  };
}
