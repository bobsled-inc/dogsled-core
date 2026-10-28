/**
 * Refreshable BigQuery credential support (source/extractor side).
 *
 * Background: host applications and downstream orchestrators cannot ship long-lived GCP key material — they mint a SHORT-LIVED
 * (~1h) OAuth 2.0 access token by impersonating a per-account service account.
 * BigQuery's REST API re-validates the token on EVERY request, so any
 * extraction whose wall-clock exceeds the token TTL fails mid-run with
 * "Request had invalid authentication credentials".
 *
 * The static `accessToken` path (`OAuth2Client.setCredentials`) never refreshes.
 * This module provides a token-PROVIDER seam: a callback returning a fresh
 * `{ accessToken, expiresAt }`, wrapped in a custom google-auth `AuthClient`
 * that re-fetches proactively (before expiry) and reactively (on a 401).
 *
 * The canonical implementation now lives in `@bobsled-inc/connections`
 * (`runtime/refreshable-token.ts`); the loader is a thin re-export of it. This
 * extractor copy stays separate for now — extractor→connections consolidation
 * is a planned follow-up (see `@bobsled-inc/connections` `src/index.ts`) — but
 * is kept BEHAVIOURALLY in sync (sanitized token-command errors, the same
 * invalid-credentials matcher). It intentionally differs in two ways:
 *   1. `getRequestHeaders()` returns a Web `Headers` object (the extractor's
 *      `@google-cloud/bigquery` v8 + google-auth v10 contract requires it; a
 *      plain object drops the header). The loader/connections copy returns a
 *      plain object for their google-auth v9 contract.
 *   2. Error/usage messages use the extractor's `token_command` config field
 *      name (the loader's field is `credentials_token_command`).
 * Keep this copy in sync with the connections module when either changes.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { OAuth2Client } from 'google-auth-library';

import { ExtractorConfigError } from './errors.js';

const execAsync = promisify(exec);

/**
 * A short-lived GCP OAuth 2.0 access token plus its absolute expiry.
 * `expiresAt` is a Unix timestamp in **seconds**.
 */
export interface BigQueryAccessToken {
  accessToken: string;
  /** Unix timestamp (seconds) when this token expires. */
  expiresAt: number;
}

/** Fetches a fresh access token on demand. Called for initial auth AND refresh. */
export type BigQueryTokenProvider = () => Promise<BigQueryAccessToken>;

/**
 * Reject tokens carrying CR/LF — they would be written verbatim into the
 * `Authorization` header and could inject additional headers into BigQuery
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
 * of parallel result-page requests doesn't stampede the provider.
 */
export class RefreshableTokenSource {
  private readonly provider: BigQueryTokenProvider;
  private readonly skewSeconds: number;
  private readonly nowSeconds: () => number;
  private cached?: BigQueryAccessToken;
  private inflight?: Promise<BigQueryAccessToken>;

  constructor(
    provider: BigQueryTokenProvider,
    options: { skewSeconds?: number; now?: () => number } = {}
  ) {
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

  private isExpiring(token: BigQueryAccessToken): boolean {
    return this.nowSeconds() >= token.expiresAt - this.skewSeconds;
  }
}

/**
 * Build a custom google-auth `AuthClient` (subclassing `OAuth2Client`) backed by
 * a {@link RefreshableTokenSource}. Both `getAccessToken()` and
 * `getRequestHeaders()` consult the source, so every BigQuery REST call gets a
 * proactively-refreshed token. `@google-cloud/common` injects the returned
 * headers on each request, which is what makes refresh-while-running work.
 */
export function createRefreshableAuthClient(options: {
  tokenSource: RefreshableTokenSource;
  OAuth2Client: typeof OAuth2Client;
}): OAuth2Client {
  const { tokenSource, OAuth2Client: OAuth2ClientCtor } = options;

  class RefreshableAuthClient extends OAuth2ClientCtor {
    override async getAccessToken(): Promise<{ token?: string | null; res?: null }> {
      const token = await tokenSource.getToken();
      return { token, res: null };
    }

    override async getRequestHeaders(): Promise<Record<string, string>> {
      const token = await tokenSource.getToken();
      // The consumer (`@google-cloud/bigquery` v8) reads these headers through
      // google-auth-library v10's contract, where `getRequestHeaders()` returns
      // a Web `Headers` object. Returning a plain object drops the header — the
      // request goes out unauthenticated and BigQuery rejects it with
      // "Expected OAuth 2 access token". Build types here resolve to the
      // catalog's google-auth v9 (`Record<string,string>`), so cast; the
      // runtime value is a `Headers` instance, which v10 + v9 both accept.
      return new Headers({ Authorization: `Bearer ${token}` }) as unknown as Record<string, string>;
    }
  }

  return new RefreshableAuthClient();
}

/**
 * Parse the stdout of a `token_command`. Expects JSON
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
      `token_command output was not valid JSON (${stdout.length} bytes). Expected {"access_token":"...","expires_at":<unix seconds>}.`
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('token_command output must be a JSON object');
  }
  const obj = parsed as { access_token?: unknown; expires_at?: unknown; expires_in?: unknown };
  if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
    throw new Error('token_command output is missing a non-empty "access_token"');
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
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; execImpl?: typeof execAsync } = {}
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
      // `message`/stderr echo the command text and anything the token command
      // printed to stderr — which can include the bearer token on failure — so
      // they must never reach logs or user-visible errors.
      const failure = (error ?? {}) as { code?: unknown; signal?: unknown; killed?: boolean };
      const details: string[] = [];
      if (failure.code !== undefined) details.push(`exitCode=${String(failure.code)}`);
      if (typeof failure.signal === 'string') details.push(`signal=${failure.signal}`);
      if (failure.killed === true) details.push('timedOut=true');
      // Auth/config failure (incl. command-not-found) → fail-fast via the
      // extractor error taxonomy, not a generic retryable-looking Error. The
      // original error is NOT passed as `cause` — it carries the leaky message.
      throw new ExtractorConfigError(
        `token_command failed${details.length > 0 ? ` (${details.join(', ')})` : ''}`
      );
    }
    return parseTokenCommandOutput(stdout);
  };
}

/**
 * Detect a GCP "invalid/expired credentials" failure — the signal for the
 * reactive force-refresh backstop. Matches both numeric 401 (BigQuery SDK,
 * Gaxios) and the canonical message text.
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
