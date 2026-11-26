/**
 * Tells a failure that another attempt can fix from one that it cannot, and
 * describes the failure in words that are safe to log.
 */

export type RequestFailureCategory = 'timeout' | 'connection' | 'response_body' | 'http_status';

/**
 * Node and undici codes for a connection that failed or dropped, each with a
 * plain label. Undici wraps the code in `TypeError: fetch failed` (before the
 * response) or `TypeError: terminated` (while reading the body), so the code
 * sits on the `cause`.
 */
const CONNECTION_FAILURE_LABELS: Readonly<Record<string, string>> = {
  ECONNRESET: 'connection reset',
  UND_ERR_SOCKET: 'connection closed by the server',
  EPIPE: 'connection closed',
  ECONNABORTED: 'connection aborted',
  ERR_STREAM_PREMATURE_CLOSE: 'connection closed early',
  ECONNREFUSED: 'connection refused',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'no response headers in time',
  UND_ERR_BODY_TIMEOUT: 'response body stalled',
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: 'response ended early',
  ENETUNREACH: 'network unreachable',
  ENETDOWN: 'network unreachable',
  EHOSTUNREACH: 'host unreachable',
  EHOSTDOWN: 'host unreachable',
  ENOTFOUND: 'host lookup failed',
  EAI_AGAIN: 'host lookup failed',
};

/** The messages undici gives a network failure that carries no recognized code. */
const NETWORK_FAILURE_MESSAGES: ReadonlySet<string> = new Set(['fetch failed', 'terminated']);

const MAX_CAUSE_DEPTH = 5;

function connectionFailureCode(error: Error): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && Object.hasOwn(CONNECTION_FAILURE_LABELS, code)) return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * True for a dropped, reset or refused connection, and for the bare network
 * failures undici raises without a code. Caller cancellations, size limits and
 * parse errors are not network failures: another attempt would fail the same way.
 */
export function isTransientNetworkFailure(error: Error): boolean {
  if (connectionFailureCode(error) !== undefined) return true;
  return error instanceof TypeError && NETWORK_FAILURE_MESSAGES.has(error.message);
}

/** A short label such as `connection reset (ECONNRESET)`. */
export function describeNetworkFailure(error: Error): string {
  const code = connectionFailureCode(error);
  const label = code === undefined ? undefined : CONNECTION_FAILURE_LABELS[code];
  return code === undefined || label === undefined ? 'network error' : `${label} (${code})`;
}

export function timeoutReason(timeoutMs: number): string {
  return `timed out after ${timeoutMs}ms`;
}

export function statusReason(status: number, statusText: string): string {
  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}
