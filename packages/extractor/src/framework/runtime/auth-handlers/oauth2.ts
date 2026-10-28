import { createHash } from 'node:crypto';

import { resolveApiRequestTokenPrefix } from '@bobsled-inc/api-resource';

import {
  isPrivateHost,
  readResponseJsonWithLimit,
  resolveAndValidateHost,
  RESPONSE_BODY_LIMITS,
  safeFetch,
} from '../../core/index.js';
import type { ApplyAuthParams, ApplyAuthResult, AuthHandler } from '../http-client.js';
import type { OAuth2Auth } from '../../core/index.js';
import { TokenCache } from './token-cache.js';
import { OAuth2AuthStateStore } from './oauth2-state.js';

const DEFAULT_EXPIRES_IN = 3600;

/** Timeout for token fetch requests (ms). */
export const TOKEN_FETCH_TIMEOUT_MS = 30_000;

type OAuth2AccessToken = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
};

const tokenCache = new TokenCache<OAuth2AccessToken>();

function credentialHash(auth: OAuth2Auth): string {
  const scopes = auth.scopes?.slice().sort().join(',') ?? '';
  const resource = auth.grant_type === 'client_credentials' ? auth.resource : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        grant_type: auth.grant_type,
        client_secret: auth.client_secret,
        scopes,
        ...(resource === undefined ? {} : { resource }),
      })
    )
    .digest('hex');
}

function stateKey(auth: OAuth2Auth, integrationName?: string): string {
  return [
    integrationName ?? 'integration',
    auth.token_url,
    auth.client_id,
    credentialHash(auth),
  ].join(':');
}

function cacheKey(auth: OAuth2Auth, refreshToken?: string): string {
  const scopes = auth.scopes?.slice().sort().join(',') ?? '';
  const refreshTokenHash =
    auth.grant_type === 'authorization_code' && refreshToken
      ? createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
      : 'none';
  return `${auth.token_url}:${auth.client_id}:${auth.grant_type}:${scopes}:${credentialHash(auth).slice(0, 16)}:${refreshTokenHash}`;
}

async function fetchToken(
  auth: OAuth2Auth,
  refreshToken?: string,
  signal?: AbortSignal,
  beforeRequestAttempt?: () => void
): Promise<{ value: OAuth2AccessToken; expiresIn: number }> {
  signal?.throwIfAborted();
  const tokenHostname = new URL(auth.token_url).hostname;
  if (isPrivateHost(tokenHostname)) {
    throw new Error(`OAuth2 token URL points to a private/internal host: "${tokenHostname}"`);
  }
  await resolveAndValidateHost(tokenHostname, 'OAuth2 token URL');
  signal?.throwIfAborted();

  const body = new URLSearchParams();
  if (auth.grant_type === 'authorization_code') {
    body.set('grant_type', 'refresh_token');
    if (!refreshToken) {
      throw new Error('OAuth2 authorization_code auth requires a refresh_token');
    }
    body.set('refresh_token', refreshToken);
  } else {
    body.set('grant_type', 'client_credentials');
  }
  body.set('client_id', auth.client_id);
  body.set('client_secret', auth.client_secret);

  if (auth.scopes && auth.scopes.length > 0) {
    body.set('scope', auth.scopes.join(' '));
  }
  if (auth.grant_type === 'client_credentials' && auth.resource !== undefined) {
    body.set('resource', auth.resource);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    beforeRequestAttempt?.();
    response = await safeFetch(auth.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OAuth2 token request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    RESPONSE_BODY_LIMITS.token,
    'OAuth2 token response'
  );
  if (!payload || typeof payload !== 'object') {
    throw new Error('OAuth2 token response is not a JSON object');
  }

  const record = payload as Record<string, unknown>;
  const accessToken = record['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('OAuth2 token response missing access_token');
  }

  const expiresIn =
    typeof record['expires_in'] === 'number' && record['expires_in'] > 0
      ? record['expires_in']
      : DEFAULT_EXPIRES_IN;

  const nextRefreshToken =
    auth.grant_type === 'authorization_code' && typeof record['refresh_token'] === 'string'
      ? record['refresh_token']
      : refreshToken;
  const tokenType = typeof record['token_type'] === 'string' ? record['token_type'] : undefined;

  return {
    value: {
      accessToken,
      ...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
      ...(tokenType ? { tokenType } : {}),
    },
    expiresIn,
  };
}

export const oauth2AuthHandler: AuthHandler = {
  async applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult> {
    if (params.auth.type !== 'oauth2') {
      throw new Error(`Expected oauth2 auth, got ${params.auth.type}`);
    }
    const auth = params.auth;
    const persistedState =
      auth.grant_type === 'authorization_code' && params.stateDir
        ? await new OAuth2AuthStateStore(params.stateDir).get(
            stateKey(auth, params.integrationName)
          )
        : undefined;
    const effectiveRefreshToken =
      auth.grant_type === 'authorization_code'
        ? (persistedState?.refresh_token ?? auth.refresh_token)
        : undefined;
    const resolvedCacheKey = cacheKey(auth, effectiveRefreshToken);
    // The shared producer has its own timeout and is intentionally independent
    // of any one request. TokenCache races each waiter against its own signal.
    const token = await tokenCache.get(
      resolvedCacheKey,
      () => fetchToken(auth, effectiveRefreshToken, undefined, params.beforeRequestAttempt),
      params.signal
    );

    if (
      auth.grant_type === 'authorization_code' &&
      params.stateDir &&
      token.refreshToken &&
      token.refreshToken !== persistedState?.refresh_token
    ) {
      await new OAuth2AuthStateStore(params.stateDir).save(
        stateKey(auth, params.integrationName),
        token.refreshToken
      );
    }

    const authorizationPrefix = resolveApiRequestTokenPrefix({
      mode: 'oauth2',
      configuredPrefix: 'token_prefix' in auth ? auth.token_prefix : undefined,
      providerTokenType: token.tokenType,
    });

    return {
      url: params.url,
      headers: {
        ...params.headers,
        Authorization: `${authorizationPrefix}${token.accessToken}`,
      },
      body: params.body,
      resolvedSecrets: [token.accessToken],
      authCacheIdentity: {
        handler: 'oauth2',
        key: resolvedCacheKey,
      },
    };
  },
};

export function clearTokenCache(): void {
  tokenCache.clear();
}

export function invalidateTokenCache(key: string): void {
  tokenCache.delete(key);
}
