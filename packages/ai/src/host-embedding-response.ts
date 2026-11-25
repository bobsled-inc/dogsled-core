import { CommandError, EXIT_ERROR, EXIT_VALIDATION, isObject } from '@bobsled-inc/protocol';

/**
 * What a host embedding endpoint may answer. Errors carry fixed wording plus an HTTP status
 * or a network error code. They never carry the URL, the token, a request or response body,
 * a document's text, an input id, or a `cause` that could hold one of them.
 */

const MAX_DIMENSIONS = 16_384;
const MODEL_NAME_RE = /^[\x20-\x7e]{1,200}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const UNKNOWN_ERROR_CODE = 'unknown';

export interface HostEmbeddingModel {
  provider: string;
  id: string;
  dimensions: number;
}

export interface HostEmbeddingLimits {
  /** Inputs in one request. */
  maxInputs: number;
  /** JavaScript string length of one input's text. */
  maxInputCharacters: number;
}

export type HostEmbeddingErrorCode =
  | 'invalid_config'
  | 'unauthorized'
  | 'http_status'
  | 'redirect'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'model_changed'
  | 'cancelled';

export class HostEmbeddingError extends CommandError {
  readonly code: HostEmbeddingErrorCode;

  constructor(code: HostEmbeddingErrorCode, message: string) {
    super(message, code === 'invalid_config' ? EXIT_VALIDATION : EXIT_ERROR);
    this.name = 'HostEmbeddingError';
    this.code = code;
  }
}

export interface HostEmbeddingResponse {
  model: HostEmbeddingModel;
  limits: unknown;
  /** A vector, or the host's error code for the input. */
  results: Map<string, number[] | string>;
  tokensUsed: number;
}

export function invalidResponse(problem: string): HostEmbeddingError {
  return new HostEmbeddingError(
    'invalid_response',
    `The host embedding response is not valid: ${problem}.`
  );
}

export function parseHostEmbeddingResponse(
  body: Uint8Array,
  inputCount: number
): HostEmbeddingResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    // A JSON error message can quote the body.
    throw invalidResponse('the body is not JSON');
  }
  if (!isObject(parsed)) throw invalidResponse('the body is not an object');
  const model = readModel(parsed['model']);
  return {
    model,
    limits: parsed['limits'],
    results: readResults(parsed['results'], inputCount, model.dimensions),
    tokensUsed: readTokens(parsed['usage']),
  };
}

function readModel(value: unknown): HostEmbeddingModel {
  if (!isObject(value)) throw invalidResponse('model must be an object');
  const { provider, id, dimensions } = value;
  if (typeof provider !== 'string' || !MODEL_NAME_RE.test(provider)) {
    throw invalidResponse('model.provider must be 1 to 200 printable ASCII characters');
  }
  if (typeof id !== 'string' || !MODEL_NAME_RE.test(id)) {
    throw invalidResponse('model.id must be 1 to 200 printable ASCII characters');
  }
  return { provider, id, dimensions: readInteger('model.dimensions', dimensions, MAX_DIMENSIONS) };
}

export function readLimits(value: unknown): HostEmbeddingLimits {
  if (value !== undefined && !isObject(value)) throw invalidResponse('limits must be an object');
  return {
    maxInputs: readLimit('limits.maxInputs', value?.['maxInputs'], 32, 100),
    maxInputCharacters: readLimit(
      'limits.maxInputCharacters',
      value?.['maxInputCharacters'],
      32_000,
      200_000
    ),
  };
}

function readLimit(label: string, value: unknown, fallback: number, max: number): number {
  return value === undefined ? fallback : readInteger(label, value, max);
}

function readInteger(label: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw invalidResponse(`${label} must be an integer from 1 to ${max}`);
  }
  return value;
}

function readTokens(usage: unknown): number {
  if (usage === undefined) return 0;
  if (!isObject(usage)) throw invalidResponse('usage must be an object');
  const tokens = usage['tokens'];
  if (tokens === undefined) return 0;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw invalidResponse('usage.tokens must be a non-negative integer');
  }
  return tokens;
}

function readResults(
  value: unknown,
  inputCount: number,
  dimensions: number
): Map<string, number[] | string> {
  if (!Array.isArray(value) || value.length !== inputCount) {
    throw invalidResponse('results must have one entry for each input');
  }
  const expected = new Set(Array.from({ length: inputCount }, (_, index) => String(index)));
  const results = new Map<string, number[] | string>();
  for (const entry of value as unknown[]) {
    if (!isObject(entry)) throw invalidResponse('each result must be an object');
    const id = entry['id'];
    if (typeof id !== 'string' || !expected.has(id)) {
      throw invalidResponse('each result id must be the id of an input');
    }
    if (results.has(id)) throw invalidResponse('a result id is repeated');
    const hasEmbedding = Object.hasOwn(entry, 'embedding');
    if (hasEmbedding === Object.hasOwn(entry, 'error')) {
      throw invalidResponse('each result must have either an embedding or an error');
    }
    results.set(
      id,
      hasEmbedding ? readVector(entry['embedding'], dimensions) : readErrorCode(entry['error'])
    );
  }
  return results;
}

function readVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw invalidResponse(`each embedding must have model.dimensions (${dimensions}) numbers`);
  }
  if (!value.every((number) => Number.isFinite(number))) {
    throw invalidResponse('each embedding must have finite numbers only');
  }
  return value as number[];
}

function readErrorCode(value: unknown): string {
  return typeof value === 'string' && ERROR_CODE_RE.test(value) ? value : UNKNOWN_ERROR_CODE;
}
