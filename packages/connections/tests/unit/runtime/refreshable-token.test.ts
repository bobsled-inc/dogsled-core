/**
 * Core refreshable-token mechanism — the single implementation shared by the
 * loader and the connections warehouse runners. Proves the proactive (skew
 * window) + reactive (force-refresh) refresh, the header-injection guard, and
 * the `credentials_token_command` parsing, all with injected `now` / `exec` so
 * no real clock or subprocess is needed.
 */
import { OAuth2Client } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';

import {
  RefreshableTokenSource,
  TOKEN_REFRESH_SKEW_SECONDS,
  createRefreshableAuthClient,
  createTokenCommandProvider,
  isInvalidCredentialsError,
  parseTokenCommandOutput,
  type BigQueryAccessToken,
} from '../../../src/runtime/refreshable-token.js';

describe('RefreshableTokenSource', () => {
  it('serves a cached token while it is comfortably valid (provider called once)', async () => {
    const provider = vi.fn(async () => ({ accessToken: 'tok-1', expiresAt: 10_000 }));
    const source = new RefreshableTokenSource(provider, { now: () => 0, skewSeconds: 300 });

    expect(await source.getToken()).toBe('tok-1');
    expect(await source.getToken()).toBe('tok-1');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('proactively re-fetches once the token enters the skew window', async () => {
    let now = 0;
    let n = 0;
    const provider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: now + 3_600 }));
    const source = new RefreshableTokenSource(provider, { now: () => now, skewSeconds: 300 });

    expect(await source.getToken()).toBe('tok-1'); // mint at t=0, expires 3600
    now = 3_000; // still > 3600-300 ⇒ valid
    expect(await source.getToken()).toBe('tok-1');
    expect(provider).toHaveBeenCalledTimes(1);

    now = 3_400; // within skew (>= 3300) ⇒ re-mint (tok-2 expires at 3400+3600=7000)
    expect(await source.getToken()).toBe('tok-2');
    expect(provider).toHaveBeenCalledTimes(2);

    now = 4_000; // PAST the original token's 3600 expiry — still serving the refreshed tok-2
    expect(await source.getToken()).toBe('tok-2');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('force-refreshes even when the cached token is still valid (reactive 401 backstop)', async () => {
    let n = 0;
    const provider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: 10_000 }));
    const source = new RefreshableTokenSource(provider, { now: () => 0 });

    expect(await source.getToken()).toBe('tok-1');
    expect(await source.getToken(true)).toBe('tok-2');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('rejects a token carrying CR/LF (header-injection guard)', async () => {
    const source = new RefreshableTokenSource(async () => ({
      accessToken: 'tok\r\nX-Evil: 1',
      expiresAt: 10_000,
    }));
    await expect(source.getToken()).rejects.toThrow(/CR\/LF|Authorization header/);
  });

  it('shares a single in-flight fetch across concurrent callers', async () => {
    let resolveFetch: (t: BigQueryAccessToken) => void = () => {};
    const provider = vi.fn(
      () =>
        new Promise<BigQueryAccessToken>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const source = new RefreshableTokenSource(provider, { now: () => 0 });

    const a = source.getToken();
    const b = source.getToken();
    resolveFetch({ accessToken: 'tok-1', expiresAt: 10_000 });
    expect(await a).toBe('tok-1');
    expect(await b).toBe('tok-1');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('getAccessToken exposes expiresAt; isExpiring honours injected now/skew', async () => {
    const source = new RefreshableTokenSource(
      async () => ({ accessToken: 'tok-1', expiresAt: 1_000 }),
      { now: () => 800, skewSeconds: 300 }
    );
    const token = await source.getAccessToken();
    expect(token).toEqual({ accessToken: 'tok-1', expiresAt: 1_000 });
    expect(source.isExpiring(token)).toBe(true); // 800 >= 1000-300
    expect(source.isExpiring({ accessToken: 'x', expiresAt: 5_000 })).toBe(false);
  });

  it('defaults the skew to 5 minutes', () => {
    expect(TOKEN_REFRESH_SKEW_SECONDS).toBe(300);
  });
});

describe('createRefreshableAuthClient', () => {
  it('mints a Bearer header per request and proactively re-mints across the skew boundary', async () => {
    let now = 0;
    let n = 0;
    const provider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: now + 3_600 }));
    const tokenSource = new RefreshableTokenSource(provider, { now: () => now, skewSeconds: 300 });
    const authClient = createRefreshableAuthClient({ tokenSource, OAuth2Client });

    // Each BigQuery/GCS REST call goes through getRequestHeaders → this is the
    // proactive per-request refresh mechanism.
    expect(await authClient.getRequestHeaders()).toEqual({ Authorization: 'Bearer tok-1' });
    now = 3_400; // within skew of the t=0 token's 3600 expiry
    expect(await authClient.getRequestHeaders()).toEqual({ Authorization: 'Bearer tok-2' });
    expect((await authClient.getAccessToken()).token).toBe('tok-2');
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe('parseTokenCommandOutput', () => {
  it('reads access_token + absolute expires_at', () => {
    expect(parseTokenCommandOutput('{"access_token":"abc","expires_at":1234}')).toEqual({
      accessToken: 'abc',
      expiresAt: 1234,
    });
  });

  it('converts expires_in (seconds-from-now) using the supplied clock', () => {
    expect(parseTokenCommandOutput('{"access_token":"abc","expires_in":600}', 1_000)).toEqual({
      accessToken: 'abc',
      expiresAt: 1_600,
    });
  });

  it('falls back to a conservative 1-hour TTL when no expiry is present', () => {
    expect(parseTokenCommandOutput('{"access_token":"abc"}', 1_000)).toEqual({
      accessToken: 'abc',
      expiresAt: 4_600,
    });
  });

  it('rejects non-JSON without echoing the payload (no token leak)', () => {
    let message = '';
    try {
      parseTokenCommandOutput('super-secret-bearer-value');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain('super-secret-bearer-value');
  });

  it('rejects a missing access_token and a CR/LF token', () => {
    expect(() => parseTokenCommandOutput('{"expires_at":1}')).toThrow(/access_token/);
    expect(() => parseTokenCommandOutput('{"access_token":"a\\nb"}')).toThrow(/CR\/LF|injection/);
  });
});

describe('createTokenCommandProvider', () => {
  it('runs the command via the injected exec and parses its stdout', async () => {
    const execImpl = vi.fn(async () => ({
      stdout: '{"access_token":"minted","expires_at":9999}',
      stderr: '',
    }));
    const provider = createTokenCommandProvider('mint-token.sh', {
      execImpl: execImpl as never,
    });
    expect(await provider()).toEqual({ accessToken: 'minted', expiresAt: 9999 });
    expect(execImpl).toHaveBeenCalledWith(
      'mint-token.sh',
      expect.objectContaining({ timeout: 30_000 })
    );
  });

  it('wraps a command failure with sanitized exit metadata only (no command text / stderr leak)', async () => {
    const execImpl = vi.fn(async () => {
      // exec errors carry the command + stderr in `.message` — which can include
      // a token the command printed to stderr on failure.
      throw Object.assign(new Error('Command failed: boom.sh\nsecret-token-on-stderr'), {
        code: 7,
      });
    });
    const provider = createTokenCommandProvider('boom.sh', { execImpl: execImpl as never });

    let message = '';
    await provider().catch((e) => {
      message = e instanceof Error ? e.message : String(e);
    });
    expect(message).toBe('credentials_token_command failed (exitCode=7)');
    expect(message).not.toContain('secret-token-on-stderr');
    expect(message).not.toContain('boom.sh');
  });
});

describe('isInvalidCredentialsError', () => {
  it('matches numeric 401 (code or status) and canonical messages', () => {
    expect(isInvalidCredentialsError(Object.assign(new Error('x'), { code: 401 }))).toBe(true);
    expect(isInvalidCredentialsError(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(
      isInvalidCredentialsError(Object.assign(new Error('x'), { response: { status: 401 } }))
    ).toBe(true);
    expect(
      isInvalidCredentialsError(new Error('Request had invalid authentication credentials'))
    ).toBe(true);
    expect(isInvalidCredentialsError(new Error('Invalid OAuth access token'))).toBe(true);
  });

  it('returns false for unrelated errors and non-errors', () => {
    expect(isInvalidCredentialsError(new Error('table not found'))).toBe(false);
    expect(isInvalidCredentialsError('nope')).toBe(false);
    expect(isInvalidCredentialsError(undefined)).toBe(false);
  });
});
