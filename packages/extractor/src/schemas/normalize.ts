import {
  formatLegacyBlueprintDeprecation,
  normalizeLegacyBlueprintKeys,
} from '@bobsled-inc/protocol';

/**
 * Config normalization — renames common camelCase YAML keys to snake_case equivalents.
 *
 * Agents often generate YAML with camelCase keys (e.g., `baseUrl` instead of `base_url`).
 * This normalizer fixes those before Zod validation, avoiding immediate rejection.
 */

/** Static alias map: camelCase → snake_case for all known spec keys. */
const ALIAS_MAP: Record<string, string> = {
  // Shared spec
  specVersion: 'spec_version',
  timeoutMs: 'timeout_ms',
  queryParams: 'query_params',
  requestBody: 'request_body',
  baseUrl: 'base_url',
  tokenUrl: 'token_url',
  grantType: 'grant_type',
  clientId: 'client_id',
  clientSecret: 'client_secret',
  queryParam: 'query_param',
  accessKeyId: 'access_key_id',
  secretAccessKey: 'secret_access_key',
  sessionToken: 'session_token',
  tokenRequest: 'token_request',
  tokenResponsePath: 'token_response_path',
  tokenPrefix: 'token_prefix',
  tokenTtlSeconds: 'token_ttl_seconds',

  // Integration spec
  rateLimit: 'rate_limit',
  requestsPerSecond: 'requests_per_second',
  retryOn: 'retry_on',
  maxRetries: 'max_retries',
  retryAfterHeader: 'retry_after_header',

  // Resource spec / extractor config
  cursorPath: 'cursor_path',
  cursorParam: 'cursor_param',
  offsetParam: 'offset_param',
  limitParam: 'limit_param',
  totalPath: 'total_path',
  pageParam: 'page_param',
  perPageParam: 'per_page_param',
  totalPagesPath: 'total_pages_path',
  nextUrlPath: 'next_url_path',
  primaryKey: 'primary_key',
  cursorField: 'cursor_field',
  cursorType: 'cursor_type',
  recordPath: 'record_path',
  trustTier: 'trust_tier',
  defaultOutput: 'default_output',
  integrationsDir: 'integrations_dir',
  resourcesDir: 'resources_dir',

  // MCP transport
  toolName: 'tool_name',
  cursorArgument: 'cursor_argument',
  offsetArgument: 'offset_argument',
  limitArgument: 'limit_argument',
  limitValue: 'limit_value',
  pageArgument: 'page_argument',
  perPageArgument: 'per_page_argument',
  perPageValue: 'per_page_value',
  startPage: 'start_page',

  // Scaffold
  readOnly: 'read_only',

  // Schema contract
  schemaContract: 'schema_contract',

  // Incremental config
  sinceArgument: 'since_argument',
  untilArgument: 'until_argument',
  valueFormat: 'value_format',
  lookbackSeconds: 'lookback_seconds',
  initialLookbackSeconds: 'initial_lookback_seconds',
  windowSizeSeconds: 'window_size_seconds',
  filterArgument: 'filter_argument',
  filterSource: 'filter_source',

  // Hooks
  afterResponse: 'after_response',
  beforeRequest: 'before_request',
  onError: 'on_error',
  delayMs: 'delay_ms',

  // Load strategy
  loadStrategy: 'load_strategy',
  defaultBatchFormat: 'default_batch_format',

  // For each
  forEach: 'for_each',
  recordFilters: 'record_filters',

  // Verify
  authCacheIdentity: 'auth_cache_identity',
};

export interface NormalizeResult {
  data: unknown;
  warnings: string[];
}

/**
 * Recursively walk a parsed YAML object and rename camelCase keys to snake_case
 * using the static alias map. Returns the normalized data and a list of warnings
 * for each renamed key.
 *
 * Idempotent — already-correct keys pass through unchanged.
 */
export function normalizeSpec(
  raw: unknown,
  options: { path?: string; integration?: boolean } = {}
): NormalizeResult {
  const integration =
    options.integration ??
    (typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      ['source', 'integration'].includes(String((raw as Record<string, unknown>)['type'])));
  const legacy = integration
    ? normalizeLegacyBlueprintKeys(raw, { path: options.path, kind: 'integration' })
    : { document: raw, deprecations: [] };
  const warnings: string[] = legacy.deprecations.map(formatLegacyBlueprintDeprecation);

  function walk(value: unknown, path: string): unknown {
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, `${path}[${i}]`));
    }

    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

      for (const [key, val] of Object.entries(obj)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        const alias = ALIAS_MAP[key];
        if (alias) {
          if (Object.hasOwn(obj, alias)) {
            warnings.push(
              `${path ? path + '.' : ''}${key} ignored: canonical key "${alias}" already present`
            );
          } else {
            warnings.push(`${path ? path + '.' : ''}${key} → ${alias}`);
            result[alias] = walk(val, `${path ? path + '.' : ''}${alias}`);
          }
        } else {
          result[key] = walk(val, `${path ? path + '.' : ''}${key}`);
        }
      }

      return result;
    }

    return value;
  }

  return { data: walk(legacy.document, ''), warnings };
}
