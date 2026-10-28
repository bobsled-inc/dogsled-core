import { describe, expect, it, vi } from 'vitest';

import { OAuth2Client } from 'google-auth-library';

import {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  createTokenCommandProvider,
  isInvalidCredentialsError,
  parseTokenCommandOutput,
  TOKEN_REFRESH_SKEW_SECONDS,
  type BigQueryAccessToken,
} from '../../src/runtime/bigquery-auth.js';
import { ExtractorConfigError } from '../../src/runtime/errors.js';

describe('RefreshableTokenSource', () => {
  it('caches a valid token and does not re-fetch within the skew window', async () => {
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockResolvedValue({ accessToken: 't1', expiresAt: 1_000 + 4_000 });
    const source = new RefreshableTokenSource(provider, { skewSeconds: 300, now: () => 1_000 });

    expect(await source.getToken()).toBe('t1');
    expect(await source.getToken()).toBe('t1');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('proactively re-fetches when the cached token is within the skew window', async () => {
    const clock = 1_000;
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockResolvedValueOnce({ accessToken: 't1', expiresAt: clock + 100 })
      .mockResolvedValueOnce({ accessToken: 't2', expiresAt: clock + 4_000 });
    const source = new RefreshableTokenSource(provider, { skewSeconds: 300, now: () => clock });

    expect(await source.getToken()).toBe('t1');
    expect(await source.getToken()).toBe('t2');
    expect(await source.getToken()).toBe('t2');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a still-valid cached token', async () => {
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockResolvedValueOnce({ accessToken: 't1', expiresAt: 1_000 + 4_000 })
      .mockResolvedValueOnce({ accessToken: 't2', expiresAt: 1_000 + 4_000 });
    const source = new RefreshableTokenSource(provider, { now: () => 1_000 });

    expect(await source.getToken()).toBe('t1');
    expect(await source.getToken(true)).toBe('t2');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('rejects a provider token containing CR/LF (header injection)', async () => {
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockResolvedValue({ accessToken: 'abc\r\nX-Evil: 1', expiresAt: 9_999 });
    const source = new RefreshableTokenSource(provider, { now: () => 1_000 });

    await expect(source.getToken()).rejects.toThrow(/CR\/LF/);
  });

  it('coalesces concurrent fetches into a single provider call', async () => {
    let resolve!: (t: BigQueryAccessToken) => void;
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockReturnValue(new Promise<BigQueryAccessToken>((r) => (resolve = r)));
    const source = new RefreshableTokenSource(provider, { now: () => 1_000 });

    const a = source.getToken();
    const b = source.getToken();
    resolve({ accessToken: 't1', expiresAt: 9_999 });

    expect(await a).toBe('t1');
    expect(await b).toBe('t1');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('defaults the skew window to 5 minutes', () => {
    expect(TOKEN_REFRESH_SKEW_SECONDS).toBe(300);
  });
});

describe('createRefreshableAuthClient', () => {
  it('serves Bearer headers and access tokens from the source, refreshing proactively', async () => {
    const clock = 1_000;
    const provider = vi
      .fn<[], Promise<BigQueryAccessToken>>()
      .mockResolvedValueOnce({ accessToken: 'first', expiresAt: clock + 100 })
      .mockResolvedValueOnce({ accessToken: 'second', expiresAt: clock + 9_999 });
    const tokenSource = new RefreshableTokenSource(provider, {
      skewSeconds: 300,
      now: () => clock,
    });
    const authClient = createRefreshableAuthClient({ tokenSource, OAuth2Client });

    // getRequestHeaders returns a Web `Headers` object (google-auth v10
    // contract) so the BigQuery SDK actually attaches the Authorization header.
    const h1 = (await authClient.getRequestHeaders()) as unknown as Headers;
    expect(h1.get('authorization')).toBe('Bearer first');
    const h2 = (await authClient.getRequestHeaders()) as unknown as Headers;
    expect(h2.get('authorization')).toBe('Bearer second');
    expect((await authClient.getAccessToken()).token).toBe('second');
    expect(authClient).toBeInstanceOf(OAuth2Client);
  });
});

describe('parseTokenCommandOutput', () => {
  it('parses access_token + absolute expires_at', () => {
    const out = parseTokenCommandOutput('{"access_token":"abc","expires_at":1750000000}');
    expect(out).toEqual({ accessToken: 'abc', expiresAt: 1_750_000_000 });
  });

  it('falls back to expires_in (seconds from now)', () => {
    const out = parseTokenCommandOutput('{"access_token":"abc","expires_in":3600}', 1_000);
    expect(out).toEqual({ accessToken: 'abc', expiresAt: 4_600 });
  });

  it('defaults to a 1-hour TTL when neither expiry field is present', () => {
    const out = parseTokenCommandOutput('{"access_token":"abc"}', 1_000);
    expect(out).toEqual({ accessToken: 'abc', expiresAt: 4_600 });
  });

  it('throws on invalid JSON without echoing the (secret) stdout', () => {
    const secret = 'ya29.SUPER-SECRET-TOKEN-not-json';
    expect(() => parseTokenCommandOutput(secret)).toThrow(/was not valid JSON/);
    try {
      parseTokenCommandOutput(secret);
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPER-SECRET-TOKEN');
    }
  });

  it('throws when access_token is missing', () => {
    expect(() => parseTokenCommandOutput('{"expires_at":1}')).toThrow(/missing.*access_token/);
  });

  it('rejects a token containing CR/LF (header injection)', () => {
    expect(() =>
      parseTokenCommandOutput('{"access_token":"abc\\r\\nX-Evil: 1","expires_at":1}')
    ).toThrow(/CR\/LF/);
  });
});

describe('createTokenCommandProvider', () => {
  it('runs the command and parses its stdout', async () => {
    const execImpl = vi.fn().mockResolvedValue({
      stdout: '{"access_token":"cmd-token","expires_at":1750000000}',
      stderr: '',
    });
    const provider = createTokenCommandProvider('mint-token --json', {
      execImpl: execImpl as never,
    });

    const token = await provider();

    expect(execImpl).toHaveBeenCalledWith(
      'mint-token --json',
      expect.objectContaining({ timeout: 30_000 })
    );
    expect(token).toEqual({ accessToken: 'cmd-token', expiresAt: 1_750_000_000 });
  });

  it('wraps command failures with sanitized exit metadata only (no command text / stderr leak)', async () => {
    // The exec error message echoes the command + stderr, which can include a
    // token the command printed to stderr on failure — it must never leak.
    const execImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('command not found: bogus'), { code: 127 }));
    const provider = createTokenCommandProvider('bogus', { execImpl: execImpl as never });

    let caught: unknown;
    await provider().catch((e) => {
      caught = e;
    });
    // Fail-fast config error (extractor taxonomy), with a sanitized message.
    expect(caught).toBeInstanceOf(ExtractorConfigError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('token_command failed (exitCode=127)');
    expect(message).not.toContain('bogus');
  });
});

describe('isInvalidCredentialsError', () => {
  it('detects numeric 401 code', () => {
    const err = Object.assign(new Error('boom'), { code: 401 });
    expect(isInvalidCredentialsError(err)).toBe(true);
  });

  it('detects nested response.status 401', () => {
    const err = Object.assign(new Error('boom'), { response: { status: 401 } });
    expect(isInvalidCredentialsError(err)).toBe(true);
  });

  it('detects the canonical invalid-credentials message', () => {
    const err = new Error(
      'Request had invalid authentication credentials. Expected OAuth 2 access token ... Invalid Credentials'
    );
    expect(isInvalidCredentialsError(err)).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isInvalidCredentialsError(new Error('rate limit exceeded'))).toBe(false);
    expect(isInvalidCredentialsError('not an error')).toBe(false);
  });
});
