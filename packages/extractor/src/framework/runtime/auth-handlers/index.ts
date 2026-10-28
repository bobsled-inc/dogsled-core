import type { AuthConfig } from '../../core/index.js';
import type { AuthHandler } from '../http-client.js';

import { apiKeyAuthHandler } from './api-key.js';
import { awsSigV4AuthHandler } from './aws-sigv4.js';
import { basicAuthHandler } from './basic.js';
import { bearerAuthHandler } from './bearer.js';
import {
  clearCustomTokenCache,
  customTokenAuthHandler,
  invalidateCustomTokenCache,
} from './custom-token.js';
import { clearTokenCache, invalidateTokenCache, oauth2AuthHandler } from './oauth2.js';

export interface RuntimeAuthCacheIdentity {
  handler: 'oauth2' | 'custom-token';
  key: string;
}

export function getAuthHandler(authType: AuthConfig['type']): AuthHandler {
  switch (authType) {
    case 'api-key':
      return apiKeyAuthHandler;
    case 'basic':
      return basicAuthHandler;
    case 'bearer':
      return bearerAuthHandler;
    case 'aws-sigv4':
      return awsSigV4AuthHandler;
    case 'oauth2':
      return oauth2AuthHandler;
    case 'custom-token':
      return customTokenAuthHandler;
    case 'none':
      throw new Error('No auth handler is required for auth type "none"');
    default: {
      const _exhaustive: never = authType;
      throw new Error(`Unknown auth type: ${_exhaustive}`);
    }
  }
}

export function clearRuntimeAuthCaches(): void {
  clearTokenCache();
  clearCustomTokenCache();
}

export function invalidateRuntimeAuthCache(identity: RuntimeAuthCacheIdentity | undefined): void {
  if (!identity) {
    return;
  }

  switch (identity.handler) {
    case 'oauth2':
      invalidateTokenCache(identity.key);
      break;
    case 'custom-token':
      invalidateCustomTokenCache(identity.key);
      break;
    default: {
      const _exhaustive: never = identity.handler;
      throw new Error(`Unknown auth cache handler: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
