import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOAuthToken } from '../../src/runtime/oauth-token-fetcher.js';

describe('fetchOAuthToken', () => {
  let fakeFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeFetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs client_credentials grant and returns accessToken + expiresAt', async () => {
    const nowSeconds = 1_700_000_000;
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'tok-123',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await fetchOAuthToken({
      tokenUrl: 'https://example.com/oauth/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      fetch: fakeFetch,
      nowSeconds,
    });

    expect(result.accessToken).toBe('tok-123');
    expect(result.expiresAt).toBe(nowSeconds + 3600);

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://example.com/oauth/token');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    // HTTP Basic auth over client credentials
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`
    );
    const body = String((init as RequestInit).body);
    expect(body).toContain('grant_type=client_credentials');
  });

  it('rejects non-HTTPS token URLs (credential disclosure)', async () => {
    await expect(
      fetchOAuthToken({
        tokenUrl: 'http://public.example.com/oauth/token',
        clientId: 'c',
        clientSecret: 's',
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/https:/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('wraps 5xx responses as a transient-style error', async () => {
    fakeFetch.mockResolvedValueOnce(new Response('boom', { status: 502 }));
    await expect(
      fetchOAuthToken({
        tokenUrl: 'https://example.com/t',
        clientId: 'c',
        clientSecret: 's',
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/OAuth token request failed.*502/);
  });

  it('wraps 401 responses as an auth config error', async () => {
    fakeFetch.mockResolvedValueOnce(new Response('{"error":"invalid_client"}', { status: 401 }));
    await expect(
      fetchOAuthToken({
        tokenUrl: 'https://example.com/t',
        clientId: 'c',
        clientSecret: 's',
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/401|invalid_client/);
  });

  it('rejects malformed token responses', async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ not_a_token: 'oops' }), { status: 200 })
    );
    await expect(
      fetchOAuthToken({
        tokenUrl: 'https://example.com/t',
        clientId: 'c',
        clientSecret: 's',
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/access_token/);
  });

  it('wraps fetch() rejections (network errors)', async () => {
    fakeFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      fetchOAuthToken({
        tokenUrl: 'https://example.com/t',
        clientId: 'c',
        clientSecret: 's',
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/ECONNRESET|OAuth token request failed/);
  });
});
