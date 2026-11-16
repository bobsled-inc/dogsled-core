/**
 * Generate extractor specs from OpenAPI 3.x documents.
 *
 * Pure functions: parse → map integration → map resources → validate.
 * All I/O (file writes) is handled by the command layer.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';
import YAML from 'yaml';
import { parseEnvPlaceholder } from '@bobsled-inc/protocol';

import { SAFE_NAME_RE, safeFetch } from '../framework/core/index.js';
import { IntegrationSpecSchema } from '../schemas/integration.js';
import { ResourceSpecSchema } from '../schemas/resource.js';
import { detectPagination } from './openapi-pagination.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratedSpec {
  spec: Record<string, unknown>;
  yaml: string;
  warnings: string[];
  fileName: string;
}

export interface GenerateResult {
  integration: GeneratedSpec;
  resources: GeneratedSpec[];
  skipped: Array<{ path: string; method: string; reason: string }>;
}

export interface GenerateOptions {
  integrationName?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGINATION_METADATA_NAMES = new Set([
  'total',
  'total_count',
  'count',
  'has_more',
  'has_next',
  'next_cursor',
  'next_page_token',
  'links',
  'meta',
  'pagination',
  'page_info',
  'page',
  'per_page',
  'offset',
  'limit',
]);

const WELL_KNOWN_ARRAY_NAMES = ['data', 'results', 'items', 'records', 'entries'];

const MAX_SPEC_SIZE = 50 * 1024 * 1024; // 50 MB

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to read OpenAPI spec response body');

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`OpenAPI spec too large (max ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generateFromOpenApi(
  source: string,
  options: GenerateOptions
): Promise<GenerateResult> {
  const spec = await parseOpenApiSpec(source);
  const doc = spec as OpenAPIV3.Document;

  const integrationName = inferIntegrationName(doc, options.integrationName);
  const integrationSpec = mapIntegrationSpec(doc, integrationName);

  const operations = collectOperations(doc, options.tags);
  const { resources: mappedResources, skipped } = mapAllResources(operations, doc, integrationName);

  const integration = finalizeSpec(
    integrationSpec,
    IntegrationSpecSchema,
    `integrations/${integrationName}.yml`
  );

  const resources: GeneratedSpec[] = [];
  for (const { spec: resSpec, fileName, yamlComments } of mappedResources) {
    resources.push(finalizeSpec(resSpec, ResourceSpecSchema, fileName, yamlComments));
  }

  return { integration, resources, skipped };
}

// ---------------------------------------------------------------------------
// Step 1: Load & parse
// ---------------------------------------------------------------------------

export async function parseOpenApiSpec(source: string): Promise<OpenAPIV3.Document> {
  // swagger-parser returns OpenAPI.Document (union of V2/V3), but we dereference
  // and handle V2→V3 conversion transparently, so the cast is safe.
  if (source.startsWith('http://')) {
    throw new Error('HTTP URLs are not supported for security reasons. Use HTTPS instead.');
  }

  if (source.startsWith('https://')) {
    const response = await safeFetch(source, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/json, application/yaml, text/yaml' },
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await readBodyWithLimit(response, MAX_SPEC_SIZE);

    if (contentType.includes('text/html') || body.trimStart().startsWith('<!')) {
      throw new Error(
        'This looks like a documentation page, not a raw spec. ' +
          'Try one of: /openapi.json, /v3/api-docs, /swagger.json'
      );
    }

    // Parse the text content and pass to swagger-parser.
    // Disable file resolution for URL-sourced specs to prevent $ref-based LFI.
    const parsed = YAML.parse(body);
    return (await SwaggerParser.dereference(parsed, {
      resolve: { file: false, http: false },
    })) as OpenAPIV3.Document;
  }

  // For local file specs, allow file $ref resolution (relative paths within the spec)
  // but disable HTTP resolution to prevent $ref-based SSRF.
  return (await SwaggerParser.dereference(source, {
    resolve: { http: false },
  })) as OpenAPIV3.Document;
}

// ---------------------------------------------------------------------------
// Step 2: Integration name inference
// ---------------------------------------------------------------------------

export function inferIntegrationName(doc: OpenAPIV3.Document, explicit?: string): string {
  if (explicit) {
    return sanitizeName(explicit);
  }

  // Try info.title
  if (doc.info?.title) {
    const slug = slugify(doc.info.title);
    if (slug && SAFE_NAME_RE.test(slug)) return slug;
  }

  // Try server URL hostname
  const serverUrl = doc.servers?.[0]?.url;
  if (serverUrl) {
    try {
      const url = new URL(serverUrl);
      const parts = url.hostname.split('.');
      // Use first subdomain or domain: "api.stripe.com" → "stripe"
      const candidate = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
      const slug = slugify(candidate);
      if (slug && SAFE_NAME_RE.test(slug)) return slug;
    } catch {
      // not a valid URL
    }
  }

  return 'api';
}

function slugify(text: string): string {
  return (
    text
      // Insert underscore before uppercase letters (camelCase → camel_case)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
  );
}

function sanitizeName(name: string): string {
  const slug = slugify(name);
  return slug || 'api';
}

// ---------------------------------------------------------------------------
// Step 3: Map IntegrationSpec
// ---------------------------------------------------------------------------

export function mapIntegrationSpec(
  doc: OpenAPIV3.Document,
  integrationName: string
): Record<string, unknown> {
  const baseUrl = resolveServerUrl(doc);
  const auth = mapAuth(doc, integrationName);
  const description = doc.info?.description ? truncateToSentence(doc.info.description) : undefined;

  const transport: Record<string, unknown> = {
    base_url: baseUrl,
    auth,
    timeout_ms: 30_000,
    retry: {
      retry_on: [429, 503],
      max_retries: 3,
      backoff: 'exponential',
      retry_after_header: true,
    },
    rate_limit: {
      requests_per_second: 10,
      burst: 20,
    },
    headers: {
      Accept: 'application/json',
      'User-Agent': 'bobsled-core-extractor',
    },
  };

  const spec: Record<string, unknown> = {
    spec_version: '1',
    type: 'integration',
    name: integrationName,
    auth_env_vars: Object.values(auth)
      .filter((value): value is string => typeof value === 'string')
      .map(parseEnvPlaceholder)
      .filter((name): name is string => name !== null),
    transport,
  };

  if (description) {
    spec['description'] = description;
  }

  return spec;
}

function resolveServerUrl(doc: OpenAPIV3.Document): string {
  const server = doc.servers?.[0];
  if (!server?.url) return 'https://api.example.com';

  let url = server.url;

  // Resolve server variables with defaults
  if (server.variables) {
    for (const [key, variable] of Object.entries(server.variables)) {
      const value = variable.default ?? '';
      url = url.replace(`{${key}}`, String(value));
    }
  }

  // Upgrade HTTP to HTTPS
  if (url.startsWith('http://')) {
    url = url.replace('http://', 'https://');
  }

  // Ensure it's a full URL
  if (!url.startsWith('https://')) {
    url = `https://${url}`;
  }

  // Remove trailing slash
  return url.replace(/\/+$/, '');
}

function truncateToSentence(text: string): string {
  const firstLine = text.split('\n')[0] ?? text;
  const match = firstLine.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : firstLine.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Auth mapping
// ---------------------------------------------------------------------------

export function mapAuth(doc: OpenAPIV3.Document, integrationName: string): Record<string, unknown> {
  const envPrefix = integrationName.toUpperCase();
  const schemes = doc.components?.securitySchemes;

  if (!schemes || Object.keys(schemes).length === 0) {
    // No schemes declared — check if doc.security is explicitly empty (public API)
    if (doc.security && doc.security.length === 0) {
      return { type: 'bearer', token: `\${{ env.${envPrefix}_TOKEN }}` };
    }
    return {
      type: 'bearer',
      token: `\${{ env.${envPrefix}_TOKEN }}`,
    };
  }

  // Determine which scheme names are actually required by the spec
  const requiredSchemeNames = new Set<string>();
  if (doc.security) {
    for (const req of doc.security) {
      for (const name of Object.keys(req)) {
        requiredSchemeNames.add(name);
      }
    }
  }

  // If doc.security is explicitly empty array, the API is public — no auth needed
  if (doc.security && doc.security.length === 0) {
    return { type: 'bearer', token: `\${{ env.${envPrefix}_TOKEN }}` };
  }

  // Order schemes: referenced by doc.security first, then remaining
  const orderedSchemes: OpenAPIV3.SecuritySchemeObject[] = [];

  // First pass: schemes referenced by doc.security
  if (requiredSchemeNames.size > 0) {
    for (const name of requiredSchemeNames) {
      const scheme = schemes[name];
      if (scheme) orderedSchemes.push(scheme as OpenAPIV3.SecuritySchemeObject);
    }
  }

  // Second pass: remaining schemes (fallback when no doc.security)
  if (orderedSchemes.length === 0) {
    for (const value of Object.values(schemes)) {
      orderedSchemes.push(value as OpenAPIV3.SecuritySchemeObject);
    }
  }

  // Find the first usable security scheme
  for (const scheme of orderedSchemes) {
    if (scheme.type === 'http') {
      if (scheme.scheme === 'bearer') {
        return {
          type: 'bearer',
          token: `\${{ env.${envPrefix}_TOKEN }}`,
        };
      }
      if (scheme.scheme === 'basic') {
        return {
          type: 'basic',
          username: `\${{ env.${envPrefix}_USERNAME }}`,
          password: `\${{ env.${envPrefix}_PASSWORD }}`,
        };
      }
    }

    if (scheme.type === 'apiKey') {
      if (scheme.in === 'cookie') continue; // Skip cookie auth

      const authObj: Record<string, unknown> = {
        type: 'api-key',
        key: `\${{ env.${envPrefix}_API_KEY }}`,
      };
      if (scheme.in === 'header') {
        authObj['header'] = scheme.name;
      } else if (scheme.in === 'query') {
        authObj['query_param'] = scheme.name;
      }
      return authObj;
    }

    if (scheme.type === 'oauth2') {
      const flows = scheme.flows;
      if (flows?.clientCredentials) {
        return {
          type: 'oauth2',
          grant_type: 'client_credentials',
          token_url: flows.clientCredentials.tokenUrl,
          client_id: `\${{ env.${envPrefix}_CLIENT_ID }}`,
          client_secret: `\${{ env.${envPrefix}_CLIENT_SECRET }}`,
        };
      }
      if (flows?.authorizationCode) {
        const scopes = Object.keys(flows.authorizationCode.scopes ?? {});
        return {
          type: 'oauth2',
          grant_type: 'authorization_code',
          token_url: flows.authorizationCode.tokenUrl,
          client_id: `\${{ env.${envPrefix}_CLIENT_ID }}`,
          client_secret: `\${{ env.${envPrefix}_CLIENT_SECRET }}`,
          refresh_token: `\${{ env.${envPrefix}_REFRESH_TOKEN }}`,
          ...(scopes.length > 0 ? { scopes } : {}),
        };
      }
      continue;
    }
  }

  // Fallback
  return {
    type: 'bearer',
    token: `\${{ env.${envPrefix}_TOKEN }}`,
  };
}

// ---------------------------------------------------------------------------
// Step 4: Collect GET operations
// ---------------------------------------------------------------------------

export interface CollectedOperation {
  path: string;
  method: string;
  operation: OpenAPIV3.OperationObject;
  pathItem: OpenAPIV3.PathItemObject;
}

export function collectOperations(
  doc: OpenAPIV3.Document,
  tags?: string[],
  methods: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = ['GET'],
  options?: { includeDeprecated?: boolean }
): CollectedOperation[] {
  const ops: CollectedOperation[] = [];
  const tagSet = tags && tags.length > 0 ? new Set(tags.map((t) => t.toLowerCase())) : null;
  const methodSet = new Set(methods.map((m) => m.toUpperCase()));
  const includeDeprecated = options?.includeDeprecated ?? false;

  for (const [pathStr, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem) continue;
    const item = pathItem as OpenAPIV3.PathItemObject;

    const methodEntries: Array<[string, OpenAPIV3.OperationObject | undefined]> = [
      ['GET', item.get],
      ['POST', item.post],
      ['PUT', item.put],
      ['PATCH', item.patch],
      ['DELETE', item.delete],
    ];

    for (const [method, operation] of methodEntries) {
      if (!methodSet.has(method) || !operation) continue;

      if (operation.deprecated && !includeDeprecated) continue;

      // Filter by tags
      if (tagSet) {
        const opTags = (operation.tags ?? []).map((t) => t.toLowerCase());
        if (!opTags.some((t) => tagSet.has(t))) continue;
      }

      ops.push({ path: pathStr, method, operation, pathItem: item });
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Step 4: Map all resources (with lookup pairing)
// ---------------------------------------------------------------------------

interface MappedResource {
  spec: Record<string, unknown>;
  fileName: string;
  yamlComments: string[];
}

function mapAllResources(
  operations: CollectedOperation[],
  doc: OpenAPIV3.Document,
  integrationName: string
): {
  resources: MappedResource[];
  skipped: Array<{ path: string; method: string; reason: string }>;
} {
  const skipped: Array<{ path: string; method: string; reason: string }> = [];
  const usedNames = new Set<string>();

  // Detect lookup pairs first
  const lookupPairs = detectLookupPairs(operations);
  const detailPaths = new Set(lookupPairs.map((p) => p.detail.path));
  const lookupByListPath = new Map(lookupPairs.map((p) => [p.list.path, p]));

  const resources: MappedResource[] = [];

  for (const op of operations) {
    // Skip detail endpoints — they'll be embedded as lookups
    if (detailPaths.has(op.path)) continue;

    // Skip binary responses
    const responseSchema = getResponseSchema(op.operation);
    if (responseSchema && isBinarySchema(responseSchema)) {
      skipped.push({ path: op.path, method: op.method, reason: 'binary response' });
      continue;
    }

    const name = deriveName(op, usedNames);
    usedNames.add(name);

    const pair = lookupByListPath.get(op.path);
    const lookup = pair ? mapLookupSpec(pair.detail) : undefined;

    const resSpec = mapResourceSpec(op, integrationName, name, doc, lookup);

    const tags = op.operation.tags?.join(', ') ?? '';
    const reviewMarkers: string[] = [];
    const extract = resSpec['extract'] as Record<string, unknown> | undefined;
    const table = extract?.['table'] as Record<string, unknown> | undefined;
    if (!table?.['primary_key']) {
      reviewMarkers.push('# REVIEW: No primary key detected — set extract.table.primary_key');
    }
    const output = resSpec['output'] as Record<string, unknown> | undefined;
    if (!output || Object.keys(output).length === 0) {
      reviewMarkers.push('# REVIEW: No output fields mapped — add output fields manually');
    }
    if (!resSpec['description'] || resSpec['description'] === `GET ${op.path}`) {
      reviewMarkers.push('# REVIEW: Missing or generic description — add a meaningful description');
    }
    const yamlComments = [
      `# Source: GET ${op.path}`,
      ...(tags ? [`# Tags: ${tags}`] : []),
      ...reviewMarkers,
    ];

    const fileName = `resources/${integrationName}/${name}.yml`;
    resources.push({ spec: resSpec, fileName, yamlComments });
  }

  return { resources, skipped };
}

// ---------------------------------------------------------------------------
// Step 4a: Name derivation
// ---------------------------------------------------------------------------

function deriveName(op: CollectedOperation, usedNames: Set<string>): string {
  let name: string;

  if (op.operation.operationId) {
    name = slugify(op.operation.operationId);
  } else {
    // Derive from path: /v1/customers/{id} → customers_by_id
    name = slugify(
      op.path
        .replace(/^\/+/, '')
        .replace(/\{([^}]+)\}/g, 'by_$1')
        .replace(/\/v\d+\/?/, '')
    );
  }

  if (!name || !SAFE_NAME_RE.test(name)) {
    name = 'resource';
  }

  // Handle collisions
  let finalName = name;
  let counter = 2;
  while (usedNames.has(finalName)) {
    finalName = `${name}_${counter}`;
    counter += 1;
  }

  return finalName;
}

// ---------------------------------------------------------------------------
// Step 4b-4c: Map resource spec
// ---------------------------------------------------------------------------

function toInputTemplate(pathTemplate: string): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_, rawName) => {
    const fieldName = slugify(rawName) || rawName;
    return `\${{ input.${fieldName} }}`;
  });
}

function mapResourceSpec(
  op: CollectedOperation,
  integrationName: string,
  name: string,
  _doc: OpenAPIV3.Document,
  lookup?: Record<string, unknown>
): Record<string, unknown> {
  const endpoint = toInputTemplate(op.path);
  const parameters = resolveParameters(op);

  const input: Record<string, Record<string, unknown>> = {};
  const queryParams: Record<string, string> = {};

  for (const param of parameters) {
    if (param.in === 'path' || param.in === 'query') {
      const fieldName = slugify(param.name);
      if (!fieldName) continue;

      const field = mapInputField(param);
      input[fieldName] = field;

      if (param.in === 'query') {
        queryParams[param.name] = `\${{ input.${fieldName} }}`;
      }
    }
  }

  // Output fields from response schema
  const responseSchema = getResponseSchema(op.operation);
  const { recordPath, outputFields } = inferOutputFields(responseSchema);

  // Pagination
  const pagination = detectPagination(parameters, responseSchema);

  // Primary key
  const primaryKey = inferPrimaryKey(outputFields);

  // Incremental cursor
  const incremental = inferIncremental(outputFields, parameters);

  const api: Record<string, unknown> = {
    endpoint,
    method: 'GET',
  };
  if (Object.keys(queryParams).length > 0) {
    api['query_params'] = queryParams;
  }

  const extract: Record<string, unknown> = {
    record_path: recordPath,
  };
  if (pagination) {
    extract['pagination'] = pagination;
  }
  if (incremental) {
    extract['incremental'] = incremental;
  }
  if (primaryKey.length > 0) {
    extract['table'] = { primary_key: primaryKey };
  }

  const description = op.operation.summary ?? op.operation.description ?? `GET ${op.path}`;

  const spec: Record<string, unknown> = {
    spec_version: '1',
    type: 'resource',
    name,
    integration: integrationName,
    description: truncateToSentence(description),
    api,
    input,
    output: outputFields,
    extract,
  };

  if (lookup) {
    spec['lookup'] = lookup;
  }

  // Test fixtures from parameter examples
  const fixtures = buildTestFixtures(parameters, name);
  if (fixtures) {
    spec['test'] = fixtures;
  }

  return spec;
}

// ---------------------------------------------------------------------------
// Parameter resolution
// ---------------------------------------------------------------------------

export function resolveParameters(op: CollectedOperation): OpenAPIV3.ParameterObject[] {
  // Operation-level params override path-item params per OpenAPI spec
  const byKey = new Map<string, OpenAPIV3.ParameterObject>();

  for (const param of op.pathItem.parameters ?? []) {
    const p = param as OpenAPIV3.ParameterObject;
    byKey.set(`${p.in}:${p.name}`, p);
  }

  for (const param of op.operation.parameters ?? []) {
    const p = param as OpenAPIV3.ParameterObject;
    byKey.set(`${p.in}:${p.name}`, p);
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Step 4c: Input field mapping
// ---------------------------------------------------------------------------

function mapInputField(param: OpenAPIV3.ParameterObject): Record<string, unknown> {
  const schema = (param.schema ?? {}) as OpenAPIV3.SchemaObject;
  const field: Record<string, unknown> = {
    type: mapFieldType(schema, param.name),
  };

  if (param.in === 'path' || param.required) {
    field['required'] = true;
  }

  if (param.description) {
    field['description'] = param.description;
  }

  if (schema.enum) {
    field['enum'] = schema.enum;
  }

  if (schema.default !== undefined) {
    field['default'] = schema.default;
  }

  if (schema.minimum !== undefined) field['minimum'] = schema.minimum;
  if (schema.maximum !== undefined) field['maximum'] = schema.maximum;
  if (schema.minLength !== undefined) field['minLength'] = schema.minLength;
  if (schema.maxLength !== undefined) field['maxLength'] = schema.maxLength;
  if (schema.pattern !== undefined) field['pattern'] = schema.pattern;

  return field;
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

export function mapFieldType(schema: OpenAPIV3.SchemaObject, fieldName?: string): string {
  const type = schema.type;
  const format = schema.format;

  if (type === 'string') {
    if (format === 'date-time' || format === 'date') return 'timestamp';
    if (fieldName && /_(at|date|time)$/.test(fieldName)) return 'timestamp';
    return 'string';
  }
  if (type === 'integer') return 'integer';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';

  return 'string';
}

// ---------------------------------------------------------------------------
// Step 4d: Output field inference
// ---------------------------------------------------------------------------

interface OutputInference {
  recordPath: string;
  outputFields: Record<string, Record<string, unknown>>;
}

function inferOutputFields(schema: OpenAPIV3.SchemaObject | null): OutputInference {
  if (!schema) {
    return { recordPath: '$', outputFields: {} };
  }

  const { recordPath, itemSchema } = inferRecordPath(schema);
  const outputFields = flattenSchema(itemSchema);

  return { recordPath, outputFields };
}

export function inferRecordPath(schema: OpenAPIV3.SchemaObject): {
  recordPath: string;
  itemSchema: OpenAPIV3.SchemaObject;
} {
  // Top-level array
  if (schema.type === 'array') {
    const arrSchema = schema as OpenAPIV3.ArraySchemaObject;
    const items = (arrSchema.items ?? {}) as OpenAPIV3.SchemaObject;
    return { recordPath: '$', itemSchema: items };
  }

  // Object — look for array properties
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties ?? {};
    const arrayProps: string[] = [];

    for (const [key, value] of Object.entries(props)) {
      const prop = value as OpenAPIV3.SchemaObject;
      if (prop.type === 'array' && !PAGINATION_METADATA_NAMES.has(key)) {
        arrayProps.push(key);
      }
    }

    if (arrayProps.length > 0) {
      // Pick the best array property: single match, or prefer well-known names, or first
      const winner =
        arrayProps.length === 1
          ? arrayProps[0]!
          : (WELL_KNOWN_ARRAY_NAMES.find((wk) => arrayProps.includes(wk)) ?? arrayProps[0]!);
      const arrSchema = props[winner] as OpenAPIV3.ArraySchemaObject;
      const items = (arrSchema.items ?? {}) as OpenAPIV3.SchemaObject;
      return { recordPath: `$.${winner}`, itemSchema: items };
    }

    // No array props — single object endpoint
    return { recordPath: '$', itemSchema: schema };
  }

  // Handle oneOf/anyOf — pick first variant
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && variants.length > 0) {
    return inferRecordPath(variants[0] as OpenAPIV3.SchemaObject);
  }

  return { recordPath: '$', itemSchema: schema };
}

export function flattenSchema(
  schema: OpenAPIV3.SchemaObject,
  prefix = '',
  pathPrefix = '',
  depth = 0
): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  const props = schema.properties ?? {};

  for (const [key, value] of Object.entries(props)) {
    const prop = value as OpenAPIV3.SchemaObject;
    const fieldName = prefix !== '' ? `${prefix}_${key}` : key;
    const fieldPath = pathPrefix !== '' ? `${pathPrefix}.${key}` : `$.${key}`;

    const type = mapFieldType(prop, key);

    if (type === 'object' && prop.properties && depth === 0) {
      // Flatten depth-1 nested objects (< 10 props)
      const nestedProps = Object.keys(prop.properties);
      if (nestedProps.length < 10) {
        const nested = flattenSchema(prop, key, `$.${key}`, depth + 1);
        Object.assign(fields, nested);
        continue;
      }
    }

    const field: Record<string, unknown> = {
      type,
      path: fieldPath,
    };

    if (prop.description) {
      let desc = prop.description;
      if (prop.format && ['email', 'uri', 'uuid'].includes(prop.format)) {
        desc += ` (format: ${prop.format})`;
      }
      field['description'] = truncateToSentence(desc);
    }

    fields[slugify(fieldName) || fieldName] = field;
  }

  return fields;
}

export { detectPagination } from './openapi-pagination.js';

// ---------------------------------------------------------------------------
// Step 4f: Primary key inference
// ---------------------------------------------------------------------------

function inferPrimaryKey(outputFields: Record<string, Record<string, unknown>>): string[] {
  for (const [name, field] of Object.entries(outputFields)) {
    if (
      (name === 'id' || name.endsWith('_id')) &&
      (field['type'] === 'integer' || field['type'] === 'string')
    ) {
      return [name];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Step 4g: Incremental cursor inference
// ---------------------------------------------------------------------------

function inferIncremental(
  outputFields: Record<string, Record<string, unknown>>,
  parameters: OpenAPIV3.ParameterObject[]
): Record<string, unknown> | null {
  // Prefer updated_at over created_at for incremental cursors
  const PREFERRED_CURSOR_FIELDS = ['updated_at', 'modified_at', 'changed_at'];

  const candidates: string[] = [];
  for (const [name, field] of Object.entries(outputFields)) {
    if (field['type'] === 'timestamp' && /_(at|date)$/.test(name)) {
      candidates.push(name);
    }
  }

  if (candidates.length === 0) return null;

  // Pick the best candidate
  const cursorField = candidates.find((c) => PREFERRED_CURSOR_FIELDS.includes(c)) ?? candidates[0]!;

  const sinceParam = parameters.find(
    (p) =>
      p.in === 'query' && ['since', 'updated_since', 'modified_since', 'after'].includes(p.name)
  );

  // Only emit incremental config if the API actually has a filter param
  if (!sinceParam) return null;

  return {
    cursor_field: cursorField,
    cursor_param: sinceParam.name,
  };
}

// ---------------------------------------------------------------------------
// Step 4h: Lookup pairing
// ---------------------------------------------------------------------------

interface LookupPair {
  list: CollectedOperation;
  detail: CollectedOperation;
}

export function detectLookupPairs(operations: CollectedOperation[]): LookupPair[] {
  // O(n) approach: build a map of paths, then check if each /{param} path
  // has a matching list endpoint as its prefix.
  const byPath = new Map<string, CollectedOperation>();
  for (const op of operations) {
    byPath.set(op.path, op);
  }

  const pairs: LookupPair[] = [];
  const usedDetails = new Set<string>();

  for (const op of operations) {
    // Check if this path ends with /{param} — a detail endpoint
    const match = op.path.match(/^(.+)\/\{[^}]+\}$/);
    if (!match) continue;

    const listPath = match[1]!;
    const list = byPath.get(listPath);
    if (list && !usedDetails.has(op.path)) {
      pairs.push({ list, detail: op });
      usedDetails.add(op.path);
    }
  }

  return pairs;
}

function mapLookupSpec(detail: CollectedOperation): Record<string, unknown> {
  const endpoint = toInputTemplate(detail.path);
  const parameters = resolveParameters(detail);

  const input: Record<string, Record<string, unknown>> = {};
  for (const param of parameters) {
    if (param.in === 'path') {
      const fieldName = slugify(param.name);
      if (!fieldName) continue;
      input[fieldName] = {
        type: mapFieldType((param.schema ?? {}) as OpenAPIV3.SchemaObject, param.name),
        required: true,
      };
    }
  }

  const description =
    detail.operation.summary ?? detail.operation.description ?? `GET ${detail.path}`;

  return {
    description: truncateToSentence(description),
    api: {
      endpoint,
      method: 'GET',
    },
    input,
  };
}

// ---------------------------------------------------------------------------
// Step 4i: Test fixtures from examples
// ---------------------------------------------------------------------------

function buildTestFixtures(
  parameters: OpenAPIV3.ParameterObject[],
  resourceName: string
): Record<string, unknown> | null {
  const fixtureInput: Record<string, unknown> = {};
  let hasExample = false;

  for (const param of parameters) {
    if (param.example !== undefined) {
      fixtureInput[slugify(param.name)] = param.example;
      hasExample = true;
    } else if ((param.schema as OpenAPIV3.SchemaObject)?.example !== undefined) {
      fixtureInput[slugify(param.name)] = (param.schema as OpenAPIV3.SchemaObject).example;
      hasExample = true;
    }
  }

  if (!hasExample) return null;

  return {
    fixtures: [
      {
        name: `${resourceName}_smoke`,
        input: fixtureInput,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Response schema extraction
// ---------------------------------------------------------------------------

export function getResponseSchema(
  operation: OpenAPIV3.OperationObject
): OpenAPIV3.SchemaObject | null {
  const responses = operation.responses ?? {};

  // Try 200, then 2xx codes
  for (const code of ['200', '201', '202']) {
    const response = responses[code] as OpenAPIV3.ResponseObject | undefined;
    if (!response) continue;

    const content = response.content;
    if (!content) continue;

    const jsonContent = content['application/json'];
    if (!jsonContent?.schema) continue;

    return jsonContent.schema as OpenAPIV3.SchemaObject;
  }

  // Try default
  const defaultResp = responses['default'] as OpenAPIV3.ResponseObject | undefined;
  if (defaultResp?.content?.['application/json']?.schema) {
    return defaultResp.content['application/json'].schema as OpenAPIV3.SchemaObject;
  }

  return null;
}

function isBinarySchema(schema: OpenAPIV3.SchemaObject): boolean {
  return schema.format === 'binary';
}

// ---------------------------------------------------------------------------
// Step 5: Validation & YAML generation
// ---------------------------------------------------------------------------

function finalizeSpec(
  spec: Record<string, unknown>,
  schema: {
    safeParse: (data: unknown) => {
      success: boolean;
      error?: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> };
    };
  },
  fileName: string,
  yamlComments?: string[]
): GeneratedSpec {
  const warnings: string[] = [];

  const result = schema.safeParse(spec);
  if (!result.success) {
    for (const issue of result.error?.issues ?? []) {
      warnings.push(`${String(issue.path.join('.')) || '(root)'}: ${issue.message}`);
    }
  }

  let yaml = YAML.stringify(spec);

  // Prepend YAML comments
  if (yamlComments && yamlComments.length > 0) {
    yaml = yamlComments.join('\n') + '\n' + yaml;
  }

  return { spec, yaml, warnings, fileName };
}
