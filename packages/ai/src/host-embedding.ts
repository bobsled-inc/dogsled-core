import { randomUUID } from 'node:crypto';

import { boundResponse } from './bounded-response.js';
import {
  HostEmbeddingError,
  invalidResponse,
  parseHostEmbeddingResponse,
  readLimits,
  type HostEmbeddingErrorCode,
  type HostEmbeddingLimits,
  type HostEmbeddingModel,
  type HostEmbeddingResponse,
} from './host-embedding-response.js';

/**
 * Client for an embedding model that the host application supplies. The contract is
 * docs/reference/host-embeddings.md.
 */

const MAX_ATTEMPTS = 4;
const MAX_REQUESTS_IN_FLIGHT = 4;
const ATTEMPT_TIMEOUT_MS = 60_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** The first response holds no vectors. */
const MAX_DESCRIPTION_BYTES = 64 * 1024;

const TOKEN_RE = /^[\x21-\x7e]+$/;
const NETWORK_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface HostEmbeddingOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** Waits between attempts. */
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Starts one attempt's timeout and returns a function that stops it. */
  startTimeout?: (milliseconds: number, onTimeout: () => void) => () => void;
  /** Backoff jitter, from 0 up to 1. */
  random?: () => number;
}

export interface HostEmbeddingResult {
  /** In input order. `null` where the host refused the input. */
  vectors: Array<number[] | null>;
  /** Refused inputs, counted by the host's error code. */
  rejections: ReadonlyMap<string, number>;
  tokensUsed: number;
  /** Batches sent. A retried batch counts once. */
  requests: number;
}

export interface HostEmbeddingConnection {
  readonly model: Readonly<HostEmbeddingModel>;
  readonly limits: Readonly<HostEmbeddingLimits>;
  /** The most texts that `embed` has on the way at once. */
  readonly textsInFlight: number;
  embed(texts: readonly string[]): Promise<HostEmbeddingResult>;
}

/** A failed attempt that may be tried again. */
interface FailedAttempt {
  code: HostEmbeddingErrorCode;
  problem: string;
  retryAfterMs: number;
}

type Send = (texts: readonly string[], signal: AbortSignal) => Promise<HostEmbeddingResponse>;

/**
 * Check the endpoint and token, ask the host for its model and limits without sending any
 * text, and return a connection that holds the host to that model.
 */
export async function connectHostEmbedding(
  options: HostEmbeddingOptions
): Promise<HostEmbeddingConnection> {
  const send = createSender(options);
  const described = await send([], new AbortController().signal);
  const model = Object.freeze(described.model);
  const limits = Object.freeze(readLimits(described.limits));

  return {
    model,
    limits,
    textsInFlight: MAX_REQUESTS_IN_FLIGHT * limits.maxInputs,
    async embed(texts) {
      const batches: string[][] = [];
      for (let index = 0; index < texts.length; index += limits.maxInputs) {
        batches.push(texts.slice(index, index + limits.maxInputs));
      }
      const responses = await sendBatches(batches, async (batch, signal) => {
        const response = await send(batch, signal);
        assertSameModel(response.model, model);
        return response;
      });
      return collectResults(batches, responses);
    },
  };
}

function assertSameModel(received: HostEmbeddingModel, expected: HostEmbeddingModel): void {
  if (
    received.provider !== expected.provider ||
    received.id !== expected.id ||
    received.dimensions !== expected.dimensions
  ) {
    throw new HostEmbeddingError(
      'model_changed',
      'The host embedding endpoint changed its model during the run.'
    );
  }
}

/** Send the batches with a few in flight. The first failure cancels the others. */
async function sendBatches(
  batches: ReadonlyArray<readonly string[]>,
  send: Send
): Promise<HostEmbeddingResponse[]> {
  const controller = new AbortController();
  const responses = new Array<HostEmbeddingResponse>(batches.length);
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (next < batches.length && failure === undefined) {
      const index = next;
      next += 1;
      try {
        responses[index] = await send(batches[index]!, controller.signal);
      } catch (error) {
        failure ??= { error };
        controller.abort();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_REQUESTS_IN_FLIGHT, batches.length) }, worker)
  );
  if (failure !== undefined) throw failure.error;
  return responses;
}

function collectResults(
  batches: ReadonlyArray<readonly string[]>,
  responses: readonly HostEmbeddingResponse[]
): HostEmbeddingResult {
  const vectors: Array<number[] | null> = [];
  const rejections = new Map<string, number>();
  let tokensUsed = 0;
  for (const [batchIndex, batch] of batches.entries()) {
    const response = responses[batchIndex]!;
    tokensUsed += response.tokensUsed;
    for (const inputIndex of batch.keys()) {
      const result = response.results.get(String(inputIndex))!;
      if (typeof result === 'string') {
        vectors.push(null);
        rejections.set(result, (rejections.get(result) ?? 0) + 1);
      } else {
        vectors.push(result);
      }
    }
  }
  return { vectors, rejections, tokensUsed, requests: batches.length };
}

function createSender(options: HostEmbeddingOptions): Send {
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    throw new HostEmbeddingError(
      'invalid_config',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so the host embedding ' +
        'endpoint is not used. Trust its certificate with NODE_EXTRA_CA_CERTS instead.'
    );
  }
  const url = checkUrl(options.url);
  if (!TOKEN_RE.test(options.token)) {
    throw new HostEmbeddingError(
      'invalid_config',
      'The host embedding token must be printable ASCII without spaces.'
    );
  }
  const authorization = `Bearer ${options.token}`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const delay = options.delay ?? waitFor;
  const startTimeout = options.startTimeout ?? startTimer;
  const random = options.random ?? Math.random;

  async function attempt(
    init: RequestInit,
    inputCount: number,
    signal: AbortSignal
  ): Promise<HostEmbeddingResponse | FailedAttempt> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    let timedOut = false;
    const stopTimeout = startTimeout(ATTEMPT_TIMEOUT_MS, () => {
      timedOut = true;
      abort();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await untilAborted(
        fetchImplementation(url, { ...init, signal: controller.signal }),
        controller.signal,
        discard
      );
      const refused = refusedStatus(response);
      if (refused) {
        discard(response);
        if (refused instanceof HostEmbeddingError) throw refused;
        return refused;
      }
      const maxBytes = inputCount === 0 ? MAX_DESCRIPTION_BYTES : MAX_RESPONSE_BYTES;
      const body = await readBody(response, maxBytes, controller.signal);
      return parseHostEmbeddingResponse(body, inputCount);
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (error instanceof HostEmbeddingError) throw error;
      if (timedOut) return { code: 'timeout', problem: 'timed out', retryAfterMs: 0 };
      return failedConnection(error);
    } finally {
      stopTimeout();
      signal.removeEventListener('abort', abort);
    }
  }

  return async (texts, signal) => {
    const init: RequestInit = {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        inputs: texts.map((text, index) => ({ id: String(index), text })),
        purpose: 'document',
      }),
    };
    for (let attempts = 1; ; attempts += 1) {
      const outcome = await attempt(init, texts.length, signal);
      if ('results' in outcome) return outcome;
      if (attempts === MAX_ATTEMPTS) {
        throw new HostEmbeddingError(
          outcome.code,
          `The host embedding request ${outcome.problem} after ${MAX_ATTEMPTS} attempts.`
        );
      }
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
      await delay(Math.max(outcome.retryAfterMs, backoff * (0.5 + random() / 2)), signal);
      if (signal.aborted) throw cancelled();
    }
  };
}

function checkUrl(raw: string): string {
  const refuse = (problem: string): never => {
    throw new HostEmbeddingError('invalid_config', `The host embedding URL ${problem}.`);
  };
  // The URL parser drops tabs and newlines, so look for them before it does.
  if (/[\s\p{Cc}]/u.test(raw)) refuse('must not contain spaces or control characters');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('is not a valid URL');
  }
  if (url.protocol !== 'https:') refuse('must use https');
  if (url.username !== '' || url.password !== '') refuse('must not contain credentials');
  if (raw.includes('#')) refuse('must not contain a fragment');
  return url.href;
}

/** What to do with a response that carries no result, or `undefined` to read the body. */
function refusedStatus(response: Response): HostEmbeddingError | FailedAttempt | undefined {
  const { status } = response;
  if (response.redirected || response.type === 'opaqueredirect' || isRedirect(status)) {
    return redirected();
  }
  if (response.ok) return undefined;
  if (status === 401 || status === 403) {
    return new HostEmbeddingError(
      'unauthorized',
      `The host embedding endpoint refused the token (HTTP status ${status}).`
    );
  }
  const problem = `failed with HTTP status ${status}`;
  if (status === 408 || status === 429 || status >= 500) {
    const retryAfterMs = readRetryAfter(response.headers.get('retry-after'));
    return { code: 'http_status', problem, retryAfterMs };
  }
  return new HostEmbeddingError('http_status', `The host embedding request ${problem}.`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function readRetryAfter(header: string | null): number {
  return header !== null && /^\d{1,9}$/.test(header)
    ? Math.min(Number(header) * 1000, MAX_RETRY_AFTER_MS)
    : 0;
}

/** Classify what fetch threw by its cause. Only a short error code is taken from it. */
function failedConnection(error: unknown): FailedAttempt {
  const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : null;
  if (cause?.message === 'unexpected redirect') throw redirected();
  const code = cause?.code;
  const known = typeof code === 'string' && NETWORK_CODE_RE.test(code) ? code : undefined;
  if (known?.startsWith('Z_')) throw invalidResponse('the body cannot be decompressed');
  const problem = `failed with a network error${known === undefined ? '' : ` (${known})`}`;
  return { code: 'network', problem, retryAfterMs: 0 };
}

function redirected(): HostEmbeddingError {
  return new HostEmbeddingError(
    'redirect',
    'The host embedding endpoint answered with a redirect, which is not followed.'
  );
}

function cancelled(): HostEmbeddingError {
  return new HostEmbeddingError('cancelled', 'The host embedding request was cancelled.');
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const tooLarge = (): Error => invalidResponse(`the body is over ${maxBytes} bytes`);
  const bounded = await untilAborted(boundResponse(response, maxBytes, tooLarge), signal, discard);
  if (!bounded.body) throw invalidResponse('the body is empty');
  const reader = bounded.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) return Buffer.concat(chunks);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(ignore);
    throw error;
  }
}

/**
 * Wait for `promise`, or fail as soon as `signal` aborts, because not every fetch or stream
 * stops on its own. `abandon` receives a value that arrives after that.
 */
async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abandon: (value: T) => void = ignore
): Promise<T> {
  let onAbort = ignore;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      promise.then(abandon, ignore);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function discard(response: Response): void {
  void response.body?.cancel().catch(ignore);
}

function ignore(): void {}

function startTimer(milliseconds: number, onTimeout: () => void): () => void {
  const timer = setTimeout(onTimeout, milliseconds);
  return () => clearTimeout(timer);
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
