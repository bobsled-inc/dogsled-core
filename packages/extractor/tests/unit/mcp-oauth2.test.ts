import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetDnsLookupForTests, setDnsLookupForTests } from '../../src/framework/core/index.js';
import { ExtractorTransientError } from '../../src/runtime/errors.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clearOAuth2TokenCache, fetchOAuth2Token } from '../../src/runtime/mcp-oauth2.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetDnsLookupForTests();
  clearOAuth2TokenCache();
});

describe('MCP OAuth2 deadlines', () => {
  it.each([400, 404, 429, 503])('preserves OAuth provider status %s', async (status) => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status, statusText: 'provider status' }))
    );

    const error = await fetchOAuth2Token(
      {
        type: 'oauth2',
        token_url: 'https://example.com/oauth/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      {}
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error).toMatchObject({ code: status });
  });

  it('accounts and rate-limits the token request before network access', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ access_token: 'token', expires_in: 3_600 }, { status: 200 })
      )
    );
    const order: string[] = [];

    await fetchOAuth2Token(
      {
        type: 'oauth2',
        token_url: 'https://example.com/oauth/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      {},
      undefined,
      () => order.push('attempt'),
      async () => {
        order.push('limit');
      }
    );

    expect(order).toEqual(['limit', 'attempt']);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('classifies the internal token deadline as a transient timeout', async () => {
    vi.useFakeTimers();
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true }
            );
          })
      )
    );

    const pending = fetchOAuth2Token(
      {
        type: 'oauth2',
        token_url: 'https://example.com/oauth/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      {}
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: ExtractorTransientError.name,
      message: expect.stringContaining('timed out'),
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('preserves caller cancellation instead of relabeling it as a timeout', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true }
            );
          })
      )
    );
    const controller = new AbortController();
    const reason = new DOMException('caller stopped', 'AbortError');
    const pending = fetchOAuth2Token(
      {
        type: 'oauth2',
        token_url: 'https://example.com/oauth/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      {},
      controller.signal
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

it('checks host declarations before cache reuse and separates injected credentials', async () => {
  setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
  const fetch = vi.fn(async () =>
    Response.json({ access_token: `token-${fetch.mock.calls.length}`, expires_in: 3600 })
  );
  vi.stubGlobal('fetch', fetch);
  const auth = {
    type: 'oauth2' as const,
    token_url: 'https://example.com/token',
    client_id: 'client',
    client_secret: '${{ secrets.HOST_TOKEN }}',
  };
  const request = (secrets: Record<string, string>, declaredSecretNames?: string[]) =>
    fetchOAuth2Token(auth, {}, undefined, undefined, undefined, new Set(), {
      secrets,
      declaredSecretNames,
    });
  const first = await request({ HOST_TOKEN: 'first-host' }, ['HOST_TOKEN']);
  await expect(request({ HOST_TOKEN: 'first-host' })).rejects.toThrow('Undeclared');
  const second = await request({ HOST_TOKEN: 'second-host' }, ['HOST_TOKEN']);
  expect(first).not.toBe(second);
  expect(fetch).toHaveBeenCalledTimes(2);
});
