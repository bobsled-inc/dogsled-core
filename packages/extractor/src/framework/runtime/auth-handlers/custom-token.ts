import { createHash } from 'node:crypto';

import { resolveApiRequestTokenPrefix } from '@bobsled-inc/api-resource';

import {
  isObject,
  isPrivateHost,
  readResponseJsonWithLimit,
  resolveAndValidateHost,
  RESPONSE_BODY_LIMITS,
  safeFetch,
} from '../../core/index.js';
import type { ApplyAuthParams, ApplyAuthResult, AuthHandler } from '../http-client.js';
import { TokenCache } from './token-cache.js';

import type { CustomTokenAuth } from '../../core/index.js';

const DEFAULT_TOKEN_RESPONSE_PATH = 'access_token';
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** Timeout for token fetch requests (ms). */
export const TOKEN_FETCH_TIMEOUT_MS = 30_000;

const tokenCache = new TokenCache<string>();

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getByDotPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (BLOCKED_KEYS.has(segment) || !isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function buildCacheKey(auth: CustomTokenAuth): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        token_url: auth.token_url,
        token_request: auth.token_request ?? {},
      })
    )
    .digest('hex');
}

async function fetchToken(
  auth: CustomTokenAuth,
  signal?: AbortSignal,
  beforeRequestAttempt?: () => void
): Promise<string> {
  signal?.throwIfAborted();
  const tokenHostname = new URL(auth.token_url).hostname;
  if (isPrivateHost(tokenHostname)) {
    throw new Error(`Custom token URL points to a private/internal host: "${tokenHostname}"`);
  }
  await resolveAndValidateHost(tokenHostname, 'Custom token URL');
  signal?.throwIfAborted();

  const method = auth.token_request?.method ?? 'POST';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(auth.token_request?.headers ?? {}),
  };

  const requestInit: RequestInit = {
    method,
    headers,
    redirect: 'error',
  };

  if (auth.token_request?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(auth.token_request.body);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
  try {
    requestInit.signal = controller.signal;
    beforeRequestAttempt?.();
    const response = await safeFetch(auth.token_url, requestInit);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Custom token request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await readResponseJsonWithLimit(
      response,
      RESPONSE_BODY_LIMITS.token,
      'Custom token response'
    );
    const token = getByDotPath(payload, auth.token_response_path ?? DEFAULT_TOKEN_RESPONSE_PATH);
    if (typeof token !== 'string' || token === '') {
      throw new Error(
        `Custom token response missing token at path "${auth.token_response_path ?? DEFAULT_TOKEN_RESPONSE_PATH}"`
      );
    }

    return token;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export const customTokenAuthHandler: AuthHandler = {
  async applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult> {
    if (params.auth.type !== 'custom-token') {
      throw new Error(`Expected custom-token auth, got ${params.auth.type}`);
    }
    const auth = params.auth;

    const ttlSeconds = auth.token_ttl_seconds ?? DEFAULT_TOKEN_TTL_SECONDS;

    // TTL of 0 means no caching — always fetch fresh
    let accessToken: string;
    if (ttlSeconds === 0) {
      accessToken = await fetchToken(auth, params.signal, params.beforeRequestAttempt);
    } else {
      accessToken = await tokenCache.get(
        buildCacheKey(auth),
        async () => ({
          // A cached fetch is shared across callers, so its producer must not
          // inherit one caller's cancellation. Each waiter remains separately
          // cancellable through TokenCache's signal argument.
          value: await fetchToken(auth, undefined, params.beforeRequestAttempt),
          expiresIn: ttlSeconds,
        }),
        params.signal
      );
    }

    return {
      url: params.url,
      headers: {
        ...params.headers,
        Authorization: `${resolveApiRequestTokenPrefix({
          mode: 'custom-token',
          configuredPrefix: auth.token_prefix,
        })}${accessToken}`,
      },
      body: params.body,
      resolvedSecrets: [accessToken],
      ...(ttlSeconds === 0
        ? {}
        : {
            authCacheIdentity: {
              handler: 'custom-token',
              key: buildCacheKey(auth),
            },
          }),
    };
  },
};

export function clearCustomTokenCache(): void {
  tokenCache.clear();
}

export function invalidateCustomTokenCache(key: string): void {
  tokenCache.delete(key);
}
