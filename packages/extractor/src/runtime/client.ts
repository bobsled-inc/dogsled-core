import {
  applyHttpAuth,
  buildOperationRequest,
  invalidateRejectedRuntimeAuth,
  interpolateString,
  mergeIntegrationOperation,
} from '../framework/runtime/index.js';
import {
  attachProviderResponseBody,
  readResponseTextWithLimit,
  RESPONSE_BODY_LIMITS,
  isPrivateHost,
  isSameOrigin,
  sanitizeUrlForError,
  resolveAndValidateHost,
} from '../framework/core/index.js';

import { RateLimiter, type RequestRetryEvent } from './rate-limiter.js';
import {
  ExtractorDataError,
  toExtractorAuthRuntimeError,
  toExtractorHttpRuntimeError,
  toExtractorRuntimeError,
} from './errors.js';
import { resolveRetryBackoffPolicy, type RetryBackoffPolicy } from './retry-delay.js';

import type { HttpTransportConfig } from '../framework/core/index.js';
import type {
  CustomTokenStore,
  InterpolationContext,
  ResolvedApiConfig,
} from '../framework/runtime/index.js';
import type { ApiIntegrationSpec, HttpApiResourceSpec } from '../types/index.js';

type OperationSpecLike = Pick<HttpApiResourceSpec, 'api' | 'input'>;
type HttpApiIntegrationSpec = ApiIntegrationSpec & { transport: HttpTransportConfig };
type RequestParameterValue = string | number | boolean;
export type HttpRequestParameterDestination = 'path' | 'header' | 'query' | 'body';

interface RoutedRequestParameters {
  api: ResolvedApiConfig;
  input: Record<string, unknown>;
  queryParams: Record<string, RequestParameterValue>;
}

export interface ClientOptions {
  integration: ApiIntegrationSpec;
  cliInputs?: Record<string, unknown>;
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Reserved names trusted for this run, in addition to host-declared secrets. */
  trustedCredentialNames?: readonly string[];
  stateDir?: string;
  /** @internal Shared by bounded graph execution to preserve integration-wide rate limits. */
  rateLimiter?: RateLimiter;
  /** @internal Counts authentication-provider requests as aggregate attempts. */
  beforeRequestAttempt?: () => void;
  /** @internal Registers resolved authentication values for safe error redaction. */
  onResolvedSecret?: (value: string) => void;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
}

export interface RequestOptions {
  operation: OperationSpecLike;
  input?: Record<string, unknown>;
  context?: Omit<InterpolationContext, 'input'>;
  /**
   * Request parameter overrides used by pagination and server-side filters.
   * Values are routed according to the operation definition before the
   * request is built: declared input templates are resolved first, explicit
   * query parameters stay in the URL, and the legacy POST/body and dotted
   * body fallbacks are retained for cursor definitions that do not declare an
   * input field (for example Notion's start_cursor).
   */
  queryParams?: Record<string, RequestParameterValue>;
  url?: string;
  headers?: Record<string, string>;
  allowStatus?: number[];
  signal?: AbortSignal;
  /** Called immediately before each HTTP attempt, including retries and redirects. */
  beforeRequestAttempt?: () => void;
  /** Called before each wait between attempts of a read that failed in a way the client retries. */
  onRetry?: (event: RequestRetryEvent) => void | Promise<void>;
  /**
   * Whether the request only reads. Defaults to true. A read gets its own
   * timeout for every attempt and is retried after a timeout, a dropped
   * connection, a failed body read and HTTP 429, 502, 503 and 504. A request
   * that changes data sets false and keeps the earlier retry behavior: one
   * deadline for all attempts, HTTP 429 and 503 (or the configured `retry_on`)
   * and errors before a response, and no retry of the body read.
   */
  idempotent?: boolean;
  /** Optional per-call cap for a successful response body. */
  responseBodyLimitBytes?: number;
  /** @internal Captures declared operation inputs after request routing and defaults. */
  onResolvedInput?: (input: Readonly<Record<string, unknown>>) => void;
}

export interface ClientResponse {
  data: unknown;
  headers: Headers;
  status: number;
}

interface FetchOptions {
  signal?: AbortSignal;
  beforeRequestAttempt?: () => void;
  onRetry?: RequestOptions['onRetry'];
  idempotent?: boolean;
  responseBodyLimitBytes?: number;
}

interface FetchedResponse {
  response: Response;
  /** The body of a successful read, read inside the retried attempt. A write reads its own. */
  responseText?: string;
}

export class ExtractorClient {
  private readonly integration: HttpApiIntegrationSpec;
  private readonly cliInputs: Record<string, unknown>;
  private readonly secrets: Record<string, string | undefined>;
  private readonly declaredSecretNames: readonly string[];
  private readonly trustedCredentialNames: ReadonlySet<string>;
  private readonly env: Record<string, string | undefined>;
  private readonly stateDir?: string;
  private readonly rateLimiter: RateLimiter;
  private readonly beforeRequestAttempt?: () => void;
  private readonly onResolvedSecret?: (value: string) => void;
  private readonly customTokenStore?: CustomTokenStore;
  private readonly tokenRetry: RetryBackoffPolicy;

  constructor(options: ClientOptions) {
    if (
      options.integration.transport.type === 'mcp_http' ||
      options.integration.transport.type === 'mcp_stdio'
    ) {
      throw new Error(
        `Integration "${options.integration.name}" uses MCP transport. Use McpExtractorClient instead.`
      );
    }

    this.integration = options.integration as HttpApiIntegrationSpec;
    this.cliInputs = options.cliInputs ?? {};
    this.secrets = options.secrets ?? process.env;
    this.declaredSecretNames =
      options.secrets === undefined ? [] : (options.declaredSecretNames ?? []);
    this.trustedCredentialNames = new Set([
      ...(options.trustedCredentialNames ?? []),
      ...this.declaredSecretNames,
    ]);
    this.env = options.env ?? process.env;
    this.stateDir = options.stateDir;
    this.beforeRequestAttempt = options.beforeRequestAttempt;
    this.onResolvedSecret = options.onResolvedSecret;
    this.customTokenStore = options.customTokenStore;
    this.tokenRetry = resolveRetryBackoffPolicy(this.integration.transport.retry);

    const rl = this.integration.transport.rate_limit;
    const rt = this.integration.transport.retry;
    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter({
        ...(rl?.requests_per_second !== undefined && { requestsPerSecond: rl.requests_per_second }),
        ...(rl?.burst !== undefined && { burst: rl.burst }),
        ...(rt?.retry_on !== undefined && { retryOn: rt.retry_on }),
        ...(rt?.max_retries !== undefined && { maxRetries: rt.max_retries }),
        ...(rt?.backoff !== undefined && { backoff: rt.backoff }),
        ...(rt?.retry_after_header !== undefined && { retryAfterHeader: rt.retry_after_header }),
      });
  }

  /** No-op for HTTP client (kept for interface parity with McpExtractorClient). */
  async connect(): Promise<void> {}

  /** No-op for HTTP client (kept for interface parity with McpExtractorClient). */
  async close(): Promise<void> {}

  getBaseUrl(): string {
    return interpolateString(
      this.integration.transport.base_url,
      {
        env: this.env,
        declaredEnvVars: new Set(this.integration.auth_env_vars),
        secrets: this.secrets,
        declaredSecretNames: this.declaredSecretNames,
        trustedCredentialNames: this.trustedCredentialNames,
      },
      'transport.base_url'
    );
  }

  async request(options: RequestOptions): Promise<ClientResponse> {
    try {
      return await this.requestUnchecked(options);
    } catch (error) {
      throw toExtractorHttpRuntimeError(error, options.signal);
    }
  }

  private async requestUnchecked(options: RequestOptions): Promise<ClientResponse> {
    let resolvedBaseUrl: string;
    let request: Awaited<ReturnType<typeof buildOperationRequest>>;
    let routedQueryParams: Record<string, RequestParameterValue> = {};
    try {
      const mergedApi = mergeIntegrationOperation(this.integration, options.operation.api);
      resolvedBaseUrl = this.getBaseUrl();
      const api = options.url
        ? {
            ...mergedApi,
            endpoint: this.validateOverrideUrl(options.url, resolvedBaseUrl),
            query_params: {},
          }
        : mergedApi;
      const inputSchema = options.operation.input;
      const filteredCliInputs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(this.cliInputs)) {
        if (inputSchema && Object.hasOwn(inputSchema, key)) filteredCliInputs[key] = value;
      }
      const routed = routeHttpRequestParameters(
        api,
        inputSchema,
        { ...filteredCliInputs, ...(options.input ?? {}) },
        options.queryParams
      );
      routedQueryParams = routed.queryParams;
      request = await buildOperationRequest({
        api: routed.api,
        inputSchema,
        providedInput: routed.input,
        context: {
          ...(options.context ?? {}),
          secrets: this.secrets,
          declaredSecretNames: this.declaredSecretNames,
          env: this.env,
          declaredEnvVars: new Set(this.integration.auth_env_vars),
          trustedCredentialNames: this.trustedCredentialNames,
          integration: { base_url: resolvedBaseUrl },
        },
      });
      options.onResolvedInput?.(request.input);
    } catch (error) {
      throw toExtractorRuntimeError({
        kind: 'validation',
        code: 'EXTRACTOR_HTTP_VALIDATION_FAILURE',
        operation: 'extractor.http.request',
        retryable: false,
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    const url =
      Object.keys(routedQueryParams).length > 0
        ? this.appendRawQueryParams(request.url, routedQueryParams)
        : request.url;

    const baseRequest = {
      ...request,
      url,
      headers: {
        ...request.headers,
        ...sanitizeHeaderValues(options.headers),
      },
      integrationName: this.integration.name,
      stateDir: this.stateDir,
      signal: options.signal,
      ...(this.customTokenStore ? { customTokenStore: this.customTokenStore } : {}),
      tokenRetry: this.tokenRetry,
    };

    options.signal?.throwIfAborted();
    let authedRequest: Awaited<ReturnType<typeof applyHttpAuth>>;
    try {
      authedRequest = await applyHttpAuth({
        ...baseRequest,
        beforeRequestAttempt: this.beforeRequestAttempt,
      });
      for (const value of authedRequest.resolvedSecrets ?? []) this.onResolvedSecret?.(value);
      for (const value of Object.values(authedRequest.headers)) this.onResolvedSecret?.(value);
    } catch (error) {
      throw toExtractorAuthRuntimeError(error, options.signal);
    }
    options.signal?.throwIfAborted();
    const fetchOptions: FetchOptions = {
      signal: options.signal,
      beforeRequestAttempt: options.beforeRequestAttempt,
      onRetry: options.onRetry,
      idempotent: options.idempotent,
      responseBodyLimitBytes: options.responseBodyLimitBytes,
    };
    let fetched = await this.doFetch(authedRequest, resolvedBaseUrl, fetchOptions);

    if (
      fetched.response.status === 401 &&
      authedRequest.auth &&
      authedRequest.auth.type !== 'none'
    ) {
      await fetched.response.body?.cancel().catch(() => undefined);
      try {
        await invalidateRejectedRuntimeAuth(authedRequest.authCacheIdentity, this.customTokenStore);
        authedRequest = await applyHttpAuth({
          ...baseRequest,
          beforeRequestAttempt: this.beforeRequestAttempt,
        });
        for (const value of authedRequest.resolvedSecrets ?? []) this.onResolvedSecret?.(value);
        for (const value of Object.values(authedRequest.headers)) this.onResolvedSecret?.(value);
      } catch (error) {
        throw toExtractorAuthRuntimeError(error, options.signal);
      }
      options.signal?.throwIfAborted();
      fetched = await this.doFetch(authedRequest, resolvedBaseUrl, fetchOptions);
    }
    const { response } = fetched;

    if (!response.ok && !options.allowStatus?.includes(response.status)) {
      const { detail, body } = await readErrorResponseBody(
        response,
        collectRequestSecrets(authedRequest.url, authedRequest.headers)
      );
      const error = Object.assign(
        new Error(
          `API request failed: ${response.status} ${response.statusText} - ${sanitizeUrlForError(authedRequest.url)}${
            detail ? ` :: ${detail}` : ''
          }`
        ),
        { status: response.status }
      );
      throw attachProviderResponseBody(error, body);
    }

    if (!response.ok && options.allowStatus?.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        data: undefined,
        headers: response.headers,
        status: response.status,
      };
    }

    const rawBody =
      fetched.responseText ?? (await readResponseBody(response, options.responseBodyLimitBytes));
    let data: unknown = null;
    if (authedRequest.response_format === 'jsonl') {
      data = parseJsonLines(rawBody, response.status, authedRequest.url);
    } else if (rawBody.trim() !== '') {
      try {
        data = JSON.parse(rawBody) as unknown;
      } catch (error) {
        throw new ExtractorDataError(
          `Failed to parse JSON response (status ${response.status}) from ${sanitizeUrlForError(authedRequest.url)}`,
          error instanceof Error ? error : undefined
        );
      }
    }

    return {
      data,
      headers: response.headers,
      status: response.status,
    };
  }

  private static readonly MAX_REDIRECTS = 5;

  /**
   * Send the request, following same-origin redirects. A read gets the body of
   * a successful response inside the retried attempt, so a timeout or a dropped
   * connection while reading it retries this one request. A write returns the
   * response and reads its body after, as it always has.
   */
  private async doFetch(
    authedRequest: Awaited<ReturnType<typeof applyHttpAuth>>,
    resolvedBaseUrl: string,
    fetchOptions: FetchOptions
  ): Promise<FetchedResponse> {
    let currentUrl = authedRequest.url;
    let method = authedRequest.method;
    let body: string | undefined =
      authedRequest.body === undefined ? undefined : JSON.stringify(authedRequest.body);

    for (let redirectCount = 0; redirectCount <= ExtractorClient.MAX_REDIRECTS; redirectCount++) {
      let responseText: string | undefined;
      const response = await this.rateLimiter.fetchWithRetry(
        currentUrl,
        {
          method,
          headers: authedRequest.headers,
          body,
          redirect: 'manual',
          signal: fetchOptions.signal,
        },
        authedRequest.timeout_ms,
        fetchOptions.beforeRequestAttempt,
        async (retryableResponse) =>
          await readErrorResponseBody(
            retryableResponse,
            collectRequestSecrets(currentUrl, authedRequest.headers)
          ),
        {
          idempotent: fetchOptions.idempotent,
          onRetry: fetchOptions.onRetry,
          ...(fetchOptions.idempotent === false
            ? {}
            : {
                readBody: async (received: Response) => {
                  if (!received.ok) return;
                  responseText = await readResponseBody(
                    received,
                    fetchOptions.responseBodyLimitBytes
                  );
                },
              }),
        }
      );

      if (response.status < 300 || response.status >= 400) {
        return { response, responseText };
      }

      await response.body?.cancel().catch(() => undefined);

      const location = response.headers.get('location');
      if (!location) {
        return { response };
      }

      const redirectUrl = new URL(location, currentUrl).toString();
      if (!isSameOrigin(redirectUrl, resolvedBaseUrl)) {
        throw new Error(
          `Redirect to "${new URL(redirectUrl).origin}" blocked: cross-origin redirect from "${new URL(resolvedBaseUrl).origin}"`
        );
      }
      const redirectHostname = new URL(redirectUrl).hostname;
      if (isPrivateHost(redirectHostname)) {
        throw new Error(`Redirect to "${redirectUrl}" blocked: private/internal host`);
      }
      await resolveAndValidateHost(redirectHostname, 'Redirect URL');

      currentUrl = redirectUrl;

      // Per RFC 9110: 301/302/303 convert to GET, drop body, and strip auth headers
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        method = 'GET';
        body = undefined;
        const { Authorization: _, ...rest } = authedRequest.headers;
        authedRequest = { ...authedRequest, headers: rest };
      }
    }

    throw new Error(`Too many redirects (>${ExtractorClient.MAX_REDIRECTS})`);
  }

  private validateOverrideUrl(url: string, baseUrl: string): string {
    if (!isSameOrigin(url, baseUrl)) {
      throw new Error(
        `Request URL origin "${new URL(url).origin}" does not match integration origin "${new URL(baseUrl).origin}"`
      );
    }
    return url;
  }

  private appendRawQueryParams(
    url: string,
    queryParams: Record<string, string | number | boolean>
  ): string {
    const nextUrl = new URL(url);
    for (const [key, value] of Object.entries(queryParams)) {
      nextUrl.searchParams.set(key, String(value));
    }
    return nextUrl.toString();
  }
}

const INPUT_REFERENCE_RE = /\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;
const BLOCKED_REQUEST_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve pagination and server-filter values against the same operation
 * metadata used for the initial request. This is intentionally kept at the
 * HTTP client boundary so extraction and query-time execution cannot drift in
 * how they route a cursor.
 *
 * A value that corresponds to a declared input is first merged into that
 * input. This lets the operation's own body/query/path/header interpolation
 * decide where the value belongs. Values that are not declared inputs retain
 * the compatibility fallbacks used by extraction: explicit query definitions
 * and matching headers win, POST/body and dotted body values are written into
 * the JSON body, and the remaining values are URL query parameters.
 */
export function routeHttpRequestParameters(
  api: ResolvedApiConfig,
  inputSchema: OperationSpecLike['input'],
  providedInput: Record<string, unknown>,
  queryParams: Record<string, RequestParameterValue> | undefined
): RoutedRequestParameters {
  const input = { ...providedInput };
  const urlQueryParams: Record<string, RequestParameterValue> = {};
  const bodyOverrides: Record<string, RequestParameterValue> = {};
  const headerOverrides: Record<string, string> = {};

  for (const [key, value] of Object.entries(queryParams ?? {})) {
    const inputName = Object.hasOwn(inputSchema, key) ? key : undefined;
    const destination = resolveHttpRequestParameterDestination(api, inputSchema, key);
    const hasInputReference = inputName !== undefined && requestDefinitionReferencesInput(api, key);

    if (inputName && hasInputReference) {
      input[inputName] = value;
      continue;
    }

    if (destination === 'query') {
      urlQueryParams[key] = value;
      continue;
    }

    if (destination === 'header') {
      const headerName = Object.keys(api.headers).find(
        (name) => name.toLowerCase() === key.toLowerCase()
      );
      if (!headerName) {
        urlQueryParams[key] = value;
        continue;
      }
      headerOverrides[headerName] = String(value);
      continue;
    }

    if (destination === 'body') {
      bodyOverrides[key] = value;
      continue;
    }

    urlQueryParams[key] = value;
  }

  let routedApi = api;
  if (Object.keys(bodyOverrides).length > 0 && isRequestObject(api.request_body)) {
    const requestBody = structuredClone(api.request_body) as Record<string, unknown>;
    for (const [path, value] of Object.entries(bodyOverrides)) {
      if (setNestedRequestValue(requestBody, path, value)) {
        continue;
      }
      // A blocked path must never be assigned to an object. Keep the value in
      // the URL rather than risking prototype mutation.
      urlQueryParams[path] = value;
    }
    routedApi = { ...api, request_body: requestBody };
  } else if (Object.keys(bodyOverrides).length > 0) {
    for (const [path, value] of Object.entries(bodyOverrides)) urlQueryParams[path] = value;
  }

  if (Object.keys(headerOverrides).length > 0) {
    routedApi = {
      ...routedApi,
      headers: { ...routedApi.headers, ...headerOverrides },
    };
  }

  return { api: routedApi, input, queryParams: urlQueryParams };
}

/** Canonical destination decision shared by runtime execution and mock verification. */
export function resolveHttpRequestParameterDestination(
  api: NonNullable<HttpApiResourceSpec['api']>,
  inputSchema: HttpApiResourceSpec['input'],
  parameterName: string
): HttpRequestParameterDestination {
  if (Object.hasOwn(inputSchema, parameterName)) {
    if (containsInputReference(api.endpoint, parameterName)) return 'path';
    if (containsInputReference(api.headers, parameterName)) return 'header';
    if (containsInputReference(api.query_params, parameterName)) return 'query';
    if (containsInputReference(api.request_body, parameterName)) return 'body';
  }
  if (Object.hasOwn(api.query_params ?? {}, parameterName)) return 'query';
  if (
    Object.keys(api.headers ?? {}).some(
      (name) => name.toLowerCase() === parameterName.toLowerCase()
    )
  ) {
    return 'header';
  }
  if (
    api.request_body !== undefined &&
    (api.method.toUpperCase() === 'POST' ||
      parameterName.includes('.') ||
      hasRequestBodyPath(api.request_body, parameterName))
  ) {
    return 'body';
  }
  return 'query';
}

function requestDefinitionReferencesInput(api: ResolvedApiConfig, inputName: string): boolean {
  return [api.endpoint, api.headers, api.query_params, api.request_body, api.auth].some((value) =>
    containsInputReference(value, inputName)
  );
}

function containsInputReference(value: unknown, inputName: string): boolean {
  if (typeof value === 'string') {
    const references = value.match(new RegExp(INPUT_REFERENCE_RE.source, 'g')) ?? [];
    return references.some((reference) => INPUT_REFERENCE_RE.exec(reference)?.[1] === inputName);
  }
  if (Array.isArray(value)) return value.some((entry) => containsInputReference(entry, inputName));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) =>
        containsInputReference(key, inputName) || containsInputReference(entry, inputName)
    );
  }
  return false;
}

function isRequestObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRequestBodyPath(body: unknown, dotPath: string): boolean {
  if (!isRequestObject(body)) return false;
  const keys = dotPath.split('.');
  let current: unknown = body;
  for (const key of keys) {
    if (BLOCKED_REQUEST_PATH_KEYS.has(key) || !isRequestObject(current)) return false;
    if (!Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function setNestedRequestValue(
  object: Record<string, unknown>,
  dotPath: string,
  value: unknown
): boolean {
  const keys = dotPath.split('.');
  if (keys.some((key) => key.length === 0 || BLOCKED_REQUEST_PATH_KEYS.has(key))) return false;
  let current = object;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index]!;
    const existing = current[key];
    if (!isRequestObject(existing)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
  return true;
}

function parseJsonLines(rawBody: string, status: number, url: string): unknown[] {
  const records: unknown[] = [];
  const lines = rawBody.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '') continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new ExtractorDataError(
        `Failed to parse JSONL response at line ${index + 1} (status ${status}) from ${sanitizeUrlForError(url)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
  return records;
}

/**
 * Read a successful response body under the per-request limit. A limit that is
 * not a size from 1 byte to the API cap cancels the body and fails the request.
 */
async function readResponseBody(
  response: Response,
  requestedLimit: number | undefined
): Promise<string> {
  const limit = requestedLimit ?? RESPONSE_BODY_LIMITS.api;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > RESPONSE_BODY_LIMITS.api) {
    await response.body?.cancel().catch(() => undefined);
    throw new ExtractorDataError(
      `API response body limit must be between 1 and ${RESPONSE_BODY_LIMITS.api} bytes.`
    );
  }
  return await readResponseTextWithLimit(response, limit, 'API response');
}

const MAX_ERROR_BODY_CHARS = 500;

/**
 * Best-effort read of an error response body so the thrown error carries the
 * API's actual failure detail (e.g. `{"message":"Invalid API Key"}`) instead
 * of a bare `<status> <statusText>` line. `detail` collapses whitespace and is
 * truncated to keep log lines tight; `body` keeps the bounded redacted text for
 * callers that extract structured fields. Reading is wrapped so a body-read
 * failure can never mask the underlying status error.
 * A hostile or misconfigured server can reflect request headers and query
 * parameters into its response, so known outbound values are removed before
 * the body is included in an error.
 */
async function readErrorResponseBody(
  response: Response,
  requestSecrets: readonly string[]
): Promise<{ detail: string; body: string }> {
  try {
    const text = await readResponseTextWithLimit(
      response,
      RESPONSE_BODY_LIMITS.error,
      'API error response'
    );
    let redacted = text;
    for (const secret of [...requestSecrets].sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    const condensed = redacted.replace(/\s+/g, ' ').trim();
    const detail =
      condensed.length > MAX_ERROR_BODY_CHARS
        ? `${condensed.slice(0, MAX_ERROR_BODY_CHARS)}…`
        : condensed;
    return { detail, body: redacted };
  } catch {
    return { detail: '', body: '' };
  }
}

function collectRequestSecrets(url: string, headers: Record<string, string>): string[] {
  const candidates = new Set<string>();

  for (const value of Object.values(headers)) {
    if (value.length >= 4) {
      candidates.add(value);
    }
    const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    if (credential && credential.length >= 4) {
      candidates.add(credential);
    }
  }

  try {
    for (const value of new URL(url).searchParams.values()) {
      if (value.length >= 4) {
        candidates.add(value);
      }
    }
  } catch {
    // The request URL has already passed URL parsing before this point. Keep
    // error handling fail-safe if a test double supplies a malformed value.
  }

  return [...candidates];
}

function sanitizeHeaderValues(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = value.replace(/[\r\n]+/g, ' ').trim();
  }
  return sanitized;
}
