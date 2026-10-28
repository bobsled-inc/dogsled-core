import { createHash } from 'node:crypto';
import type { InterpolationContext } from '../framework/runtime/interpolate.js';
/**
 * OAuth2 client_credentials token cache for MCP HTTP transports.
 */

import {
  isPrivateHost,
  readResponseJsonWithLimit,
  resolveAndValidateHost,
  RESPONSE_BODY_LIMITS,
  safeFetch,
} from '../framework/core/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { interpolateValue } from '../framework/runtime/index.js';
import { ExtractorTransientError } from './errors.js';

import type { ApiIntegrationSpec } from '../types/index.js';

type McpHttpTransportConfig = Extract<ApiIntegrationSpec['transport'], { type: 'mcp_http' }>;
type McpTransportAuth = NonNullable<McpHttpTransportConfig['auth']>;

// --- OAuth2 token cache (scoped per integration) ---

interface CachedOAuth2Token {
  value: string;
  expiresAt: number;
}

const OAUTH2_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const OAUTH2_FETCH_TIMEOUT_MS = 30_000;
const oauth2TokenCache = new Map<string, CachedOAuth2Token>();

function buildOAuth2CacheKey(
  resolvedTokenUrl: string,
  resolvedClientId: string,
  resolvedClientSecret: string,
  scopes: string[] | undefined
): string {
  return JSON.stringify({
    clientId: resolvedClientId,
    credentialHash: createHash('sha256').update(resolvedClientSecret).digest('hex'),
    scopes: (scopes ?? []).slice().sort().join(' '),
    tokenUrl: resolvedTokenUrl,
  });
}

/** Visible for testing. */
export function clearOAuth2TokenCache(): void {
  oauth2TokenCache.clear();
}

export async function fetchOAuth2Token(
  auth: Extract<McpTransportAuth, { type: 'oauth2' }>,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  beforeRequestAttempt?: () => void,
  beforeNetworkRequest?: (signal: AbortSignal) => Promise<void>,
  declaredEnvVars: ReadonlySet<string> = new Set(),
  hostSecrets: Pick<InterpolationContext, 'secrets' | 'declaredSecretNames'> = {}
): Promise<string> {
  signal?.throwIfAborted();
  const tokenUrl = String(
    interpolateValue(
      auth.token_url,
      { ...hostSecrets, env, declaredEnvVars },
      'transport.auth.token_url'
    )
  );
  const clientId = String(
    interpolateValue(
      auth.client_id,
      { ...hostSecrets, env, declaredEnvVars },
      'transport.auth.client_id'
    )
  );
  const clientSecret = String(
    interpolateValue(
      auth.client_secret,
      { ...hostSecrets, env, declaredEnvVars },
      'transport.auth.client_secret'
    )
  );
  const cacheKey = buildOAuth2CacheKey(tokenUrl, clientId, clientSecret, auth.scopes);

  // Return cached token if still valid
  const cached = oauth2TokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + OAUTH2_EXPIRY_BUFFER_MS) {
    return cached.value;
  }

  const tokenHostname = new URL(tokenUrl).hostname;
  if (isPrivateHost(tokenHostname)) {
    throw new Error(`OAuth2 token URL points to a private or internal host: "${tokenHostname}"`);
  }

  // DNS pre-resolution for OAuth2 token URL
  await resolveAndValidateHost(tokenHostname, 'OAuth2 token URL');
  signal?.throwIfAborted();

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);

  if (auth.scopes && auth.scopes.length > 0) {
    body.set('scope', auth.scopes.join(' '));
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), OAUTH2_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    await beforeNetworkRequest?.(controller.signal);
    beforeRequestAttempt?.();
    response = await safeFetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    // Caller cancellation keeps its original AbortSignal reason. The internal
    // deadline is a retryable network timeout, not an indistinguishable user
    // abort.
    signal?.throwIfAborted();
    if (controller.signal.aborted) {
      throw new ExtractorTransientError(
        `MCP OAuth2 token request timed out after ${OAUTH2_FETCH_TIMEOUT_MS}ms.`,
        error instanceof Error ? error : undefined
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new StreamableHTTPError(
      response.status,
      `MCP OAuth2 token request failed: ${response.status} ${response.statusText}`
    );
  }

  const payload = await readResponseJsonWithLimit(
    response,
    RESPONSE_BODY_LIMITS.token,
    'MCP OAuth2 token response'
  );
  if (!payload || typeof payload !== 'object') {
    throw new Error('MCP OAuth2 token response is not a JSON object');
  }

  const record = payload as Record<string, unknown>;
  const accessToken = record['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('MCP OAuth2 token response missing access_token');
  }

  // Cache the token with its TTL (skip caching for zero/negative expiry)
  const expiresIn = typeof record['expires_in'] === 'number' ? record['expires_in'] : 3600;
  if (expiresIn > 0) {
    oauth2TokenCache.set(cacheKey, {
      value: accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });
  }

  return accessToken;
}
