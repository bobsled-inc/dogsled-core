import {
  applyStaticApiRequestAuth,
  resolveApiRequestTokenPrefix,
  type ApiRequestStaticAuth,
} from '@bobsled-inc/api-resource';

import type {
  CatalogProbeAuth,
  CatalogProbeHttpMethod,
  ProbeApiResourceExecutor,
  ProbeApiResourceExecutorRequest,
} from './probe-types.js';

const TOKEN_FETCH_TIMEOUT_MS = 30_000;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_AUTH_TOKEN_BYTES = 4 * 1024;
const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;
const BLOCKED_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ProbeAuthenticationRequest {
  url: string;
  method: CatalogProbeHttpMethod;
  headers: Record<string, string>;
  body?: unknown;
  auth: CatalogProbeAuth;
  timeout_ms: number;
  signal?: AbortSignal;
}

export class ProbeAuthFailure extends Error {
  constructor(public readonly code: 'invalid_request' | 'executor_failed') {
    super(code);
    this.name = 'ProbeAuthFailure';
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
}

function assertSafeValue(value: string): void {
  if (CONTROL_CHARACTER_RE.test(value)) {
    throw new ProbeAuthFailure('invalid_request');
  }
}

function assertBoundedToken(value: string): void {
  assertSafeValue(value);
  if (
    value.length > MAX_AUTH_TOKEN_BYTES ||
    new TextEncoder().encode(value).byteLength > MAX_AUTH_TOKEN_BYTES
  ) {
    throw new ProbeAuthFailure('invalid_request');
  }
}

async function readTokenResponse(
  response: Response,
  signal: AbortSignal | undefined
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!response.body) {
    throw new ProbeAuthFailure('executor_failed');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk.byteLength > TOKEN_RESPONSE_MAX_BYTES - size) {
        await reader.cancel();
        throw new ProbeAuthFailure('executor_failed');
      }
      if (chunk.byteLength > 0) chunks.push(chunk);
      size += chunk.byteLength;
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    if (error instanceof ProbeAuthFailure) throw error;
    throw new ProbeAuthFailure('executor_failed');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ProbeAuthFailure('executor_failed');
  }
}

async function executeTokenRequest(
  request: Omit<ProbeApiResourceExecutorRequest, 'phase'>,
  executor: ProbeApiResourceExecutor,
  signal: AbortSignal | undefined
): Promise<unknown> {
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await executor({ ...request, phase: 'token' });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new ProbeAuthFailure('executor_failed');
  }

  signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProbeAuthFailure('executor_failed');
  }
  return readTokenResponse(response, signal);
}

function getByDotPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (BLOCKED_PATH_KEYS.has(segment) || typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function bodyToString(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return JSON.stringify(body);
}

function toExecutorRequest(
  applied: { url: string; headers: Record<string, string>; body?: unknown },
  request: ProbeAuthenticationRequest
): ProbeApiResourceExecutorRequest {
  return {
    url: applied.url,
    method: request.method,
    headers: applied.headers,
    body: bodyToString(applied.body),
    timeout_ms: request.timeout_ms,
    signal: request.signal,
    phase: 'resource',
  };
}

async function toBearerExecutorRequest(
  request: ProbeAuthenticationRequest,
  token: string,
  prefix: string
): Promise<ProbeApiResourceExecutorRequest> {
  const applied = await applyStaticApiRequestAuth({
    ...request,
    auth: { type: 'bearer', token },
  });
  return toExecutorRequest(
    { ...applied, headers: { ...applied.headers, Authorization: `${prefix}${token}` } },
    request
  );
}

function tokenFromPayload(payload: unknown, path: string): string {
  const token = getByDotPath(payload, path);
  if (typeof token !== 'string' || token === '') {
    throw new ProbeAuthFailure('executor_failed');
  }
  assertBoundedToken(token);
  return token;
}

async function exchangeOAuthToken(
  auth: Extract<CatalogProbeAuth, { type: 'oauth2' }>,
  executor: ProbeApiResourceExecutor,
  signal: AbortSignal | undefined
): Promise<{ token: string; prefix: string }> {
  assertSafeValue(auth.token_url);
  const body = new URLSearchParams();
  if (auth.grant_type === 'authorization_code') {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', auth.refresh_token);
  } else {
    body.set('grant_type', 'client_credentials');
  }
  body.set('client_id', auth.client_id);
  body.set('client_secret', auth.client_secret);
  if (auth.scopes && auth.scopes.length > 0) body.set('scope', auth.scopes.join(' '));

  const payload = await executeTokenRequest(
    {
      url: auth.token_url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      timeout_ms: TOKEN_FETCH_TIMEOUT_MS,
      signal,
    },
    executor,
    signal
  );
  const token = tokenFromPayload(payload, 'access_token');
  const record = payload as Record<string, unknown>;
  return {
    token,
    prefix: resolveApiRequestTokenPrefix({
      mode: 'oauth2',
      configuredPrefix: 'token_prefix' in auth ? auth.token_prefix : undefined,
      providerTokenType:
        typeof record['token_type'] === 'string' ? record['token_type'] : undefined,
    }),
  };
}

async function exchangeCustomToken(
  auth: Extract<CatalogProbeAuth, { type: 'custom-token' }>,
  executor: ProbeApiResourceExecutor,
  signal: AbortSignal | undefined
): Promise<{ token: string; prefix: string }> {
  assertSafeValue(auth.token_url);
  const method = auth.token_request?.method ?? 'POST';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(auth.token_request?.headers ?? {}),
  };
  const request: Omit<ProbeApiResourceExecutorRequest, 'phase'> = {
    url: auth.token_url,
    method,
    headers,
    timeout_ms: TOKEN_FETCH_TIMEOUT_MS,
    signal,
  };
  if (auth.token_request?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(auth.token_request.body);
  }

  const payload = await executeTokenRequest(request, executor, signal);
  const token = tokenFromPayload(payload, auth.token_response_path ?? 'access_token');
  return {
    token,
    prefix: resolveApiRequestTokenPrefix({
      mode: 'custom-token',
      configuredPrefix: auth.token_prefix,
    }),
  };
}

/**
 * Apply Bobsled Core's effective auth. Only token exchanges use the executor before
 * the resource request, and each exchange is performed once without caching.
 */
export async function applyProbeAuthentication(params: {
  request: ProbeAuthenticationRequest;
  executor: ProbeApiResourceExecutor;
}): Promise<{ request: ProbeApiResourceExecutorRequest; additionalSecrets: string[] }> {
  const { request, executor } = params;
  request.signal?.throwIfAborted();

  if (request.auth.type === 'oauth2') {
    const exchanged = await exchangeOAuthToken(request.auth, executor, request.signal);
    return {
      request: await toBearerExecutorRequest(request, exchanged.token, exchanged.prefix),
      additionalSecrets: [exchanged.token],
    };
  }

  if (request.auth.type === 'custom-token') {
    const exchanged = await exchangeCustomToken(request.auth, executor, request.signal);
    return {
      request: await toBearerExecutorRequest(request, exchanged.token, exchanged.prefix),
      additionalSecrets: [exchanged.token],
    };
  }

  const applied = await applyStaticApiRequestAuth({
    ...request,
    auth: request.auth as ApiRequestStaticAuth,
  });
  return {
    request: toExecutorRequest(applied, request),
    additionalSecrets: [...applied.derivedSecrets],
  };
}
