import type { AuthConfig, HttpMethod } from '../core/index.js';
import type { InterpolationContext } from './interpolate.js';
import { interpolateValue } from './interpolate.js';

import type { CustomTokenStore } from './auth-handlers/custom-token-store.js';
import type { RetryBackoffPolicy } from '../../runtime/retry-delay.js';
import {
  clearRuntimeAuthCaches,
  getAuthHandler,
  invalidateRejectedRuntimeAuth,
  invalidateRuntimeAuthCache,
  type RuntimeAuthCacheIdentity,
} from './auth-handlers/index.js';

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  response_format?: 'json' | 'jsonl';
  headers: Record<string, string>;
  body?: unknown;
  timeout_ms: number;
  auth?: AuthConfig;
  authCacheIdentity?: RuntimeAuthCacheIdentity;
  /** Resolved dynamic credentials for request-scoped error redaction. */
  resolvedSecrets?: string[];
  integrationName?: string;
  interpolationContext?: InterpolationContext;
  stateDir?: string;
  signal?: AbortSignal;
  /** Called immediately before an authentication-provider request. */
  beforeRequestAttempt?: () => void;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
  /** Backoff for retryable token-endpoint statuses; the transport retry policy. */
  tokenRetry?: RetryBackoffPolicy;
}

export interface HttpResponse {
  data: unknown;
  headers: Headers;
  status: number;
}

export interface ApplyAuthParams {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  auth: AuthConfig;
  integrationName?: string;
  interpolationContext?: InterpolationContext;
  stateDir?: string;
  signal?: AbortSignal;
  /** Called immediately before an authentication-provider request. */
  beforeRequestAttempt?: () => void;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
  /** Backoff for retryable token-endpoint statuses; the transport retry policy. */
  tokenRetry?: RetryBackoffPolicy;
}

export interface ApplyAuthResult {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  authCacheIdentity?: RuntimeAuthCacheIdentity;
  resolvedSecrets?: string[];
}

export interface AuthHandler {
  applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult>;
}

export async function applyHttpAuth(request: HttpRequest): Promise<HttpRequest> {
  if (!request.auth || request.auth.type === 'none') {
    return request;
  }

  const interpolatedAuth = interpolateValue(
    request.auth,
    request.interpolationContext ?? {},
    'auth'
  ) as AuthConfig;

  const handler = getAuthHandler(interpolatedAuth.type);
  const result = await handler.applyAuth({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    auth: interpolatedAuth,
    interpolationContext: request.interpolationContext,
    stateDir: request.stateDir,
    integrationName: request.integrationName,
    signal: request.signal,
    beforeRequestAttempt: request.beforeRequestAttempt,
    ...(request.customTokenStore ? { customTokenStore: request.customTokenStore } : {}),
    ...(request.tokenRetry ? { tokenRetry: request.tokenRetry } : {}),
  });

  return {
    ...request,
    url: result.url,
    headers: result.headers,
    body: result.body,
    authCacheIdentity: result.authCacheIdentity,
    resolvedSecrets: result.resolvedSecrets,
  };
}

export { clearRuntimeAuthCaches, invalidateRejectedRuntimeAuth, invalidateRuntimeAuthCache };
export {
  CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
  type CustomTokenGrant,
  type CustomTokenStore,
  type CustomTokenStoreRequest,
} from './auth-handlers/custom-token-store.js';
