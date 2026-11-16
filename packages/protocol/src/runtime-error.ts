import type { JsonObject } from './definitions.js';

export const DOGSLED_RUNTIME_ERROR_KINDS = [
  'auth',
  'validation',
  'provider',
  'timeout',
  'cancellation',
  'internal',
] as const;

export type BobsledRuntimeErrorKind = (typeof DOGSLED_RUNTIME_ERROR_KINDS)[number];

export const DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES: Record<BobsledRuntimeErrorKind, string> = {
  auth: 'Dogsled could not authenticate with the provider.',
  validation: 'Dogsled could not validate the request.',
  provider: 'The provider could not complete the operation.',
  timeout: 'The operation timed out.',
  cancellation: 'The operation was cancelled.',
  internal: 'Dogsled could not complete the operation.',
};

export interface BobsledRuntimeErrorOptions {
  kind: BobsledRuntimeErrorKind;
  code: string;
  operation: string;
  retryable: boolean;
  providerStatus?: number;
  cause?: Error;
}

/** JSON-safe form of a native Error cause for process and library boundaries. */
export type SerializedErrorCause = JsonObject & {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  cause?: SerializedErrorCause;
};

const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * Preserve useful native Error fields without applying product-level redaction.
 * The caller that shows or stores this value owns its exposure policy.
 */
export function serializeErrorCause(cause: unknown): SerializedErrorCause | undefined {
  return serializeErrorCauseAtDepth(cause, new Set<object>(), 0);
}

function serializeErrorCauseAtDepth(
  cause: unknown,
  seen: Set<object>,
  depth: number
): SerializedErrorCause | undefined {
  if (cause == null || depth >= MAX_ERROR_CAUSE_DEPTH) return undefined;

  if (typeof cause !== 'object') {
    return { name: typeof cause, message: String(cause) };
  }
  if (seen.has(cause)) return undefined;
  seen.add(cause);

  const record = cause as Record<string, unknown>;
  const name =
    cause instanceof Error
      ? cause.name
      : typeof record['name'] === 'string'
        ? record['name']
        : 'Error';
  const message =
    cause instanceof Error
      ? cause.message
      : typeof record['message'] === 'string'
        ? record['message']
        : String(cause);
  const code = record['code'];
  const status = record['status'];
  const nestedCause = serializeErrorCauseAtDepth(record['cause'], seen, depth + 1);

  return {
    name,
    message,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(typeof status === 'number' && Number.isFinite(status) ? { status } : {}),
    ...(nestedCause ? { cause: nestedCause } : {}),
  };
}

/**
 * Safe, stable runtime failure contract for Dogsled library boundaries.
 *
 * The original Error remains available only as the native `cause`; consumers
 * use the explicit fields and never infer behavior from provider text.
 */
export class BobsledRuntimeError extends Error {
  readonly kind: BobsledRuntimeErrorKind;
  readonly code: string;
  readonly operation: string;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly publicMessage: string;

  constructor(options: BobsledRuntimeErrorOptions) {
    const publicMessage = DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES[options.kind];
    super(publicMessage, { cause: options.cause });
    this.name = 'BobsledRuntimeError';
    this.kind = options.kind;
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    this.providerStatus = options.providerStatus;
    this.publicMessage = publicMessage;
  }
}
