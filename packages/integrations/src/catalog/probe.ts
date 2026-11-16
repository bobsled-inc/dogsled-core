import { z } from 'zod';

import {
  buildApiRequest,
  type ApiRequestInputFieldDefinition,
  type ApiRequestOperation,
  type ApiRequestTransport,
  mergeApiRequest,
} from '@bobsled-inc/api-resource';

import { buildCatalogManifest } from './manifest.js';
import {
  applyProbeAuthentication,
  ProbeAuthFailure,
  type ProbeAuthenticationRequest,
} from './probe-auth.js';
import type {
  CatalogProbeApi,
  CatalogProbeAuth,
  CatalogProbeDefinition,
  CatalogProbeFieldType,
  CatalogProbeHttpMethod,
  CatalogProbeInputField,
  CatalogProbeJsonValue,
  CatalogProbeResource,
  CatalogProbeRequestPhase,
  CatalogProbeSource,
  CatalogProbeTransport,
  ProbeApiResourceExecutorRequest,
} from './probe-types.js';
import type {
  CatalogManifest,
  CatalogResource,
  CatalogResourceTransportVariant,
  CatalogSource,
  CatalogTransportConfig,
} from './types.js';
import { buildProbeRedactionPlan, readBoundedProbeResponse } from './probe-redaction.js';

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;
const SAFE_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const RESTRICTED_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'authorization',
]);

const JsonValueSchema: z.ZodType<CatalogProbeJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const SafeHeaderNameSchema = z
  .string()
  .regex(SAFE_HEADER_NAME_RE, 'Must be a valid HTTP header name')
  .refine(
    (value) => !RESTRICTED_HEADER_NAMES.has(value.toLowerCase()),
    'Cannot override a restricted HTTP header'
  );

const SafeHeaderValueSchema = z
  .string()
  .refine((value) => !CONTROL_CHARACTER_RE.test(value), 'Header values must not contain controls');

const SafeHeadersSchema = z.record(SafeHeaderNameSchema, SafeHeaderValueSchema);

const KnownTemplateSchema =
  /\$\{\{\s*(?:input|mapped|secrets|env|integration)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g;

function isHttpsTemplate(value: string): boolean {
  try {
    const resolved = value.replace(KnownTemplateSchema, 'placeholder');
    const url = new URL(resolved);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

const AbsoluteHttpsTemplateSchema = z
  .string()
  .refine(isHttpsTemplate, 'Must be an absolute HTTPS URL or HTTPS URL template');

const EndpointSchema = z
  .string()
  .refine(
    (value) => value.startsWith('/') || isHttpsTemplate(value),
    'Must be an integration-relative path or absolute HTTPS URL'
  );

const InputFieldSchema: z.ZodType<CatalogProbeInputField> = z.lazy(() =>
  z
    .object({
      type: z.enum(['string', 'number', 'integer', 'boolean', 'timestamp', 'array', 'object']),
      required: z.boolean().optional(),
      description: z.string().optional(),
      default: JsonValueSchema.optional(),
      enum: z.array(z.string()).optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      items: InputFieldSchema.optional(),
      properties: z.record(z.string(), InputFieldSchema).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.type !== 'array' && value.items !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['items'], message: 'Only arrays can declare items' });
      }
      if (value.type !== 'object' && value.properties !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['properties'],
          message: 'Only objects can declare properties',
        });
      }
    })
);

const AuthTokenString = z.string();
const AuthHeaderNameSchema = z
  .string()
  .regex(SAFE_HEADER_NAME_RE, 'Must be a valid HTTP header name')
  .refine(
    (value) =>
      !new Set(['host', 'content-length', 'transfer-encoding', 'connection']).has(
        value.toLowerCase()
      ),
    'Cannot override a restricted HTTP header'
  );

const AuthSchema: z.ZodType<CatalogProbeAuth> = z.union([
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), token: AuthTokenString }).strict(),
  z
    .object({
      type: z.literal('api-key'),
      header: AuthHeaderNameSchema.optional(),
      query_param: z.string().min(1).optional(),
      key: AuthTokenString,
    })
    .strict(),
  z
    .object({ type: z.literal('basic'), username: AuthTokenString, password: AuthTokenString })
    .strict(),
  z
    .object({
      type: z.literal('oauth2'),
      grant_type: z.literal('client_credentials'),
      token_url: AbsoluteHttpsTemplateSchema,
      client_id: AuthTokenString,
      client_secret: AuthTokenString,
      scopes: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth2'),
      grant_type: z.literal('authorization_code'),
      token_url: AbsoluteHttpsTemplateSchema,
      client_id: AuthTokenString,
      client_secret: AuthTokenString,
      refresh_token: AuthTokenString,
      scopes: z.array(z.string()).optional(),
      token_prefix: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('custom-token'),
      token_url: AbsoluteHttpsTemplateSchema,
      token_request: z
        .object({
          method: z.enum(['GET', 'POST', 'PUT']).optional(),
          headers: SafeHeadersSchema.optional(),
          body: JsonValueSchema.optional(),
        })
        .strict()
        .optional(),
      token_response_path: z.string().optional(),
      token_prefix: z.string().optional(),
      token_ttl_seconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('aws-sigv4'),
      region: AuthTokenString,
      service: AuthTokenString,
      access_key_id: AuthTokenString,
      secret_access_key: AuthTokenString,
      session_token: AuthTokenString.optional(),
    })
    .strict(),
]);

const ApiSchema: z.ZodType<CatalogProbeApi> = z
  .object({
    endpoint: EndpointSchema,
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    timeout_ms: z.number().int().positive().optional(),
    headers: SafeHeadersSchema.optional(),
    query_params: z.record(z.string(), z.string()).optional(),
    request_body: JsonValueSchema.optional(),
    auth: AuthSchema.optional(),
  })
  .strict();

const TransportSchema: z.ZodType<CatalogProbeTransport> = z
  .object({
    id: z.string().min(1),
    type: z.literal('http'),
    base_url: AbsoluteHttpsTemplateSchema,
    headers: SafeHeadersSchema.optional(),
    optional_headers: SafeHeadersSchema.refine(
      (headers) =>
        Object.values(headers).every(
          (value) => !/\$\{\{\s*(?!env\.|secrets\.)[A-Za-z_]/.test(value)
        ),
      { message: 'optional_headers may reference only ${{ env.* }} and ${{ secrets.* }}' }
    ).optional(),
    auth: AuthSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const SourceSchema: z.ZodType<CatalogProbeSource> = z
  .object({
    auth_env_vars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    name: z.string().min(1),
    default_transport: z.string().min(1),
    transports: z.record(z.string().min(1), TransportSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!Object.hasOwn(value.transports, value.default_transport)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_transport'],
        message: 'Default transport must be declared',
      });
    }
    for (const [id, transport] of Object.entries(value.transports)) {
      if (transport.id !== id) {
        ctx.addIssue({
          code: 'custom',
          path: ['transports', id, 'id'],
          message: 'Transport id must match its map key',
        });
      }
    }
  });

const ResourceSchema: z.ZodType<CatalogProbeResource> = z
  .object({
    name: z.string().min(1),
    via: z.string().min(1).optional(),
    description: z.string().optional(),
    input: z.record(z.string().min(1), InputFieldSchema),
    api: ApiSchema,
  })
  .strict();

/** Canonical schema for both built-in and externally supplied probe definitions. */
export const CatalogProbeDefinitionSchema: z.ZodType<CatalogProbeDefinition> = z
  .object({
    schema_version: z.literal(1),
    source: SourceSchema,
    resource: ResourceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.resource.via && !Object.hasOwn(value.source.transports, value.resource.via)) {
      ctx.addIssue({
        code: 'custom',
        path: ['resource', 'via'],
        message: 'Resource transport must be declared by the source',
      });
    }
  });

export const ProbeResourceDefinitionSchema = CatalogProbeDefinitionSchema;

export interface ProbeApiResourceReference {
  kind: 'builtin';
  source: string;
  resource: string;
  transport?: string;
}

export interface ExternalProbeApiResourceTarget {
  kind: 'external';
  definition: unknown;
}

export type ProbeApiResourceTarget = ProbeApiResourceReference | ExternalProbeApiResourceTarget;

export type ProbeApiResourceExecutor = (
  request: ProbeApiResourceExecutorRequest
) => Promise<Response>;

export interface ProbeApiResourceOptions {
  /** Use the explicit target form, or use source/resource below. */
  target?: ProbeApiResourceTarget;
  /** A canonical external definition, or a source object paired with resource. */
  definition?: unknown;
  source?: string | CatalogProbeSource;
  resource?: string | CatalogProbeResource;
  transport?: string;
  /** Alias for transport, matching resource YAML terminology. */
  via?: string;
  input?: Readonly<Record<string, unknown>>;
  secrets?: Readonly<Record<string, string | undefined>>;
  declaredSecretNames?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  executor?: ProbeApiResourceExecutor;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface ProbeApiResourceResponse {
  status: number;
  contentType: string | null;
  responseBytes: Uint8Array;
  truncated: boolean;
}

export type ProbeApiResourceFailureCode =
  | 'resource_not_found'
  | 'invalid_definition'
  | 'invalid_input'
  | 'invalid_request'
  | 'executor_failed'
  | 'response_read_failed'
  | 'http_status';

export type ProbeApiResourceResult =
  | { ok: true; response: ProbeApiResourceResponse }
  | { ok: false; code: ProbeApiResourceFailureCode; response?: ProbeApiResourceResponse };

function failure(code: ProbeApiResourceFailureCode): ProbeApiResourceResult {
  return { ok: false, code };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectTransport(
  source: CatalogProbeSource,
  resource: CatalogProbeResource,
  requestedTransport: string | undefined
): CatalogProbeTransport | undefined {
  const transportId = requestedTransport ?? resource.via ?? source.default_transport;
  return source.transports[transportId];
}

function catalogTransportToProbe(
  config: CatalogTransportConfig
): CatalogProbeTransport | undefined {
  if (!config.base_url) return undefined;
  return {
    id: config.id,
    type: 'http',
    base_url: config.base_url,
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.optional_headers ? { optional_headers: config.optional_headers } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.timeout_ms !== undefined ? { timeout_ms: config.timeout_ms } : {}),
  };
}

function catalogSourceToProbe(source: CatalogSource): CatalogProbeSource | undefined {
  const transports: Record<string, CatalogProbeTransport> = {};
  for (const config of source.transport_configs) {
    const transport = catalogTransportToProbe(config);
    if (transport) transports[config.id] = transport;
  }

  const defaultTransport = transports[source.default_transport]
    ? source.default_transport
    : Object.keys(transports)[0];
  if (!defaultTransport) return undefined;

  return {
    name: source.name,
    auth_env_vars: [
      ...(source.auth_env_vars ?? []),
      ...source.auth_setup.map((entry) => entry.env),
    ],
    default_transport: defaultTransport,
    transports,
  };
}

function catalogVariantToProbe(
  resource: CatalogResource,
  variant: CatalogResourceTransportVariant
): CatalogProbeResource | undefined {
  if (!variant.api) return undefined;
  return {
    name: resource.name,
    via: variant.via,
    ...(resource.description ? { description: resource.description } : {}),
    input: variant.input ?? resource.input ?? {},
    api: variant.api,
  };
}

function parseDefinition(value: unknown): CatalogProbeDefinition | undefined {
  const parsed = CatalogProbeDefinitionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function externalDefinitionFromOptions(options: ProbeApiResourceOptions): unknown {
  if (options.definition !== undefined) return options.definition;
  if (isObject(options.source) && isObject(options.resource)) {
    return {
      schema_version: 1,
      source: options.source,
      resource: options.resource,
    };
  }
  return undefined;
}

function builtinDefinition(
  sourceName: string,
  resourceName: string,
  requestedTransport: string | undefined,
  manifest: CatalogManifest
): CatalogProbeDefinition | undefined {
  const source = manifest.sources.find((entry) => entry.name === sourceName);
  const sourceProbe = source ? catalogSourceToProbe(source) : undefined;
  if (!source || !sourceProbe) return undefined;

  const resource = source.resources.find((entry) => entry.name === resourceName);
  const selectedTransportId = requestedTransport ?? resource?.default_transport;
  const variant = resource?.variants.find((entry) => entry.via === selectedTransportId);
  if (!resource || !variant) return undefined;

  const resourceProbe = catalogVariantToProbe(resource, variant);
  if (!resourceProbe) return undefined;
  const selectedTransport = selectTransport(sourceProbe, resourceProbe, requestedTransport);
  if (!selectedTransport) return undefined;

  return parseDefinition({
    schema_version: 1,
    source: sourceProbe,
    resource: { ...resourceProbe, via: selectedTransport.id },
  });
}

function resolveDefinition(options: ProbeApiResourceOptions): {
  definition?: CatalogProbeDefinition;
  failure?: ProbeApiResourceFailureCode;
} {
  const requestedTransport = options.transport ?? options.via;

  if (options.target) {
    if (
      options.definition !== undefined ||
      options.source !== undefined ||
      options.resource !== undefined
    ) {
      return { failure: 'invalid_definition' };
    }
    if (options.target.kind === 'external') {
      const definition = parseDefinition(options.target.definition);
      return definition ? { definition } : { failure: 'invalid_definition' };
    }
    const definition = builtinDefinition(
      options.target.source,
      options.target.resource,
      options.target.transport ?? requestedTransport,
      buildCatalogManifest()
    );
    return definition ? { definition } : { failure: 'resource_not_found' };
  }

  const external = externalDefinitionFromOptions(options);
  if (external !== undefined) {
    if (typeof options.source === 'string' || typeof options.resource === 'string') {
      return { failure: 'invalid_definition' };
    }
    const definition = parseDefinition(external);
    if (!definition) return { failure: 'invalid_definition' };
    if (requestedTransport && !Object.hasOwn(definition.source.transports, requestedTransport)) {
      return { failure: 'resource_not_found' };
    }
    if (requestedTransport && definition.resource.via !== requestedTransport) {
      definition.resource.via = requestedTransport;
    }
    return { definition };
  }

  if (typeof options.source !== 'string' || typeof options.resource !== 'string') {
    return { failure: 'invalid_definition' };
  }

  const definition = builtinDefinition(
    options.source,
    options.resource,
    requestedTransport,
    buildCatalogManifest()
  );
  return definition ? { definition } : { failure: 'resource_not_found' };
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
}

function buildExecutorRequest(
  definition: CatalogProbeDefinition,
  options: ProbeApiResourceOptions
): ProbeAuthenticationRequest {
  const requestedTransport = options.transport ?? options.via;
  const transport = selectTransport(definition.source, definition.resource, requestedTransport);
  if (!transport) throw new Error('Transport is not declared by the source');

  const merged = mergeApiRequest(
    transport as ApiRequestTransport<CatalogProbeAuth>,
    definition.resource.api as ApiRequestOperation<CatalogProbeAuth>
  );
  const planned = buildApiRequest({
    api: merged,
    inputSchema: definition.resource.input as Record<string, ApiRequestInputFieldDefinition>,
    providedInput: options.input ? { ...options.input } : undefined,
    context: {
      secrets: options.secrets ? { ...options.secrets } : {},
      declaredSecretNames: options.declaredSecretNames,
      // Built-in YAMLs historically use env placeholders for provider
      // credentials. Bobsled Core supplies project secrets, so make that explicit
      // map available to both the legacy env spelling and the secrets spelling
      // without consulting process.env.
      env: { ...(options.secrets ?? {}), ...(options.env ?? {}) },
      allowProcessEnvFallback: false,
      declaredEnvVars: new Set(definition.source.auth_env_vars),
    },
    inputMode: 'strict',
    rejectUnknownNestedProperties: true,
    // Optional query inputs are omitted by normal extraction; preserve that
    // first-request behavior while strict validation still rejects declared
    // required inputs and unknown keys.
    skipMissingInputQueryParams: true,
  });

  return {
    url: planned.url,
    method: planned.method,
    headers: planned.headers,
    body: planned.body,
    auth: planned.auth,
    timeout_ms: planned.timeout_ms,
    signal: options.signal,
  };
}

function validateResponseLimit(value: number | undefined): number | undefined {
  const limit = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_RESPONSE_BYTES
    ? limit
    : undefined;
}

/**
 * Execute one request for a built-in or validated external API resource. The
 * executor is the only network boundary; Bobsled Core does not apply retries,
 * redirects, pagination, loaders, or state changes. OAuth/custom-token auth
 * performs one bounded token exchange through the same executor before the
 * one resource request.
 */
export async function probeApiResource(
  options: ProbeApiResourceOptions
): Promise<ProbeApiResourceResult> {
  options.signal?.throwIfAborted();

  if (typeof options.executor !== 'function') {
    return failure('invalid_request');
  }
  const executor = options.executor;

  const maxBytes = validateResponseLimit(options.maxResponseBytes);
  if (maxBytes === undefined) return failure('invalid_request');

  const resolved = resolveDefinition(options);
  if (!resolved.definition) return failure(resolved.failure ?? 'invalid_definition');

  let plannedRequest: ProbeAuthenticationRequest;
  try {
    plannedRequest = buildExecutorRequest(resolved.definition, options);
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    const message = error instanceof Error ? error.message : '';
    return failure(
      message.includes('input.') || message.startsWith('Unknown input')
        ? 'invalid_input'
        : 'invalid_request'
    );
  }

  // Build and validate the bounded redaction plan before invoking the caller's
  // executor. This keeps untrusted external definitions from expanding the
  // response sanitizer after a provider request has already started.
  const initialRequest: ProbeApiResourceExecutorRequest = {
    url: plannedRequest.url,
    method: plannedRequest.method,
    headers: plannedRequest.headers,
    body: plannedRequest.body === undefined ? undefined : JSON.stringify(plannedRequest.body),
    timeout_ms: plannedRequest.timeout_ms,
    signal: plannedRequest.signal,
    phase: 'resource',
  };
  const initialRedaction = buildProbeRedactionPlan({
    secrets: options.secrets,
    env: options.env,
    request: {
      url: initialRequest.url,
      headers: initialRequest.headers,
      body: initialRequest.body,
      authorization: plannedRequest.auth,
    },
  });
  if (!initialRedaction) return failure('invalid_request');

  let authenticated: Awaited<ReturnType<typeof applyProbeAuthentication>>;
  try {
    authenticated = await applyProbeAuthentication({ request: plannedRequest, executor });
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    if (error instanceof ProbeAuthFailure) return failure(error.code);
    return failure('invalid_request');
  }

  // Rebuild after authentication so derived header/query values and a
  // single-use OAuth/custom token are protected as well. The initial plan
  // above is still what bounds credential collection before any executor call.
  const redaction = buildProbeRedactionPlan({
    secrets: options.secrets,
    env: options.env,
    additionalSecrets: authenticated.additionalSecrets,
    request: {
      url: authenticated.request.url,
      headers: authenticated.request.headers,
      body: authenticated.request.body,
      authorization: plannedRequest.auth,
    },
  });
  if (!redaction) return failure('invalid_request');

  let response: Response;
  try {
    response = await executor(authenticated.request);
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    return failure('executor_failed');
  }

  let diagnostic: ProbeApiResourceResponse;
  try {
    diagnostic = await readBoundedProbeResponse(response, maxBytes, redaction);
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    return failure('response_read_failed');
  }

  return response.ok
    ? { ok: true, response: diagnostic }
    : { ok: false, code: 'http_status', response: diagnostic };
}

export const probeResource = probeApiResource;

export type {
  CatalogProbeApi,
  CatalogProbeAuth,
  CatalogProbeDefinition,
  CatalogProbeFieldType,
  CatalogProbeHttpMethod,
  CatalogProbeInputField,
  CatalogProbeJsonValue,
  CatalogProbeResource,
  CatalogProbeRequestPhase,
  CatalogProbeSource,
  CatalogProbeTransport,
  ProbeApiResourceExecutorRequest,
};
