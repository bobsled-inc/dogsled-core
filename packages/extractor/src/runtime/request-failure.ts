/**
 * Tells a failure that another attempt can fix from one that it cannot, and
 * describes the failure in words that are safe to log.
 */

export type RequestFailureCategory = 'timeout' | 'connection' | 'response_body' | 'http_status';

/**
 * The codes of a connection that failed in a way another attempt can fix: it was
 * reset, broken, closed by the other side or timed out, or a lookup failed for
 * now. Undici hides the code under `TypeError: fetch failed` (before the
 * response) or `TypeError: terminated` (while the body is read), so it sits on
 * a `cause`. A TLS error, an HTTP parser error and the refusal of a private
 * address carry none of these codes and are never retried.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 5;
const MAX_REASON_CHARS = 200;

/** The error and its causes, outermost first. */
function causeChain(error: Error): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function transientCode(chain: readonly Error[]): string | undefined {
  for (const error of chain) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return code;
  }
  return undefined;
}

/**
 * True for a connection that was reset, broken, closed by the other side or
 * timed out. Caller cancellations, size limits, parse errors, TLS errors and
 * refused addresses are not: another attempt would fail the same way.
 */
export function isTransientNetworkFailure(error: Error): boolean {
  return transientCode(causeChain(error)) !== undefined;
}

/**
 * The reason of the innermost cause, such as `other side closed (UND_ERR_SOCKET)`
 * or `read ECONNRESET`, so the error names what the network reported.
 */
export function describeNetworkFailure(error: Error): string {
  const chain = causeChain(error);
  const code = transientCode(chain);
  const message = (chain[chain.length - 1]?.message ?? '').replace(/\s+/g, ' ').trim();
  const reason = message === '' ? (code ?? 'network error') : message;
  const described = code === undefined || reason.includes(code) ? reason : `${reason} (${code})`;
  return described.length > MAX_REASON_CHARS
    ? `${described.slice(0, MAX_REASON_CHARS)}…`
    : described;
}

export function timeoutReason(timeoutMs: number): string {
  return `timed out after ${timeoutMs}ms`;
}

export function statusReason(status: number, statusText: string): string {
  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}
