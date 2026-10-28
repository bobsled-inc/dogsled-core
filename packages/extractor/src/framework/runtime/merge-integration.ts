import type { AuthConfig, HttpMethod, RateLimitConfig, RetryConfig } from '../core/index.js';
import type { ApiConfig } from '../core/operation.js';
import { mergeApiRequest } from '@bobsled-inc/api-resource';

export interface IntegrationTransport {
  base_url: string;
  timeout_ms?: number;
  headers?: Record<string, string>;
  optional_headers?: Record<string, string>;
  auth?: AuthConfig;
  retry?: RetryConfig;
  rate_limit?: RateLimitConfig;
}

export interface ResolvedApiConfig {
  base_url: string;
  endpoint: string;
  method: HttpMethod;
  response_format?: 'json' | 'jsonl';
  timeout_ms: number;
  headers: Record<string, string>;
  optional_headers?: Record<string, string>;
  query_params: Record<string, string>;
  request_body?: unknown;
  auth: AuthConfig;
  retry?: RetryConfig;
  rate_limit?: RateLimitConfig;
}

export function mergeIntegrationOperation(
  integration: { transport: IntegrationTransport },
  api: ApiConfig
): ResolvedApiConfig {
  return mergeApiRequest(integration.transport, api) as ResolvedApiConfig;
}
