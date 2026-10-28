import {
  bufferReferences,
  InterpolationError,
  interpolatePath,
  interpolateString,
  interpolateUrl,
  interpolateValue,
  type InterpolationContext,
} from './api-request-interpolation.js';
import { resolveOperationInput } from './api-request-input.js';
import type {
  ApiRequestInputFieldDefinition,
  ApiRequestOperation,
  ApiRequestTransport,
  PlannedApiRequest,
  ResolvedApiRequestConfig,
} from './api-request-types.js';

const RESTRICTED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'authorization',
]);
const SAFE_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;

function validateResolvedHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_HEADER_NAME_RE.test(name) || RESTRICTED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Invalid or restricted HTTP header name in headers.${name}`);
    }
    if (CONTROL_CHARACTER_RE.test(name) || CONTROL_CHARACTER_RE.test(value)) {
      throw new Error(`HTTP header ${name} contains a control character`);
    }
  }
}

const OPTIONAL_HEADER_VARIABLE_RE = /\$\{\{\s*(env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * An optional header is omitted, never failed, when any `env` or `secrets`
 * variable it references is absent or empty. Only those two namespaces are
 * optional: a missing `input`, `mapped` or `integration` reference is still an
 * authoring error. Header names are literal so a declared `headers` entry can
 * override an optional one by name.
 */
function resolveOptionalHeader(
  name: string,
  template: string,
  context: InterpolationContext
): string | undefined {
  const path = `optional_headers.${name}`;
  for (const match of template.matchAll(OPTIONAL_HEADER_VARIABLE_RE)) {
    let value: string;
    try {
      value = interpolateString(match[0], context, path);
    } catch (error) {
      if (error instanceof InterpolationError) return undefined;
      throw error;
    }
    if (value === '') return undefined;
  }
  const resolved = interpolateString(template, context, path);
  return resolved === '' ? undefined : resolved;
}

function appendResolvedQueryParam(url: URL, key: string, value: string): void {
  if (value !== '') {
    url.searchParams.append(key, value);
  }
}

export function mergeApiRequest<TAuth>(
  transport: ApiRequestTransport<TAuth>,
  operation: ApiRequestOperation<TAuth>
): ResolvedApiRequestConfig<TAuth> {
  return {
    base_url: transport.base_url,
    endpoint: operation.endpoint,
    method: operation.method,
    ...(operation.response_format ? { response_format: operation.response_format } : {}),
    timeout_ms: operation.timeout_ms ?? transport.timeout_ms ?? 30_000,
    headers: {
      ...(transport.headers ?? {}),
      ...(operation.headers ?? {}),
    },
    ...(transport.optional_headers ? { optional_headers: { ...transport.optional_headers } } : {}),
    query_params: {
      ...(operation.query_params ?? {}),
    },
    request_body: operation.request_body,
    auth: operation.auth ?? transport.auth ?? ({ type: 'none' } as TAuth),
    retry: transport.retry,
    rate_limit: transport.rate_limit,
  };
}

export interface BuildApiRequestParams<TAuth> {
  api: ResolvedApiRequestConfig<TAuth>;
  inputSchema: Record<string, ApiRequestInputFieldDefinition>;
  providedInput?: Record<string, unknown>;
  context?: Omit<InterpolationContext, 'input'>;
  /** Keep normal extractor compatibility for optional query inputs. */
  skipMissingInputQueryParams?: boolean;
  /** Probe callers reject unknown keys inside declared object inputs. */
  rejectUnknownNestedProperties?: boolean;
  /** Normal extraction coerces CLI strings; probes validate already-typed values. */
  inputMode?: 'coerce' | 'strict';
}

export function appendQueryParams(
  urlString: string,
  queryParams: Record<string, string>,
  context: InterpolationContext,
  options: { skipMissingInputParams?: boolean } = {}
): string {
  const planned = planQueryParams(urlString, queryParams, context, options);
  for (const commit of planned.references.values()) commit();
  return planned.url;
}

/**
 * Append query parameters, holding each sent parameter's references by name so
 * the caller can drop those a later step replaces.
 */
function planQueryParams(
  urlString: string,
  queryParams: Record<string, string>,
  context: InterpolationContext,
  options: { skipMissingInputParams?: boolean }
): { url: string; references: Map<string, () => void> } {
  const url = new URL(urlString);
  const sent = new Map<string, () => void>();

  for (const [key, template] of Object.entries(queryParams)) {
    const observer = context.onReference;
    const references = bufferReferences(
      observer
        ? { ...context, onReference: (reference) => observer({ ...reference, parameter: key }) }
        : context
    );
    let value: string;
    try {
      value = interpolateString(template, references.context, `query_params.${key}`);
    } catch (error) {
      if (
        options.skipMissingInputParams !== false &&
        error instanceof InterpolationError &&
        error.source === 'input'
      ) {
        continue;
      }
      throw error;
    }
    if (value !== '') sent.set(key, references.commit);
    appendResolvedQueryParam(url, key, value);
  }

  return { url: url.toString(), references: sent };
}

/**
 * Plan the request sent for an API operation. This is the shared pure
 * construction path used by both normal extraction and the catalog probe.
 * Network policy (DNS, private-address checks, retries, and redirects) stays
 * outside this function so an injected host can enforce its own policy.
 */
/**
 * Interpolate an endpoint. An absolute endpoint reports its origin, path and
 * query references separately; a relative endpoint is appended to the base
 * URL's pathname, so any `?` or `#` in it stays part of the path.
 */
function interpolateEndpoint(template: string, context: InterpolationContext): string {
  return template.startsWith('https://') || template.startsWith('http://')
    ? interpolateUrl(template, context, 'api.endpoint', interpolatePath)
    : interpolatePath(template, context, 'api.endpoint');
}

/**
 * The header an `api-key` auth sets when the request is sent, replacing a
 * declared header of exactly that name as `applyStaticApiRequestAuth` does.
 * Every other scheme writes `Authorization`, which a declared header cannot use.
 */
/**
 * The query parameter an `api-key` auth sets when the request is sent, replacing
 * every parameter of that name as `URLSearchParams.set` does.
 */
function authOverriddenQueryParameter(auth: unknown): string | undefined {
  if (auth === null || typeof auth !== 'object') return undefined;
  const { type, query_param: parameter } = auth as { type?: unknown; query_param?: unknown };
  return type === 'api-key' && typeof parameter === 'string' ? parameter : undefined;
}

function authOverriddenHeaders(auth: unknown): string[] {
  if (auth === null || typeof auth !== 'object') return [];
  const { type, header } = auth as { type?: unknown; header?: unknown };
  return type === 'api-key' && typeof header === 'string' ? [header] : [];
}

export function buildApiRequest<TAuth>(
  params: BuildApiRequestParams<TAuth>
): PlannedApiRequest<TAuth> {
  const resolvedInput = resolveOperationInput({
    schema: params.inputSchema,
    provided: params.providedInput,
    rejectUnknownNestedProperties: params.rejectUnknownNestedProperties,
    inputMode: params.inputMode,
  });

  const context: InterpolationContext = {
    ...params.context,
    input: resolvedInput,
  };

  const baseUrlReferences = bufferReferences(context);
  const resolvedBaseUrl = interpolateUrl(
    params.api.base_url,
    baseUrlReferences.context,
    'api.base_url',
    interpolateString
  );
  const headers: Record<string, string> = {};
  const headerReferences = new Map<string, () => void>();
  for (const [key, value] of Object.entries(params.api.optional_headers ?? {})) {
    const references = bufferReferences(context);
    const resolved = resolveOptionalHeader(key, value, references.context);
    if (resolved === undefined) continue;
    headers[key] = resolved;
    headerReferences.set(key, references.commit);
  }
  for (const [key, value] of Object.entries(params.api.headers)) {
    const references = bufferReferences(context);
    const resolvedKey = interpolateString(key, references.context, `headers.${key}`);
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() !== resolvedKey.toLowerCase()) continue;
      delete headers[existing];
      headerReferences.delete(existing);
    }
    headers[resolvedKey] = interpolateString(value, references.context, `headers.${key}`);
    headerReferences.set(resolvedKey, references.commit);
  }

  let body: unknown;
  if (params.api.request_body !== undefined) {
    const omitMissingInputNames = new Set(
      Object.entries(params.inputSchema)
        .filter(
          ([name, field]) =>
            field.required !== true &&
            field.default === undefined &&
            !Object.hasOwn(resolvedInput, name)
        )
        .map(([name]) => name)
    );
    body = interpolateValue(params.api.request_body, context, 'request_body', {
      omitMissingInputNames,
    });
    const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
    if (!hasContentType) {
      headers['Content-Type'] = 'application/json';
    }
  }
  validateResolvedHeaders(headers);

  const endpointReferences = bufferReferences(context);
  const endpoint = interpolateEndpoint(params.api.endpoint, endpointReferences.context);
  let resolvedEndpoint: string;
  const isAbsoluteUrl = endpoint.startsWith('https://') || endpoint.startsWith('http://');
  if (isAbsoluteUrl) {
    resolvedEndpoint = endpoint;
  } else {
    const base = new URL(resolvedBaseUrl);
    if (!endpoint.startsWith('/')) {
      throw new Error('API endpoint must be an absolute URL or a relative path starting with /');
    }
    const basePath = base.pathname.replace(/\/$/, '');
    base.pathname = basePath + endpoint;
    resolvedEndpoint = base.toString();
  }

  const endpointUrl = new URL(resolvedEndpoint);
  const baseUrl = new URL(resolvedBaseUrl);
  if (endpointUrl.origin !== baseUrl.origin) {
    throw new Error(
      `Operation endpoint origin "${endpointUrl.origin}" does not match integration origin "${baseUrl.origin}"`
    );
  }

  const query = planQueryParams(resolvedEndpoint, params.api.query_params, context, {
    skipMissingInputParams: params.skipMissingInputQueryParams,
  });
  const url = query.url;

  const auth = interpolateValue(params.api.auth, context, 'auth') as TAuth;
  const authQueryParameter = authOverriddenQueryParameter(auth);
  const sent = (reference: { parameter?: string }) =>
    authQueryParameter === undefined || reference.parameter !== authQueryParameter;
  if (!isAbsoluteUrl) baseUrlReferences.commit(sent);
  endpointReferences.commit(sent);
  for (const [key, commit] of query.references) {
    if (key !== authQueryParameter) commit();
  }
  for (const header of authOverriddenHeaders(auth)) headerReferences.delete(header);
  for (const commit of headerReferences.values()) commit();
  return {
    url,
    method: params.api.method,
    ...(params.api.response_format ? { response_format: params.api.response_format } : {}),
    headers,
    body,
    timeout_ms: params.api.timeout_ms,
    auth,
    interpolationContext: context,
    input: resolvedInput,
  };
}

export { resolveOperationInput } from './api-request-input.js';
