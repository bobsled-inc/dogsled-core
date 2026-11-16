/**
 * OpenAPI spec diffing logic for `bobsled extract check`.
 *
 * Pure diff logic — no CLI concerns. Compares integration + resource YAML
 * specs against an OpenAPI document to detect drift.
 */

import type { OpenAPIV3 } from 'openapi-types';

import type { ApiIntegrationSpec, ApiResourceSpec } from '../types/index.js';
import {
  collectOperations,
  detectPagination,
  flattenSchema,
  getResponseSchema,
  mapFieldType,
  resolveParameters,
  type CollectedOperation,
} from '../runtime/openapi-mapper.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CheckFinding {
  severity: 'error' | 'warn' | 'info';
  resource: string;
  field?: string;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Template conversion
// ---------------------------------------------------------------------------

/**
 * Convert `${{ input.foo }}` template syntax back to `{foo}` OpenAPI
 * path parameter format for matching against OpenAPI paths.
 */
function toOpenApiTemplate(endpoint: string): string {
  return endpoint.replace(/\$\{\{\s*input\.([^}\s]+)\s*\}\}/g, '{$1}');
}

function normalizePath(path: string): string {
  if (path === '') return '/';
  const normalized = path.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function canonicalizePath(path: string): string {
  return normalizePath(path)
    .split('/')
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? '{}' : segment))
    .join('/');
}

/**
 * Strip a base_url prefix from a resource endpoint so we can match
 * against relative OpenAPI paths.
 */
function stripBaseUrl(endpoint: string, baseUrl: string): string {
  // The endpoint in YAML is relative (starts with /), so no stripping needed.
  // But if someone put an absolute URL, strip the base.
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    try {
      const url = new URL(endpoint);
      return url.pathname;
    } catch {
      return endpoint;
    }
  }

  // If base_url has a path component (e.g. https://api.example.com/v1),
  // resource endpoints already include that prefix in some specs.
  try {
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
    if (basePath && basePath !== '/' && endpoint.startsWith(basePath)) {
      return endpoint.slice(basePath.length) || '/';
    }
  } catch {
    // not a valid URL
  }

  return endpoint;
}

function getPathCandidates(endpoint: string, baseUrl: string): string[] {
  const templatePath = normalizePath(toOpenApiTemplate(endpoint));
  const strippedPath = normalizePath(stripBaseUrl(templatePath, baseUrl));
  const candidates = new Set([templatePath, strippedPath]);

  try {
    const basePath = normalizePath(new URL(baseUrl).pathname);
    if (basePath !== '/' && !templatePath.startsWith(`${basePath}/`) && templatePath !== basePath) {
      candidates.add(normalizePath(`${basePath}${templatePath === '/' ? '' : templatePath}`));
    }
  } catch {
    // Ignore non-URL base paths during verification matching.
  }

  return Array.from(candidates);
}

function findMatchingPath(
  candidates: string[],
  allPaths: Set<string>,
  pathsByCanonical: Map<string, string[]>
): string | undefined {
  for (const candidate of candidates) {
    if (allPaths.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    const canonicalMatches = pathsByCanonical.get(canonicalizePath(candidate));
    if (canonicalMatches && canonicalMatches.length > 0) {
      return canonicalMatches[0];
    }
  }

  return undefined;
}

const INPUT_TEMPLATE_RE = /^\s*\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

interface OperationIndex {
  opsByPathMethod: Map<string, CollectedOperation>;
  pathsByCanonical: Map<string, string[]>;
  allPaths: Set<string>;
}

/**
 * Build the three lookup structures that both `diffIntegration` and
 * `diffQueryBindings` need to match resource endpoints against the OpenAPI
 * document: a method+path → operation map, a canonical-path → paths index
 * (for templated path matching), and a flat set of paths for exists checks.
 */
function indexOperations(openApiDoc: OpenAPIV3.Document): OperationIndex {
  const operations = collectOperations(
    openApiDoc,
    undefined,
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    { includeDeprecated: true }
  );

  const opsByPathMethod = new Map<string, CollectedOperation>();
  const pathsByCanonical = new Map<string, string[]>();
  for (const op of operations) {
    const normalizedPath = normalizePath(op.path);
    opsByPathMethod.set(`${op.method}:${normalizedPath}`, op);
    const canonicalPath = canonicalizePath(normalizedPath);
    const existing = pathsByCanonical.get(canonicalPath) ?? [];
    existing.push(normalizedPath);
    pathsByCanonical.set(canonicalPath, existing);
  }

  const allPaths = new Set(operations.map((op) => normalizePath(op.path)));

  return { opsByPathMethod, pathsByCanonical, allPaths };
}

// ---------------------------------------------------------------------------
// Core diff
// ---------------------------------------------------------------------------

export function diffIntegration(
  integration: ApiIntegrationSpec,
  resources: ApiResourceSpec[],
  openApiDoc: OpenAPIV3.Document
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const baseUrl = 'base_url' in integration.transport ? integration.transport.base_url : '';

  const { opsByPathMethod, pathsByCanonical, allPaths } = indexOperations(openApiDoc);

  for (const resource of resources) {
    const resourceName = resource.name;
    if (!resource.api) continue; // skip MCP-only resources
    const rawEndpoint = resource.api.endpoint;
    const method = (resource.api.method ?? 'GET').toUpperCase();

    // Mixed REST + GraphQL integrations commonly use a REST OpenAPI source
    // plus POST /graphql resources that cannot be represented in OpenAPI.
    if (method === 'POST' && rawEndpoint.endsWith('/graphql')) {
      continue;
    }

    const candidatePaths = getPathCandidates(rawEndpoint, baseUrl);
    const openApiPath = findMatchingPath(candidatePaths, allPaths, pathsByCanonical);

    // --- ENDPOINT_NOT_FOUND ---
    if (!openApiPath) {
      findings.push({
        severity: 'error',
        resource: resourceName,
        code: 'ENDPOINT_NOT_FOUND',
        message: `Endpoint "${candidatePaths[0]}" not found in OpenAPI spec`,
      });
      continue; // No point checking further if the path doesn't exist
    }

    // --- METHOD_MISMATCH ---
    const key = `${method}:${openApiPath}`;
    const matchedOp = opsByPathMethod.get(key);
    if (!matchedOp) {
      findings.push({
        severity: 'error',
        resource: resourceName,
        code: 'METHOD_MISMATCH',
        message: `Method ${method} not found on path "${openApiPath}" in OpenAPI spec`,
      });
      continue;
    }

    if (matchedOp.operation.deprecated) {
      findings.push({
        severity: 'warn',
        resource: resourceName,
        code: 'DEPRECATED_OPERATION',
        message: `Matched OpenAPI operation ${method} "${openApiPath}" is marked deprecated`,
      });
    }

    // --- FIELD_TYPE_MISMATCH + MISSING_FIELD ---
    const responseSchema = getResponseSchema(matchedOp.operation);
    if (responseSchema) {
      checkFieldTypes(resourceName, resource, responseSchema, findings);
      checkMissingFields(resourceName, resource, responseSchema, findings);
    }

    // --- PAGINATION_MISMATCH ---
    const parameters = resolveParameters(matchedOp);
    checkPagination(
      resourceName,
      resource,
      matchedOp.operation,
      parameters,
      responseSchema,
      findings
    );

    // --- MISSING_BODY_FIELD ---
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      checkRequestBody(resourceName, resource, matchedOp.operation, findings);
    }

    // --- RATE_LIMIT_AGGRESSIVE ---
    checkRateLimit(resourceName, integration, matchedOp.operation, findings);
  }

  return findings;
}

export function diffQueryBindings(
  integration: ApiIntegrationSpec,
  resources: ApiResourceSpec[],
  openApiDoc: OpenAPIV3.Document
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const baseUrl = 'base_url' in integration.transport ? integration.transport.base_url : '';

  const { opsByPathMethod, pathsByCanonical, allPaths } = indexOperations(openApiDoc);

  for (const resource of resources) {
    if (!resource.api || !resource.query) {
      continue;
    }

    const candidatePaths = getPathCandidates(resource.api.endpoint, baseUrl);
    const openApiPath = findMatchingPath(candidatePaths, allPaths, pathsByCanonical);
    if (!openApiPath) {
      continue;
    }

    const method = (resource.api.method ?? 'GET').toUpperCase();
    const matchedOp = opsByPathMethod.get(`${method}:${openApiPath}`);
    if (!matchedOp) {
      continue;
    }

    const openApiQueryParams = new Map(
      resolveParameters(matchedOp)
        .filter((param) => param.in === 'query')
        .map((param) => [param.name, param] as const)
    );

    for (const [fieldName, fieldQuery] of Object.entries(resource.query.filters ?? {})) {
      for (const operator of fieldQuery.operators) {
        const binding = fieldQuery.bind[operator];
        if (!binding) {
          continue;
        }

        const boundQueryParams = getQueryParamsBoundToInput(resource, binding.input);
        if (boundQueryParams.length === 0) {
          // The YAML schema guarantees binding.input resolves to an existing
          // resource input. If it isn't wired through api.query_params the
          // caller is using another sink (e.g. request_body, endpoint path)
          // which this OpenAPI drift check does not inspect — skip instead of
          // emitting a false-positive warning.
          if (!resourceInputExists(resource, binding.input)) {
            findings.push({
              severity: 'warn',
              resource: resource.name,
              field: fieldName,
              code: 'QUERY_BIND_INPUT_NOT_WIRED',
              message: `query.filters.${fieldName}.bind.${operator}.input "${binding.input}" does not match any declared resource input`,
            });
          }
          continue;
        }

        for (const queryParam of boundQueryParams) {
          checkBoundQueryParam({
            resource,
            fieldName,
            bindingPath: `query.filters.${fieldName}.bind.${operator}.input`,
            expectedType: resource.output[fieldName]?.type,
            expectedEnum: fieldQuery.enum,
            queryParam,
            openApiQueryParams,
            findings,
          });
        }
      }
    }

    if (resource.query.search) {
      const bindingInput = resource.query.search.bind.input;
      const boundQueryParams = getQueryParamsBoundToInput(resource, bindingInput);
      if (boundQueryParams.length === 0) {
        if (!resourceInputExists(resource, bindingInput)) {
          findings.push({
            severity: 'warn',
            resource: resource.name,
            code: 'QUERY_BIND_INPUT_NOT_WIRED',
            message: `query.search.bind.input "${bindingInput}" does not match any declared resource input`,
          });
        }
        continue;
      }

      for (const queryParam of boundQueryParams) {
        checkBoundQueryParam({
          resource,
          bindingPath: 'query.search.bind.input',
          expectedType: 'string',
          expectedEnum: undefined,
          queryParam,
          openApiQueryParams,
          findings,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkFieldTypes(
  resourceName: string,
  resource: ApiResourceSpec,
  responseSchema: OpenAPIV3.SchemaObject,
  findings: CheckFinding[]
): void {
  // Get the item schema (after record_path navigation)
  const itemSchema = resolveItemSchema(responseSchema, resource.extract.record_path);
  if (!itemSchema) return;

  const apiFields = flattenSchema(itemSchema);

  for (const [fieldName, fieldDef] of Object.entries(resource.output)) {
    const ourType = fieldDef.type;

    // Try to find matching field in API schema
    const apiField = apiFields[fieldName];
    if (!apiField) continue; // Field not in API — could be computed, skip

    const apiType = apiField['type'] as string | undefined;
    if (!apiType) continue;

    if (ourType !== apiType) {
      findings.push({
        severity: 'warn',
        resource: resourceName,
        field: fieldName,
        code: 'FIELD_TYPE_MISMATCH',
        message: `Field "${fieldName}" type is "${ourType}" in YAML but "${apiType}" in OpenAPI spec`,
      });
    }
  }
}

function getQueryParamsBoundToInput(resource: ApiResourceSpec, inputName: string): string[] {
  const boundQueryParams: string[] = [];
  for (const [queryParam, template] of Object.entries(resource.api?.query_params ?? {})) {
    const match = INPUT_TEMPLATE_RE.exec(template);
    if (match?.[1] === inputName) {
      boundQueryParams.push(queryParam);
    }
  }
  return boundQueryParams;
}

function resourceInputExists(resource: ApiResourceSpec, inputName: string): boolean {
  const inputs = resource.input;
  if (!inputs) {
    return false;
  }
  return inputName in inputs;
}

function checkBoundQueryParam(params: {
  resource: ApiResourceSpec;
  fieldName?: string;
  bindingPath: string;
  expectedType: string | undefined;
  expectedEnum: Array<string | number | boolean> | undefined;
  queryParam: string;
  openApiQueryParams: Map<string, OpenAPIV3.ParameterObject>;
  findings: CheckFinding[];
}): void {
  const {
    resource,
    fieldName,
    bindingPath,
    expectedType,
    expectedEnum,
    queryParam,
    openApiQueryParams,
    findings,
  } = params;

  const openApiParam = openApiQueryParams.get(queryParam);
  if (!openApiParam) {
    findings.push({
      severity: 'warn',
      resource: resource.name,
      ...(fieldName ? { field: fieldName } : {}),
      code: 'QUERY_PARAM_NOT_IN_OPENAPI',
      message: `${bindingPath} maps to "${queryParam}", but that query parameter is missing from the OpenAPI operation`,
    });
    return;
  }

  if (expectedType) {
    const openApiType = mapFieldType(
      (openApiParam.schema ?? {}) as OpenAPIV3.SchemaObject,
      queryParam
    );
    if (openApiType !== expectedType) {
      findings.push({
        severity: 'warn',
        resource: resource.name,
        ...(fieldName ? { field: fieldName } : {}),
        code: 'QUERY_PARAM_TYPE_MISMATCH',
        message: `${bindingPath} expects ${expectedType}, but OpenAPI declares "${queryParam}" as ${openApiType}`,
      });
    }
  }

  const openApiEnum = ((openApiParam.schema ?? {}) as OpenAPIV3.SchemaObject).enum;
  if (expectedEnum && openApiEnum) {
    const openApiValues = new Set(openApiEnum);
    const missingValues = expectedEnum.filter((value) => !openApiValues.has(value));
    if (missingValues.length > 0) {
      findings.push({
        severity: 'warn',
        resource: resource.name,
        ...(fieldName ? { field: fieldName } : {}),
        code: 'QUERY_PARAM_ENUM_MISMATCH',
        message: `${bindingPath} allows values not present in OpenAPI for "${queryParam}": ${missingValues
          .map((value) => JSON.stringify(value))
          .join(', ')}`,
      });
    }
  }
}

function checkMissingFields(
  resourceName: string,
  resource: ApiResourceSpec,
  responseSchema: OpenAPIV3.SchemaObject,
  findings: CheckFinding[]
): void {
  const itemSchema = resolveItemSchema(responseSchema, resource.extract.record_path);
  if (!itemSchema) return;

  const apiFields = flattenSchema(itemSchema);
  const ourFieldNames = new Set(Object.keys(resource.output));

  for (const apiFieldName of Object.keys(apiFields)) {
    if (!ourFieldNames.has(apiFieldName)) {
      findings.push({
        severity: 'info',
        resource: resourceName,
        field: apiFieldName,
        code: 'MISSING_FIELD',
        message: `Field "${apiFieldName}" exists in API response but not in resource output`,
      });
    }
  }
}

function checkPagination(
  resourceName: string,
  resource: ApiResourceSpec,
  operation: OpenAPIV3.OperationObject,
  parameters: OpenAPIV3.ParameterObject[],
  responseSchema: OpenAPIV3.SchemaObject | null,
  findings: CheckFinding[]
): void {
  const detectedPagination = detectPagination(parameters, responseSchema);
  const configuredPagination = resource.extract.pagination;
  const hasLinkHeader = responseHasHeader(operation, 'link');

  if (detectedPagination && !configuredPagination) {
    findings.push({
      severity: 'warn',
      resource: resourceName,
      code: 'PAGINATION_MISMATCH',
      message: `OpenAPI spec suggests "${detectedPagination.type}" pagination but resource has none configured`,
    });
  } else if (!detectedPagination && configuredPagination) {
    if (configuredPagination.type === 'link_header' && !hasLinkHeader) {
      return;
    }
    findings.push({
      severity: 'warn',
      resource: resourceName,
      code: 'PAGINATION_MISMATCH',
      message: `Resource configures "${configuredPagination.type}" pagination but none detected in OpenAPI spec`,
    });
  } else if (detectedPagination && configuredPagination) {
    if (detectedPagination.type !== configuredPagination.type) {
      findings.push({
        severity: 'warn',
        resource: resourceName,
        code: 'PAGINATION_MISMATCH',
        message: `Pagination type mismatch: resource uses "${configuredPagination.type}" but OpenAPI spec suggests "${detectedPagination.type}"`,
      });
    }
  }
}

function responseHasHeader(operation: OpenAPIV3.OperationObject, headerName: string): boolean {
  const normalizedHeader = headerName.toLowerCase();

  for (const response of Object.values(operation.responses ?? {})) {
    if (!response || '$ref' in response || !response.headers) {
      continue;
    }

    for (const candidateHeader of Object.keys(response.headers)) {
      if (candidateHeader.toLowerCase() === normalizedHeader) {
        return true;
      }
    }
  }

  return false;
}

function checkRequestBody(
  resourceName: string,
  resource: ApiResourceSpec,
  operation: OpenAPIV3.OperationObject,
  findings: CheckFinding[]
): void {
  const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  if (!requestBody?.content) return;

  const jsonContent = requestBody.content['application/json'];
  if (!jsonContent?.schema) return;

  const schema = jsonContent.schema as OpenAPIV3.SchemaObject;
  const requiredFields = schema.required ?? [];
  if (requiredFields.length === 0) return;

  // Check if the resource's request_body covers the required fields
  const bodyValue = resource.api?.request_body;
  const bodyKeys =
    bodyValue && typeof bodyValue === 'object' && !Array.isArray(bodyValue)
      ? new Set(Object.keys(bodyValue as Record<string, unknown>))
      : new Set<string>();

  for (const requiredField of requiredFields) {
    if (!bodyKeys.has(requiredField)) {
      findings.push({
        severity: 'error',
        resource: resourceName,
        field: requiredField,
        code: 'MISSING_BODY_FIELD',
        message: `Required request body field "${requiredField}" is missing from resource api.request_body`,
      });
    }
  }
}

function checkRateLimit(
  resourceName: string,
  integration: ApiIntegrationSpec,
  operation: OpenAPIV3.OperationObject,
  findings: CheckFinding[]
): void {
  // Check x-ratelimit-limit extension on the operation or its responses
  const specLimit = extractRateLimitExtension(operation);
  if (specLimit === null) return;

  const configuredRps = integration.transport.rate_limit?.requests_per_second;
  if (configuredRps === undefined) return;

  if (configuredRps > specLimit) {
    findings.push({
      severity: 'warn',
      resource: resourceName,
      code: 'RATE_LIMIT_AGGRESSIVE',
      message: `Configured rate limit (${configuredRps} rps) exceeds API limit (${specLimit} rps) from x-ratelimit-limit`,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveItemSchema(
  responseSchema: OpenAPIV3.SchemaObject,
  recordPath: string
): OpenAPIV3.SchemaObject | null {
  if (recordPath === '$') {
    // Top-level — if it's an array, return items schema
    if (responseSchema.type === 'array') {
      return ((responseSchema as OpenAPIV3.ArraySchemaObject).items ??
        null) as OpenAPIV3.SchemaObject | null;
    }
    return responseSchema;
  }

  // recordPath like $.data — navigate into the response schema
  const segments = recordPath.replace(/^\$\.?/, '').split('.');
  let current: OpenAPIV3.SchemaObject = responseSchema;

  for (const segment of segments) {
    if (!segment) continue;
    const props = current.properties;
    if (!props?.[segment]) return null;
    current = props[segment] as OpenAPIV3.SchemaObject;
  }

  // If we landed on an array, return its items
  if (current.type === 'array') {
    return ((current as OpenAPIV3.ArraySchemaObject).items ??
      null) as OpenAPIV3.SchemaObject | null;
  }

  return current;
}

function extractRateLimitExtension(operation: OpenAPIV3.OperationObject): number | null {
  // Check operation-level extension
  const opExt = (operation as Record<string, unknown>)['x-ratelimit-limit'];
  if (typeof opExt === 'number') return opExt;
  if (typeof opExt === 'string') {
    const parsed = Number(opExt);
    if (!Number.isNaN(parsed)) return parsed;
  }

  // Check response-level extensions
  for (const code of ['200', '201', '202', 'default']) {
    const response = (operation.responses ?? {})[code] as Record<string, unknown> | undefined;
    if (!response) continue;
    const respExt = response['x-ratelimit-limit'];
    if (typeof respExt === 'number') return respExt;
    if (typeof respExt === 'string') {
      const parsed = Number(respExt);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return null;
}
