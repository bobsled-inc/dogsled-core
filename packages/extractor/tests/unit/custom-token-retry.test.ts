import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearRuntimeAuthCaches } from '../../src/framework/runtime/index.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { DogsledRuntimeError } from '@bobsled-inc/protocol';

import { makeProvider, makeResource } from '../helpers/fixtures.js';

const TOKEN_URL = 'https://auth.example.com/token';

const customTokenAuth = {
  type: 'custom-token' as const,
  token_url: TOKEN_URL,
  token_request: { method: 'POST' as const },
  token_ttl_seconds: 3600,
};

const resource = makeResource({ api: { endpoint: '/shares', method: 'GET' } });

function tokenStatus(status: number, retryAfter = '0'): Response {
  return new Response('', {
    status,
    statusText: `status ${status}`,
    headers: { 'retry-after': retryAfter },
  });
}

function stubTokenEndpoint(tokenResponses: Array<() => Response>) {
  const tokenCalls: number[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === TOKEN_URL) {
      tokenCalls.push(Date.now());
      const next = tokenResponses.shift();
      if (!next) throw new Error('unexpected token request');
      return next();
    }
    const authorization = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ authorization }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, tokenCalls };
}

function minted(token: string): () => Response {
  return () => new Response(JSON.stringify({ access_token: token }), { status: 201 });
}

function client(retry?: Record<string, unknown>): ExtractorClient {
  return new ExtractorClient({
    integration: makeProvider('https://api.example.com', {
      auth: customTokenAuth,
      ...(retry ? { retry } : {}),
    }),
  });
}

async function requestError(target: ExtractorClient): Promise<DogsledRuntimeError> {
  const error = await target.request({ operation: resource }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(DogsledRuntimeError);
  return error as DogsledRuntimeError;
}

describe('custom-token request failures', () => {
  afterEach(() => {
    clearRuntimeAuthCaches();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries a throttled token request and completes the read', async () => {
    const { tokenCalls } = stubTokenEndpoint([
      () => tokenStatus(429),
      () => tokenStatus(429),
      minted('fresh-token'),
    ]);

    const response = await client().request({ operation: resource });

    expect(response.data).toEqual({ authorization: 'Bearer fresh-token' });
    expect(tokenCalls).toHaveLength(3);
  });

  it.each([500, 502, 503, 504])('retries a token request that answers %i', async (status) => {
    const { tokenCalls } = stubTokenEndpoint([() => tokenStatus(status), minted('fresh-token')]);

    const response = await client().request({ operation: resource });

    expect(response.data).toEqual({ authorization: 'Bearer fresh-token' });
    expect(tokenCalls).toHaveLength(2);
  });

  it('reports exhausted token throttling as a retryable provider failure with its status', async () => {
    const { tokenCalls, fetchMock } = stubTokenEndpoint(
      Array.from({ length: 4 }, () => () => tokenStatus(429))
    );

    const error = await requestError(client());

    expect(tokenCalls).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_AUTH_PROVIDER_FAILURE',
      retryable: true,
      providerStatus: 429,
    });
    expect(error.cause?.message).toBe('Custom token request failed: 429 status 429');
  });

  it('reports an exhausted failing token endpoint as a retryable provider failure', async () => {
    stubTokenEndpoint([() => tokenStatus(503), () => tokenStatus(503)]);

    const error = await requestError(client({ max_retries: 1 }));

    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_AUTH_PROVIDER_FAILURE',
      retryable: true,
      providerStatus: 503,
    });
  });

  it.each([400, 401, 403])(
    'reports a token endpoint that answers %i as an authentication failure without retrying',
    async (status) => {
      const { tokenCalls } = stubTokenEndpoint([() => tokenStatus(status)]);

      const error = await requestError(client());

      expect(tokenCalls).toHaveLength(1);
      expect(error).toMatchObject({
        kind: 'auth',
        code: 'EXTRACTOR_HTTP_AUTH_FAILURE',
        retryable: false,
      });
      expect(error.providerStatus).toBeUndefined();
      expect((error.cause as Error & { status?: number }).status).toBe(status);
    }
  );

  it('reports another token endpoint status as a non-retryable provider failure', async () => {
    const { tokenCalls } = stubTokenEndpoint([() => tokenStatus(404)]);

    const error = await requestError(client());

    expect(tokenCalls).toHaveLength(1);
    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_AUTH_PROVIDER_FAILURE',
      retryable: false,
      providerStatus: 404,
    });
  });

  it('stops retrying when Retry-After would pass the token deadline', async () => {
    const { tokenCalls } = stubTokenEndpoint([() => tokenStatus(429, '120')]);

    const error = await requestError(client());

    expect(tokenCalls).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'provider', retryable: true, providerStatus: 429 });
  });

  it('backs off exponentially when the token endpoint sends no Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const failure = () => new Response('', { status: 502, statusText: 'Bad Gateway' });
    const { tokenCalls } = stubTokenEndpoint([failure, failure, minted('fresh-token')]);

    const pending = client().request({ operation: resource });
    await vi.advanceTimersByTimeAsync(999);
    expect(tokenCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(tokenCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      data: { authorization: 'Bearer fresh-token' },
    });
    expect(tokenCalls).toHaveLength(3);
  });

  it('reports an unreachable token endpoint as a retryable network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const error = await requestError(client());

    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_NETWORK_FAILURE',
      retryable: true,
    });
  });

  it('clears the cached token after a resource 401, mints once, and retries once', async () => {
    let resourceCalls = 0;
    const tokens = ['first-token', 'second-token'];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: tokens.shift() }), { status: 201 });
      }
      resourceCalls += 1;
      const authorization = new Headers(init?.headers).get('authorization');
      return authorization === 'Bearer second-token'
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response('', { status: 401, statusText: 'Unauthorized' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await client().request({ operation: resource });

    expect(response.data).toEqual({ ok: true });
    expect(resourceCalls).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === TOKEN_URL)).toHaveLength(2);
  });
});
