import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyHttpAuth,
  clearRuntimeAuthCaches,
  CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
  type CustomTokenGrant,
  type CustomTokenStore,
  type CustomTokenStoreRequest,
} from '../../src/framework/runtime/index.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { lookupResource } from '../../src/runtime/lookup.js';
import {
  resolveCustomTokenAuthorization,
  sharesCustomToken,
} from '../../src/runtime/custom-token-authorization.js';
import { BobsledRuntimeError } from '@bobsled-inc/protocol';

import { makeProvider, makeResource } from '../helpers/fixtures.js';

const TOKEN_URL = 'https://auth.example.com/token';

const customTokenAuth = {
  type: 'custom-token' as const,
  token_url: TOKEN_URL,
  token_request: { method: 'POST' as const, headers: { 'x-client-secret': 'client-secret' } },
  token_ttl_seconds: 3600,
};

class SharedTokenStore implements CustomTokenStore {
  readonly grants = new Map<string, CustomTokenGrant>();
  readonly requests: CustomTokenStoreRequest[] = [];
  private readonly minting = new Map<string, Promise<CustomTokenGrant>>();

  async get(request: CustomTokenStoreRequest): Promise<CustomTokenGrant> {
    this.requests.push(request);
    const stored = this.grants.get(request.key);
    if (stored && stored.expiresAt - request.expiryBufferMs > Date.now()) return stored;
    let pending = this.minting.get(request.key);
    if (!pending) {
      pending = request.mint().then((grant) => {
        this.grants.set(request.key, grant);
        return grant;
      });
      this.minting.set(request.key, pending);
      void pending.finally(() => this.minting.delete(request.key)).catch(() => undefined);
    }
    return pending;
  }

  async invalidate(key: string, token: string): Promise<void> {
    if (this.grants.get(key)?.token === token) this.grants.delete(key);
  }
}

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 201 });
}

function isTokenRequest(input: unknown): boolean {
  return String(input) === TOKEN_URL;
}

describe('custom-token shared store', () => {
  afterEach(() => {
    clearRuntimeAuthCaches();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the token through the host store under the in-process cache key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('minted-token'));
    vi.stubGlobal('fetch', fetchMock);
    const store = new SharedTokenStore();

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: customTokenAuth,
      customTokenStore: store,
    });

    expect(request.headers['Authorization']).toBe('Bearer minted-token');
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatchObject({
      key: request.authCacheIdentity?.key,
      ttlSeconds: 3600,
      expiryBufferMs: CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
    });
    expect(request.authCacheIdentity).toEqual({
      handler: 'custom-token',
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      sharedToken: 'minted-token',
    });
    expect(store.grants.get(request.authCacheIdentity!.key)?.expiresAt).toBeGreaterThan(
      Date.now() + 3_500_000
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a token another worker stored without a token request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store: CustomTokenStore = {
      get: async () => ({ token: 'stored-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      invalidate: async () => undefined,
    };

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: customTokenAuth,
      customTokenStore: store,
    });

    expect(request.headers['Authorization']).toBe('Bearer stored-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let the in-process cache shadow the host store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('process-token')));
    await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: customTokenAuth,
    });
    const store: CustomTokenStore = {
      get: async () => ({ token: 'store-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      invalidate: async () => undefined,
    };

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: customTokenAuth,
      customTokenStore: store,
    });

    expect(request.headers['Authorization']).toBe('Bearer store-token');
  });

  it('bypasses the host store when the integration disables token caching', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('fresh-token')));
    const store = new SharedTokenStore();

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: { ...customTokenAuth, token_ttl_seconds: 0 },
      customTokenStore: store,
    });

    expect(request.headers['Authorization']).toBe('Bearer fresh-token');
    expect(request.authCacheIdentity).toBeUndefined();
    expect(store.requests).toHaveLength(0);
  });

  it('fails as an authentication error when the store returns no token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', { auth: customTokenAuth }),
      customTokenStore: {
        get: async () => ({ token: '', expiresAt: Date.now() + 60_000 }),
        invalidate: async () => undefined,
      },
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(BobsledRuntimeError);
    expect(error).toMatchObject({ kind: 'auth', code: 'EXTRACTOR_HTTP_AUTH_FAILURE' });
  });

  it('mints one token for concurrent lookups that share a store', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isTokenRequest(input)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return tokenResponse('shared-token');
      }
      return new Response(JSON.stringify({ id: 'share-1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = new SharedTokenStore();
    const integration = makeProvider('https://api.example.com', { auth: customTokenAuth });
    const resource = makeResource({
      api: { endpoint: '/shares', method: 'GET' },
      lookup: {
        api: { endpoint: '/shares/${{ input.id }}', method: 'GET' },
        input: { id: { type: 'string', required: true } },
      },
      output: { id: { path: 'id', type: 'string' } },
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        lookupResource({
          integration,
          resource,
          input: { id: `share-${index}` },
          customTokenStore: store,
        })
      )
    );

    expect(results).toHaveLength(25);
    expect(fetchMock.mock.calls.filter(([input]) => isTokenRequest(input))).toHaveLength(1);
    for (const [input, init] of fetchMock.mock.calls) {
      if (isTokenRequest(input)) continue;
      expect(new Headers((init as RequestInit).headers).get('authorization')).toBe(
        'Bearer shared-token'
      );
    }
  });

  it('clears a rejected shared token, mints once, and retries once', async () => {
    let minted = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isTokenRequest(input)) {
        minted += 1;
        return tokenResponse(`token-${minted}`);
      }
      const authorization = new Headers(init?.headers).get('authorization');
      return authorization === 'Bearer token-2'
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response('', { status: 401, statusText: 'Unauthorized' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = new SharedTokenStore();
    const integration = makeProvider('https://api.example.com', { auth: customTokenAuth });
    const resource = makeResource({ api: { endpoint: '/items', method: 'GET' } });
    const invalidate = vi.spyOn(store, 'invalidate');

    const response = await new ExtractorClient({ integration, customTokenStore: store }).request({
      operation: resource,
    });

    expect(response.data).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 'token-1');
    expect(minted).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const other = await new ExtractorClient({ integration, customTokenStore: store }).request({
      operation: resource,
    });
    expect(other.data).toEqual({ ok: true });
    expect(minted).toBe(2);
  });

  it('resolves the same shared token a Resource request reads', async () => {
    const fetchMock = vi.fn(async (input: unknown) =>
      isTokenRequest(input)
        ? tokenResponse('shared-token')
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = new SharedTokenStore();
    const integration = makeProvider('https://api.example.com', {
      auth: {
        ...customTokenAuth,
        token_request: {
          method: 'POST',
          headers: { 'x-client-secret': '${{ env.CLIENT_SECRET }}' },
        },
      },
      auth_env_vars: ['CLIENT_SECRET'],
    });
    const secrets = { CLIENT_SECRET: 'client-secret' };

    const authorization = await resolveCustomTokenAuthorization({
      integration,
      secrets,
      declaredSecretNames: ['CLIENT_SECRET'],
      customTokenStore: store,
    });
    await new ExtractorClient({
      integration,
      secrets,
      env: secrets,
      declaredSecretNames: ['CLIENT_SECRET'],
      customTokenStore: store,
    }).request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) });

    expect(authorization).toMatchObject({
      key: store.requests[0]!.key,
      token: 'shared-token',
      authorization: 'Bearer shared-token',
    });
    expect(store.requests.map((request) => request.key)).toEqual([
      authorization.key,
      authorization.key,
    ]);
    expect(fetchMock.mock.calls.filter(([input]) => isTokenRequest(input))).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
      'x-client-secret': 'client-secret',
    });

    await authorization.invalidate();
    expect(store.grants.size).toBe(0);
  });

  it('refuses to resolve a token for an Integration without custom-token auth', async () => {
    await expect(
      resolveCustomTokenAuthorization({
        integration: makeProvider('https://api.example.com', {
          auth: { type: 'bearer', token: 'static' },
        }),
        customTokenStore: new SharedTokenStore(),
      })
    ).rejects.toThrow('does not use a shareable custom token');
  });

  it('keeps a token that expires within the buffer out of the host store', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('short-lived'));
    vi.stubGlobal('fetch', fetchMock);
    const store = new SharedTokenStore();
    const shortLived = { ...customTokenAuth, token_ttl_seconds: 300 };

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: shortLived,
      customTokenStore: store,
    });

    expect(request.headers['Authorization']).toBe('Bearer short-lived');
    expect(store.requests).toHaveLength(0);
    expect(sharesCustomToken(makeProvider('https://api.example.com', { auth: shortLived }))).toBe(
      false
    );
    expect(
      sharesCustomToken(makeProvider('https://api.example.com', { auth: customTokenAuth }))
    ).toBe(true);
  });
});
