/**
 * Refreshable managed-credential support (BigQuery / GCS / Snowflake OAuth).
 *
 * Background: host applications and downstream orchestrators cannot ship long-lived key material —
 * they mint a SHORT-LIVED (~1h) OAuth 2.0 access token. BigQuery's REST API
 * re-validates the token on EVERY request, so any task whose wall-clock exceeds
 * the token TTL fails mid-run with "Request had invalid authentication
 * credentials". Snowflake authenticates the session at connect time, so an
 * OAuth session likewise rides a fixed token horizon.
 *
 * The static `accessToken` path (`OAuth2Client.setCredentials`) never refreshes.
 * This module provides a token-PROVIDER seam: a callback returning a fresh
 * `{ accessToken, expiresAt }`, wrapped in a custom google-auth `AuthClient`
 * that re-fetches proactively (before expiry) and reactively (on a 401). The
 * same auth client is shared by the BigQuery SDK client and the GCS staging
 * Storage client so both refresh together.
 *
 * This file is the SINGLE source of truth for the refreshable-token machinery.
 * `@bobsled-inc/loader` re-exports it (see `loader/src/runtime/bigquery-auth.ts`)
 * and the `@bobsled-inc/connections` warehouse runners consume it directly so
 * long-running Model Spec model + entity-graph tasks refresh mid-run exactly like the
 * loader does — without a second, divergent implementation.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { OAuth2Client } from 'google-auth-library';

/** Value-side constructor of `OAuth2Client`, via a type query so the runtime
 * import stays type-only (safe under `verbatimModuleSyntax`). */
type OAuth2ClientCtor = typeof import('google-auth-library').OAuth2Client;

const execAsync = promisify(exec);

/**
 * A short-lived OAuth 2.0 access token plus its absolute expiry.
 * `expiresAt` is a Unix timestamp in **seconds**.
 */
export interface BigQueryAccessToken {
  accessToken: string;
  /** Unix timestamp (seconds) when this token expires. */
  expiresAt: number;
}

/** Fetches a fresh access token on demand. Called for initial auth AND refresh. */
export type BigQueryTokenProvider = () => Promise<BigQueryAccessToken>;

/** Tuning for {@link RefreshableTokenSource} — both injectable for tests. */
export interface RefreshableTokenSourceOptions {
  /** Re-fetch this many seconds before `expiresAt`. */
  skewSeconds?: number;
  /** Clock returning the current Unix time in seconds. */
  now?: () => number;
}

/** Inputs to {@link createRefreshableAuthClient}. */
export interface RefreshableAuthClientOptions {
  tokenSource: RefreshableTokenSource;
  OAuth2Client: OAuth2ClientCtor;
}

/** Raw JSON shape emitted by a `credentials_token_command`. */
interface TokenCommandOutput {
  access_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
}

/** Options for {@link createTokenCommandProvider}. */
export interface TokenCommandProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  execImpl?: typeof execAsync;
}

/** Subset of a `child_process.exec` error we surface — never the message/stderr. */
interface ExecFailure {
  code?: unknown;
  signal?: unknown;
  killed?: boolean;
}

/**
 * Reject tokens carrying CR/LF — they would be written verbatim into the
 * `Authorization` header and could inject additional headers into BigQuery/GCS
 * requests. Matches the loader's "strip newlines from all header values" rule.
 */
function assertNoHeaderInjection(accessToken: string): void {
  if (/[\r\n]/.test(accessToken)) {
    throw new Error(
      'Access token contains CR/LF characters; refusing to use it as an Authorization header'
    );
  }
}

/**
 * Re-fetch when the current token is within this many seconds of its expiry.
 * 5 minutes comfortably exceeds any single BigQuery job round-trip, so a token
 * served from cache is always valid for the request it authenticates.
 */
export const TOKEN_REFRESH_SKEW_SECONDS = 300;

/**
 * Caches the most recent token from a {@link BigQueryTokenProvider} and decides
 * when to re-fetch. Concurrent callers share a single in-flight fetch so a burst
 * of parallel queries doesn't stampede the provider.
 */
export class RefreshableTokenSource {
  private readonly provider: BigQueryTokenProvider;
  private readonly skewSeconds: number;
  private readonly nowSeconds: () => number;
  private cached?: BigQueryAccessToken;
  private inflight?: Promise<BigQueryAccessToken>;

  constructor(provider: BigQueryTokenProvider, options: RefreshableTokenSourceOptions = {}) {
    this.provider = provider;
    this.skewSeconds = options.skewSeconds ?? TOKEN_REFRESH_SKEW_SECONDS;
    this.nowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Return a valid access token, fetching a fresh one if the cache is empty,
   * within the skew window, or `forceRefresh` is set (reactive 401 backstop).
   */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && !this.isExpiring(this.cached)) {
      return this.cached.accessToken;
    }
    if (!this.inflight) {
      const fetch = this.provider()
        .then((token) => {
          assertNoHeaderInjection(token.accessToken);
          this.cached = token;
          return token;
        })
        .finally(() => {
          if (this.inflight === fetch) {
            this.inflight = undefined;
          }
        });
      this.inflight = fetch;
    }
    const token = await this.inflight;
    return token.accessToken;
  }

  /**
   * Return the full cached token ({@link BigQueryAccessToken}), fetching when
   * the cache is empty, within the skew window, or `forceRefresh` is set.
   * Snowflake needs the `expiresAt` alongside the token (it reconnects on a
   * fresh session token), so it consults this rather than {@link getToken}.
   */
  async getAccessToken(forceRefresh = false): Promise<BigQueryAccessToken> {
    if (!forceRefresh && this.cached && !this.isExpiring(this.cached)) {
      return this.cached;
    }
    if (!this.inflight) {
      const fetch = this.provider()
        .then((token) => {
          assertNoHeaderInjection(token.accessToken);
          this.cached = token;
          return token;
        })
        .finally(() => {
          if (this.inflight === fetch) {
            this.inflight = undefined;
          }
        });
      this.inflight = fetch;
    }
    return this.inflight;
  }

  /** True when `token` is empty/within the skew window of expiry. */
  isExpiring(token: BigQueryAccessToken): boolean {
    return this.nowSeconds() >= token.expiresAt - this.skewSeconds;
  }
}

/**
 * Build a custom google-auth `AuthClient` (subclassing `OAuth2Client`) backed by
 * a {@link RefreshableTokenSource}. Both `getAccessToken()` and
 * `getRequestHeaders()` consult the source, so every BigQuery/GCS REST call gets
 * a proactively-refreshed token. `@google-cloud/common` injects the returned
 * headers on each request, which is what makes refresh-while-running work.
 */
export function createRefreshableAuthClient(options: RefreshableAuthClientOptions): OAuth2Client {
  const { tokenSource, OAuth2Client: OAuth2ClientCtor } = options;

  class RefreshableAuthClient extends OAuth2ClientCtor {
    override async getAccessToken(): Promise<{ token?: string | null; res?: null }> {
      const token = await tokenSource.getToken();
      return { token, res: null };
    }

    override async getRequestHeaders(): Promise<Record<string, string>> {
      const token = await tokenSource.getToken();
      return { Authorization: `Bearer ${token}` };
    }
  }

  return new RefreshableAuthClient();
}

/**
 * Parse the stdout of a `credentials_token_command`. Expects JSON
 * `{ "access_token": string, "expires_at": number }` where `expires_at` is a
 * Unix timestamp in seconds. Falls back to `{ "expires_in": number }` (seconds
 * from now) and, if neither is present, assumes a conservative 1-hour TTL.
 */
export function parseTokenCommandOutput(stdout: string, nowSeconds?: number): BigQueryAccessToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Do NOT echo stdout — it is the credential payload and would leak the
    // bearer token into logs / user-visible errors.
    throw new Error(
      `credentials_token_command output was not valid JSON (${stdout.length} bytes). Expected {"access_token":"...","expires_at":<unix seconds>}.`
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('credentials_token_command output must be a JSON object');
  }
  const obj = parsed as TokenCommandOutput;
  if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
    throw new Error('credentials_token_command output is missing a non-empty "access_token"');
  }
  assertNoHeaderInjection(obj.access_token);

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  let expiresAt: number;
  if (typeof obj.expires_at === 'number' && Number.isFinite(obj.expires_at)) {
    expiresAt = obj.expires_at;
  } else if (typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    expiresAt = now + obj.expires_in;
  } else {
    expiresAt = now + 3_600;
  }

  return { accessToken: obj.access_token, expiresAt };
}

/**
 * Wrap a shell command into a {@link BigQueryTokenProvider}. The command is
 * spawned once per fetch and its stdout parsed by {@link parseTokenCommandOutput}.
 * Inherits `process.env` so the command can use ambient credentials.
 */
export function createTokenCommandProvider(
  command: string,
  options: TokenCommandProviderOptions = {}
): BigQueryTokenProvider {
  const run = options.execImpl ?? execAsync;
  return async () => {
    let stdout: string;
    try {
      const result = await run(command, {
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      });
      stdout = String(result.stdout);
    } catch (error) {
      // Surface only sanitized exit metadata. A `child_process.exec` error's
      // `message`/`stderr` echo the command text and anything the token command
      // printed to stderr — which can include the bearer token on failure — so
      // they must never reach logs or user-visible errors.
      const failure = (error ?? {}) as ExecFailure;
      const details: string[] = [];
      if (failure.code !== undefined) details.push(`exitCode=${String(failure.code)}`);
      if (typeof failure.signal === 'string') details.push(`signal=${failure.signal}`);
      if (failure.killed === true) details.push('timedOut=true');
      throw new Error(
        `credentials_token_command failed${details.length > 0 ? ` (${details.join(', ')})` : ''}`
      );
    }
    return parseTokenCommandOutput(stdout);
  };
}

/**
 * Detect a managed-credential "invalid/expired credentials" failure — the
 * signal for the reactive force-refresh backstop. Matches both numeric 401
 * (BigQuery SDK / Gaxios, Snowflake auth lapse) and the canonical message text.
 */
export function isInvalidCredentialsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const status =
    (error as { status?: unknown }).status ??
    (error as { response?: { status?: unknown } }).response?.status;
  if (code === 401 || status === 401) return true;
  return /invalid authentication credentials|invalid credentials|unauthenticated|authentication token has expired|oauth access token expired|invalid oauth access token/i.test(
    error.message
  );
}
