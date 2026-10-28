/**
 * OAuth 2.0 client_credentials grant fetcher.
 *
 * Used by the Snowflake destination when a target references an integration with
 * `auth.type: oauth`. Fetches a short-lived access token via HTTPS POST and hands
 * it to `snowflake-sdk` via `authenticator: 'OAUTH'` + `token`.
 *
 * Security invariants:
 * - Token URL MUST be https:// (refuses cleartext — credentials are in the body + Basic auth).
 * - Client credentials are sent via HTTP Basic auth header, never in the URL.
 */

export type FetchLike = typeof fetch;

export interface FetchOAuthTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional: comma-separated scopes. Not all Snowflake OAuth setups require this. */
  scope?: string;
  /** Override fetch implementation for testing. */
  fetch?: FetchLike;
  /** Override `Date.now()` for deterministic tests (seconds since epoch). */
  nowSeconds?: number;
}

export interface OAuthToken {
  accessToken: string;
  /** Unix timestamp (seconds) when this token expires. */
  expiresAt: number;
}

export async function fetchOAuthToken(options: FetchOAuthTokenOptions): Promise<OAuthToken> {
  let url: URL;
  try {
    url = new URL(options.tokenUrl);
  } catch {
    throw new Error(`OAuth token URL is not a valid URL: ${options.tokenUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `OAuth token URL must use https://; refusing to send client credentials over cleartext to ${options.tokenUrl}`
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (options.scope) body.set('scope', options.scope);

  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');

  let response: Response;
  try {
    response = await fetchImpl(options.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(
      `OAuth token request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (response.status !== 200) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OAuth token request failed with status ${response.status}: ${text || '<no body>'}`
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(
      `OAuth token response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { access_token?: unknown }).access_token !== 'string'
  ) {
    throw new Error('OAuth token response is missing access_token');
  }

  const token = parsed as { access_token: string; expires_in?: number };
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3_600;

  return {
    accessToken: token.access_token,
    expiresAt: now + expiresIn,
  };
}
