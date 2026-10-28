/**
 * Dependency-light contracts shared by API request planners.
 *
 * This module intentionally has no dependency on the extractor runtime. It is
 * used by the catalog-only resource probe as well as by the normal extractor
 * request builder.
 */

export type ApiRequestHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type ApiRequestInputMode = 'coerce' | 'strict';

export type ApiRequestResponseFormat = 'json' | 'jsonl';

export interface ApiRequestInputFieldDefinition {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'timestamp' | 'array' | 'object';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  items?: ApiRequestInputFieldDefinition;
  properties?: Record<string, ApiRequestInputFieldDefinition>;
}

export interface ApiRequestInterpolationMappedValues {
  [fieldName: string]: unknown;
}

export type ApiRequestInterpolationSource = 'input' | 'mapped' | 'secrets' | 'env' | 'integration';

/** One template reference resolved while planning a request. */
export interface ApiRequestInterpolationReference {
  source: ApiRequestInterpolationSource;
  /** Absent for a whole-object reference such as `${{ input }}`. */
  key?: string;
  /** The request location being rendered, such as `api.endpoint` or `headers.Authorization`. */
  path: string;
  /** For a query-string reference, the name of the query parameter it is sent in. */
  parameter?: string;
}

export interface ApiRequestInterpolationContext {
  input?: Record<string, unknown>;
  mapped?: ApiRequestInterpolationMappedValues;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  env?: Record<string, string | undefined>;
  declaredEnvVars?: ReadonlySet<string>;
  /** Probe mode supplies an explicit environment map and must not consult process.env. */
  allowProcessEnvFallback?: boolean;
  integration?: {
    base_url: string;
  };
  /**
   * Observes each reference after it resolves. A dry run uses it to report where
   * values are sent without re-parsing the template grammar; it never receives values.
   */
  onReference?: (reference: ApiRequestInterpolationReference) => void;
}

export interface ApiRequestConfig<TAuth = unknown> {
  base_url: string;
  endpoint: string;
  method: ApiRequestHttpMethod;
  response_format?: ApiRequestResponseFormat;
  timeout_ms: number;
  headers: Record<string, string>;
  /**
   * Headers sent only when every `${{ env.* }}` / `${{ secrets.* }}` reference
   * in the value resolves to a non-empty string. Lets a transport forward a
   * value the executing host supplies per request (an acting-user assertion,
   * a tenant hint) without making it a required credential for every caller.
   * A declared `headers` entry with the same name wins.
   */
  optional_headers?: Record<string, string>;
  query_params: Record<string, string>;
  request_body?: unknown;
  auth: TAuth;
}

export interface ApiRequestTransport<TAuth = unknown> {
  base_url: string;
  timeout_ms?: number;
  headers?: Record<string, string>;
  optional_headers?: Record<string, string>;
  auth?: TAuth;
  retry?: unknown;
  rate_limit?: unknown;
}

export interface ApiRequestOperation<TAuth = unknown> {
  endpoint: string;
  method: ApiRequestHttpMethod;
  response_format?: ApiRequestResponseFormat;
  timeout_ms?: number;
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  request_body?: unknown;
  auth?: TAuth;
}

export interface ResolvedApiRequestConfig<TAuth = unknown> extends ApiRequestConfig<TAuth> {
  retry?: unknown;
  rate_limit?: unknown;
}

export interface PlannedApiRequest<TAuth = unknown> {
  url: string;
  method: ApiRequestHttpMethod;
  response_format?: ApiRequestResponseFormat;
  headers: Record<string, string>;
  body?: unknown;
  timeout_ms: number;
  auth: TAuth;
  interpolationContext: ApiRequestInterpolationContext;
  input: Record<string, unknown>;
}
