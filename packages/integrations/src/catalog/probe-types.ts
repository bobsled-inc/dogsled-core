/**
 * Request-planning projection of a Dogsled API source/resource.
 *
 * This is deliberately smaller than a full extractor specification: it has
 * enough information to build one HTTP request, and has no pagination,
 * extraction, loader, retry, or state fields.
 */

export type CatalogProbeHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type CatalogProbeRequestPhase = 'token' | 'resource';
export type CatalogProbeFieldType =
  'string' | 'number' | 'integer' | 'boolean' | 'timestamp' | 'array' | 'object';

export type CatalogProbeJsonValue =
  | string
  | number
  | boolean
  | null
  | CatalogProbeJsonValue[]
  | { [key: string]: CatalogProbeJsonValue };

export interface CatalogProbeInputField {
  type: CatalogProbeFieldType;
  required?: boolean;
  description?: string;
  default?: CatalogProbeJsonValue;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  items?: CatalogProbeInputField;
  properties?: Record<string, CatalogProbeInputField>;
}

export type CatalogProbeAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; header?: string; query_param?: string; key: string }
  | { type: 'basic'; username: string; password: string }
  | {
      type: 'oauth2';
      grant_type: 'client_credentials';
      token_url: string;
      client_id: string;
      client_secret: string;
      scopes?: string[];
    }
  | {
      type: 'oauth2';
      grant_type: 'authorization_code';
      token_url: string;
      client_id: string;
      client_secret: string;
      refresh_token: string;
      scopes?: string[];
      token_prefix?: string;
    }
  | {
      type: 'custom-token';
      token_url: string;
      token_request?: {
        method?: 'GET' | 'POST' | 'PUT';
        headers?: Record<string, string>;
        body?: CatalogProbeJsonValue;
      };
      token_response_path?: string;
      token_prefix?: string;
      token_ttl_seconds?: number;
    }
  | {
      type: 'aws-sigv4';
      region: string;
      service: string;
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
    };

export interface CatalogProbeTransport {
  id: string;
  type: 'http';
  base_url: string;
  headers?: Record<string, string>;
  /** Sent only when every referenced variable resolves to a non-empty value. */
  optional_headers?: Record<string, string>;
  auth?: CatalogProbeAuth;
  timeout_ms?: number;
}

export interface CatalogProbeSource {
  auth_env_vars?: string[];
  name: string;
  default_transport: string;
  transports: Record<string, CatalogProbeTransport>;
}

export interface CatalogProbeApi {
  endpoint: string;
  method: CatalogProbeHttpMethod;
  timeout_ms?: number;
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  request_body?: CatalogProbeJsonValue;
  auth?: CatalogProbeAuth;
}

export interface CatalogProbeResource {
  name: string;
  via?: string;
  description?: string;
  input: Record<string, CatalogProbeInputField>;
  api: CatalogProbeApi;
}

export interface CatalogProbeDefinition {
  schema_version: 1;
  source: CatalogProbeSource;
  resource: CatalogProbeResource;
}

/**
 * The fully effective request delivered to the caller's network executor.
 * Authentication is already represented in headers/query parameters; the
 * executor never needs to interpret an auth descriptor.
 */
export interface ProbeApiResourceExecutorRequest {
  /** Resolved request URL; it is provided only to the injected executor. */
  url: string;
  method: CatalogProbeHttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeout_ms: number;
  signal?: AbortSignal;
  phase: CatalogProbeRequestPhase;
}

export type ProbeApiResourceExecutor = (
  request: ProbeApiResourceExecutorRequest
) => Promise<Response>;
