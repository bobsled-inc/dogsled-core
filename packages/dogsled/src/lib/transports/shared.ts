import { readProviderResponseBody, sanitizeUrlForError } from '@bobsled-inc/extractor/core';
import { DOGSLED_RUNTIME_ERROR_KINDS, type DogsledRuntimeErrorKind } from '@bobsled-inc/protocol';

import { createPipelineRedactor } from '../../pipeline/redaction.js';
import type { ActionErrorCode, ActionResult, ExecuteOptions } from '../action-executor.js';

export interface TransportErrorClassification {
  code: ActionErrorCode;
  message: string;
  retryable: boolean;
  /** HTTP status of the provider response that caused the failure. */
  providerStatus?: number;
  /** Redacted body of that provider response, never returned as is. */
  providerBody?: string;
}

type ActionResultError = NonNullable<ActionResult['error']>;

export interface TransportStatusClassification {
  code: ActionErrorCode;
  retryable: boolean;
}

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;
const TIMEOUT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);
const DOGSLED_RUNTIME_ERROR_KIND_SET: ReadonlySet<string> = new Set(DOGSLED_RUNTIME_ERROR_KINDS);
const MAX_PROVIDER_MESSAGE_CHARS = 300;

interface RuntimeFailure {
  kind: DogsledRuntimeErrorKind;
  providerStatus?: number;
}

/** Return an error message that does not include upstream URLs, bodies, or credentials. */
export function safeTransportErrorMessage(code: ActionErrorCode): string {
  switch (code) {
    case 'auth_error':
      return 'The external service rejected authentication.';
    case 'permission_denied':
      return 'The external service refused the Action.';
    case 'not_found':
      return 'The external target was not found.';
    case 'conflict':
      return 'The external service reported a conflict.';
    case 'rate_limited':
      return 'The external service rate-limited the Action.';
    case 'timeout':
      return 'The Action timed out.';
    case 'cancelled':
      return 'The Action was cancelled.';
    case 'server_error':
      return 'The external service failed.';
    case 'network_error':
      return 'The external service could not be reached.';
    case 'validation_error':
      return 'The Action request was invalid.';
    case 'unknown':
      return 'The Action failed.';
  }
}

function collectErrorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [];
  let current = error;
  while (
    current &&
    typeof current === 'object' &&
    'cause' in current &&
    (current as { cause?: unknown }).cause !== undefined
  ) {
    current = (current as { cause?: unknown }).cause;
    causes.push(current);
  }
  return causes;
}

function extractErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }

  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function readRuntimeFailure(error: unknown): RuntimeFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { name, kind, providerStatus } = error as {
    name?: unknown;
    kind?: unknown;
    providerStatus?: unknown;
  };
  if (name !== 'DogsledRuntimeError') return undefined;
  if (typeof kind !== 'string' || !DOGSLED_RUNTIME_ERROR_KIND_SET.has(kind)) return undefined;
  return {
    kind: kind as DogsledRuntimeErrorKind,
    ...(isHttpStatus(providerStatus) ? { providerStatus } : {}),
  };
}

function providerBodyField(error: unknown): { providerBody?: string } {
  const providerBody = readProviderResponseBody(error);
  return providerBody === undefined ? {} : { providerBody };
}

function classifyRuntimeFailure(
  errorChain: unknown[]
): Omit<TransportErrorClassification, 'message'> | undefined {
  for (const candidate of errorChain) {
    const failure = readRuntimeFailure(candidate);
    if (!failure) continue;
    if (failure.providerStatus !== undefined) {
      return {
        ...mapStatusToError(failure.providerStatus),
        providerStatus: failure.providerStatus,
        ...providerBodyField(candidate),
      };
    }
    switch (failure.kind) {
      case 'auth':
        return { code: 'auth_error', retryable: false };
      case 'timeout':
        return { code: 'timeout', retryable: true };
      case 'cancellation':
        return errorChain.some((cause) => isTimeoutError(cause))
          ? { code: 'timeout', retryable: true }
          : { code: 'cancelled', retryable: false };
      case 'validation':
      case 'provider':
      case 'internal':
        return undefined;
    }
  }
  return undefined;
}

/** Maps transport-layer HTTP status codes to action error semantics. */
export function mapStatusToError(status: number): TransportStatusClassification {
  switch (status) {
    case 401:
      return { code: 'auth_error', retryable: false };
    case 403:
      return { code: 'permission_denied', retryable: false };
    case 404:
      return { code: 'not_found', retryable: false };
    case 409:
      return { code: 'conflict', retryable: false };
    case 400:
    case 422:
      return { code: 'validation_error', retryable: false };
    case 408:
      return { code: 'timeout', retryable: true };
    case 429:
      return { code: 'rate_limited', retryable: true };
    default:
      if (status >= 500) {
        return { code: 'server_error', retryable: true };
      }
      return { code: 'unknown', retryable: false };
  }
}

/** Normalizes transport exceptions into action error semantics. */
export function classifyTransportError(
  error: unknown,
  statusPattern?: RegExp
): TransportErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const errorChain = [error, ...collectErrorCauses(error)];
  const errorCodes = errorChain
    .map((candidate) => extractErrorCode(candidate))
    .filter((candidate): candidate is string => candidate !== undefined);

  const runtimeClassification = classifyRuntimeFailure(errorChain);
  if (runtimeClassification) {
    return { ...runtimeClassification, message };
  }

  if (statusPattern) {
    const statusMatch = statusPattern.exec(message);
    if (statusMatch) {
      const status = Number.parseInt(statusMatch[1]!, 10);
      return {
        ...mapStatusToError(status),
        message,
        ...(isHttpStatus(status) ? { providerStatus: status, ...providerBodyField(error) } : {}),
      };
    }
  }

  if (errorChain.some((candidate) => isAbortError(candidate))) {
    return { code: 'timeout', message, retryable: true };
  }

  if (errorCodes.some((code) => TIMEOUT_ERROR_CODES.has(code))) {
    return { code: 'timeout', message, retryable: true };
  }

  if (errorCodes.some((code) => NETWORK_ERROR_CODES.has(code))) {
    return { code: 'network_error', message, retryable: true };
  }

  return { code: 'unknown', message, retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretRedactionVariants(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
    JSON.stringify(value).slice(1, -1),
  ];
}

/**
 * Build a redactor for provider text from the credential values an Action could
 * send, including their URL- and JSON-encoded forms.
 */
export function createActionSecretRedactor(
  values: Iterable<string | undefined>
): (value: string) => string {
  const variants: string[] = [];
  for (const value of values) {
    if (value) variants.push(...secretRedactionVariants(value));
  }
  return createPipelineRedactor(variants);
}

function actionSecretValues(
  options: ExecuteOptions | undefined,
  authEnvVars: readonly string[] | undefined
): string[] {
  const source = options?.secrets ?? process.env;
  const names = new Set([
    ...(authEnvVars ?? []),
    ...(options?.secrets === undefined ? [] : (options.declaredSecretNames ?? [])),
  ]);
  const values: string[] = [];
  for (const name of names) {
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    if (value) values.push(value);
  }
  return values;
}

function boundProviderMessage(
  value: string,
  redact: (value: string) => string
): string | undefined {
  const condensed = redact(value)
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .replace(/https?:\/\/[^\s"'<>)\]]+/gi, (url) => sanitizeUrlForError(url));
  if (!condensed) return undefined;
  const characters = Array.from(condensed);
  return characters.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${characters.slice(0, MAX_PROVIDER_MESSAGE_CHARS - 1).join('')}…`
    : condensed;
}

/**
 * Extract the error prose from a JSON provider error body. Only well-known
 * message fields are read; the raw body is never returned.
 */
export function providerMessageFromBody(
  body: string,
  redact: (value: string) => string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const { error, errors } = parsed;
  const candidates = [
    isRecord(error) ? error['message'] : undefined,
    parsed['message'],
    error,
    parsed['detail'],
    Array.isArray(errors) && isRecord(errors[0]) ? errors[0]['message'] : undefined,
    parsed['error_description'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const message = boundProviderMessage(candidate, redact);
    if (message) return message;
  }
  return undefined;
}

function isClientErrorStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status <= 499;
}

/**
 * Build the Action result error. Adds the provider status and, for a 4xx, a bounded
 * provider message with the Action's declared credential values redacted.
 */
export function toActionResultError(
  classification: TransportErrorClassification,
  options: ExecuteOptions | undefined,
  authEnvVars: readonly string[] | undefined,
  requestSecretValues: readonly string[] = []
): ActionResultError {
  const { providerStatus, providerBody, ...normalized } = classification;
  const providerMessage =
    isClientErrorStatus(providerStatus) && providerBody !== undefined
      ? providerMessageFromBody(
          providerBody,
          createActionSecretRedactor([
            ...actionSecretValues(options, authEnvVars),
            ...requestSecretValues,
          ])
        )
      : undefined;
  return {
    ...normalized,
    ...(options?.safeErrors ? { message: safeTransportErrorMessage(normalized.code) } : {}),
    ...(providerStatus !== undefined ? { provider_status: providerStatus } : {}),
    ...(providerMessage !== undefined ? { provider_message: providerMessage } : {}),
  };
}
