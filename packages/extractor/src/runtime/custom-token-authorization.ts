/**
 * Resolve an Integration's custom-token credential outside a Resource request.
 *
 * Hosts that call the same provider through another channel, or that hand a
 * credential to an isolated worker, use this to read the same shared token the
 * Resource runtime uses: the auth block is interpolated exactly as a request
 * would interpolate it, so the store key matches.
 */

import { buildApiIntegrationSpec } from './api-integration-spec.js';
import { ExtractorConfigError, toExtractorAuthRuntimeError } from './errors.js';
import { resolveRetryBackoffPolicy } from './retry-delay.js';
import {
  CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
  interpolateString,
  invalidateRejectedRuntimeAuth,
  applyHttpAuth,
  type CustomTokenGrant,
  type CustomTokenStore,
} from '../framework/runtime/index.js';
import { isSourceSpec, isSqlTransport, resolveVia } from '../framework/core/index.js';

import type { ApiIntegrationSpec, IntegrationSpec } from '../types/index.js';

export interface ResolveCustomTokenAuthorizationOptions {
  integration: IntegrationSpec;
  /** Transport id for a multi-transport source; the default transport otherwise. */
  via?: string;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  customTokenStore: CustomTokenStore;
  signal?: AbortSignal;
}

export interface CustomTokenAuthorization {
  /** The store key, identical to the one Resource requests use. */
  key: string;
  token: string;
  expiresAt: number;
  /** Complete `Authorization` header value, including the configured prefix. */
  authorization: string;
  /** Removes this token from the store when it is still the stored value. */
  invalidate: () => Promise<void>;
}

function resolveHttpIntegration(
  integration: IntegrationSpec,
  via: string | undefined
): ApiIntegrationSpec {
  if (isSourceSpec(integration)) {
    const transport = resolveVia(integration, via);
    if (isSqlTransport(transport)) {
      throw new ExtractorConfigError(`Integration "${integration.name}" has no HTTP transport.`);
    }
    return buildApiIntegrationSpec(integration, transport);
  }
  if (!('transport' in integration)) {
    throw new ExtractorConfigError(`Integration "${integration.name}" has no HTTP transport.`);
  }
  return integration as ApiIntegrationSpec;
}

/**
 * Whether Resource requests for this Integration read their custom token from a
 * host store: it uses custom-token auth whose lifetime exceeds the expiry buffer.
 */
export function sharesCustomToken(integration: IntegrationSpec, via?: string): boolean {
  try {
    const transport = resolveHttpIntegration(integration, via).transport;
    return (
      transport.type === 'http' &&
      transport.auth?.type === 'custom-token' &&
      (transport.auth.token_ttl_seconds ?? 3600) * 1000 > CUSTOM_TOKEN_EXPIRY_BUFFER_MS
    );
  } catch {
    return false;
  }
}

export async function resolveCustomTokenAuthorization(
  options: ResolveCustomTokenAuthorizationOptions
): Promise<CustomTokenAuthorization> {
  options.signal?.throwIfAborted();
  if (!sharesCustomToken(options.integration, options.via)) {
    throw new ExtractorConfigError(
      `Integration "${options.integration.name}" does not use a shareable custom token.`
    );
  }
  const integration = resolveHttpIntegration(options.integration, options.via);
  const transport = integration.transport;
  if (transport.type !== 'http' || transport.auth?.type !== 'custom-token') {
    throw new ExtractorConfigError(
      `Integration "${integration.name}" does not use custom-token authentication.`
    );
  }

  const secrets = options.secrets ?? {};
  const declaredSecretNames = options.declaredSecretNames ?? [];
  const context = {
    secrets,
    declaredSecretNames,
    env: secrets,
    declaredEnvVars: new Set(integration.auth_env_vars),
    trustedCredentialNames: new Set(declaredSecretNames),
  };

  let grant: CustomTokenGrant | undefined;
  const store: CustomTokenStore = {
    get: async (request) => {
      grant = await options.customTokenStore.get(request);
      return grant;
    },
    invalidate: (key, token) => options.customTokenStore.invalidate(key, token),
  };

  let authorized: Awaited<ReturnType<typeof applyHttpAuth>>;
  try {
    const baseUrl = interpolateString(transport.base_url, context, 'transport.base_url');
    authorized = await applyHttpAuth({
      url: baseUrl,
      method: 'GET',
      headers: {},
      timeout_ms: transport.timeout_ms ?? 30_000,
      auth: transport.auth,
      interpolationContext: { ...context, integration: { base_url: baseUrl } },
      integrationName: integration.name,
      customTokenStore: store,
      tokenRetry: resolveRetryBackoffPolicy(transport.retry),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toExtractorAuthRuntimeError(error, options.signal);
  }

  const identity = authorized.authCacheIdentity;
  const authorization = authorized.headers['Authorization'];
  if (!grant || identity?.sharedToken === undefined || authorization === undefined) {
    throw new Error('Custom token store did not provide a token');
  }
  return {
    key: identity.key,
    token: grant.token,
    expiresAt: grant.expiresAt,
    authorization,
    invalidate: () => invalidateRejectedRuntimeAuth(identity, options.customTokenStore),
  };
}
