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
import {
  DEFAULT_RETRY_BACKOFF,
  retryDelayMs,
  type RetryBackoffPolicy,
} from '../../../runtime/retry-delay.js';
import { CUSTOM_TOKEN_EXPIRY_BUFFER_MS, type CustomTokenStore } from './custom-token-store.js';
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

const RETRYABLE_TOKEN_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

function tokenStatusError(response: Response): Error {
  return Object.assign(
    new Error(`Custom token request failed: ${response.status} ${response.statusText}`),
    { status: response.status }
  );
}

function sleepUntilRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchToken(
  auth: CustomTokenAuth,
  signal: AbortSignal | undefined,
  beforeRequestAttempt: (() => void) | undefined,
  retry: RetryBackoffPolicy
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
  const deadlineAt = Date.now() + TOKEN_FETCH_TIMEOUT_MS;
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Custom token request timed out after ${TOKEN_FETCH_TIMEOUT_MS}ms`,
          'TimeoutError'
        )
      ),
    TOKEN_FETCH_TIMEOUT_MS
  );
  try {
    requestInit.signal = controller.signal;
    for (let attempt = 0; ; attempt++) {
      beforeRequestAttempt?.();
      const response = await safeFetch(auth.token_url, requestInit);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const failure = tokenStatusError(response);
        if (!RETRYABLE_TOKEN_STATUSES.has(response.status) || attempt >= retry.maxRetries) {
          throw failure;
        }
        const waitMs = retryDelayMs(retry, response, attempt);
        if (Date.now() + waitMs >= deadlineAt) throw failure;
        await sleepUntilRetry(waitMs, controller.signal);
        continue;
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
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

async function readSharedToken(
  store: CustomTokenStore,
  key: string,
  auth: CustomTokenAuth,
  ttlSeconds: number,
  params: ApplyAuthParams,
  tokenRetry: RetryBackoffPolicy
): Promise<string> {
  const grant = await store.get({
    key,
    ttlSeconds,
    expiryBufferMs: CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
    mint: async () => {
      const token = await fetchToken(auth, undefined, params.beforeRequestAttempt, tokenRetry);
      return { token, expiresAt: Date.now() + ttlSeconds * 1000 };
    },
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  if (typeof grant?.token !== 'string' || grant.token === '') {
    throw new Error('Custom token store returned no token');
  }
  return grant.token;
}

export const customTokenAuthHandler: AuthHandler = {
  async applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult> {
    if (params.auth.type !== 'custom-token') {
      throw new Error(`Expected custom-token auth, got ${params.auth.type}`);
    }
    const auth = params.auth;

    const ttlSeconds = auth.token_ttl_seconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    const cacheKey = ttlSeconds === 0 ? undefined : buildCacheKey(auth);
    const store =
      ttlSeconds * 1000 > CUSTOM_TOKEN_EXPIRY_BUFFER_MS ? params.customTokenStore : undefined;
    const tokenRetry = params.tokenRetry ?? DEFAULT_RETRY_BACKOFF;

    // TTL of 0 means no caching — always fetch fresh
    let accessToken: string;
    if (cacheKey === undefined) {
      accessToken = await fetchToken(auth, params.signal, params.beforeRequestAttempt, tokenRetry);
    } else if (store) {
      accessToken = await readSharedToken(store, cacheKey, auth, ttlSeconds, params, tokenRetry);
    } else {
      accessToken = await tokenCache.get(
        cacheKey,
        async () => ({
          // A cached fetch is shared across callers, so its producer must not
          // inherit one caller's cancellation. Each waiter remains separately
          // cancellable through TokenCache's signal argument.
          value: await fetchToken(auth, undefined, params.beforeRequestAttempt, tokenRetry),
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
      ...(cacheKey === undefined
        ? {}
        : {
            authCacheIdentity: {
              handler: 'custom-token',
              key: cacheKey,
              ...(store ? { sharedToken: accessToken } : {}),
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
