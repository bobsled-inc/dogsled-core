import { collectBoundInputNames } from '@bobsled-inc/extractor';
import { isSqlTransport, resolveVia, SourceSchema } from '@bobsled-inc/extractor/core';
import { QUERY_SCALAR_FIELD_TYPES } from '@bobsled-inc/extractor/extractor';
import { YAMLError } from 'yaml';
import { ZodError } from 'zod';

import {
  assertSafeName,
  listSourceDirs,
  listResourceFiles,
  readResourceYaml,
  readSourceYaml,
} from '../loader.js';
import { MetaSpecSchema, ResourceSpecSchema, SourceSpecSchema } from '../validate.js';
import { getTypedWrapperBinding } from './typed-wrapper-bindings.js';

import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  ResourceSpec,
  QueryOperator,
} from '@bobsled-inc/extractor/extractor';
import type { Source } from '@bobsled-inc/extractor/core';

export interface QueryFilterFieldSpec {
  field: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'timestamp';
  operators: QueryOperator[];
  enum?: Array<string | number | boolean>;
  description?: string;
}

export interface QuerySearchSpec {
  dialect: string;
  docs?: string;
}

export interface QueryContextInputSpec {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface QueryResourceSummary {
  source: string;
  integration: string;
  resource: string;
  description: string | undefined;
  typedWrapper?: string;
  supports: {
    filters: boolean;
    search: boolean;
  };
  filters: QueryFilterFieldSpec[];
  search: QuerySearchSpec | undefined;
  contextInputs: QueryContextInputSpec[];
  filterSyntax: 'mongodb-compatible' | 'mcp' | 'sql';
}

interface LoadedQueryResourceSpecs {
  integration: ApiIntegrationSpec;
  resource: ApiResourceSpec & { query: NonNullable<ApiResourceSpec['query']> };
}

const querySummaryCache = new Map<string, QueryResourceSummary | null>();
let queryResourceCatalogCache: QueryResourceSummary[] | undefined;

function cloneQueryResourceSummary(summary: QueryResourceSummary): QueryResourceSummary {
  return {
    ...summary,
    supports: { ...summary.supports },
    filters: summary.filters.map((filter) => ({
      ...filter,
      operators: [...filter.operators],
      ...(filter.enum ? { enum: [...filter.enum] } : {}),
    })),
    search: summary.search ? { ...summary.search } : undefined,
    contextInputs: summary.contextInputs.map((input) => ({ ...input })),
  };
}

export function listQueryResources(): QueryResourceSummary[] {
  if (queryResourceCatalogCache) {
    return queryResourceCatalogCache.map(cloneQueryResourceSummary);
  }

  const summaries: QueryResourceSummary[] = [];

  for (const sourceName of listSourceDirs()) {
    for (const resourceName of listResourceFiles(sourceName)) {
      const summary = buildCachedQuerySummary(sourceName, resourceName);
      if (summary) {
        summaries.push(summary);
      }
    }
  }

  queryResourceCatalogCache = summaries;
  return summaries.map(cloneQueryResourceSummary);
}

export function getQuerySpec(
  integrationName: string,
  resourceName: string
): QueryResourceSummary | undefined {
  const summary = buildCachedQuerySummary(integrationName, resourceName);
  return summary ? cloneQueryResourceSummary(summary) : undefined;
}

/** Loading a paid spec does not authorize a request. The query runtime still requires approval. */
export function loadQueryableResourceSpecs(
  sourceName: string,
  resourceName: string,
  options: { includeBillable?: boolean } = {}
): LoadedQueryResourceSpecs | undefined {
  assertSafeName(sourceName, 'source name');
  assertSafeName(resourceName, 'resource name');

  const rawSource = readSourceYaml(sourceName, 'source.yml');
  const rawResource = readResourceYaml(sourceName, resourceName);

  const spec = SourceSpecSchema.parse(rawSource);
  const meta = MetaSpecSchema.parse(readSourceYaml(sourceName, 'meta.yml'));
  const source = SourceSchema.parse({
    ...spec,
    auth_env_vars: [
      ...new Set([
        ...(spec.auth_env_vars ?? []),
        ...(meta.auth_setup ?? []).map((entry) => entry.env),
      ]),
    ],
  });
  const resource = {
    ...ResourceSpecSchema.parse(rawResource),
    integration: sourceName,
  };
  const integration = toLegacyApiIntegration(source, getResourceVia(resource));
  if (!integration) {
    return undefined;
  }

  if (
    !('transport' in integration) ||
    (integration.transport.type !== 'http' &&
      integration.transport.type !== 'mcp_http' &&
      integration.transport.type !== 'mcp_stdio')
  ) {
    return undefined;
  }

  if (
    !('query' in resource) ||
    !resource.query ||
    (!resource.api && !resource.tool) ||
    (resource.billing && !options.includeBillable)
  ) {
    return undefined;
  }

  return {
    integration,
    resource: resource as LoadedQueryResourceSpecs['resource'],
  };
}

function buildQuerySummary(
  sourceName: string,
  resourceName: string,
  loaded: LoadedQueryResourceSpecs
): QueryResourceSummary {
  const { integration, resource } = loaded;
  const typedWrapper = getTypedWrapperBinding(sourceName, resourceName);
  const boundInputs = collectBoundInputNames(resource.query);
  const filters: QueryFilterFieldSpec[] = [];
  for (const [fieldName, fieldQuery] of Object.entries(resource.query.filters ?? {})) {
    const outputField = resource.output[fieldName];
    if (!outputField || !isQueryableFieldType(outputField.type)) {
      continue;
    }

    const description = fieldQuery.description ?? outputField.description;
    filters.push({
      field: fieldName,
      type: outputField.type,
      operators: [...fieldQuery.operators],
      ...(fieldQuery.enum ? { enum: [...fieldQuery.enum] } : {}),
      ...(description ? { description } : {}),
    });
  }

  const contextInputs = Object.entries(resource.input)
    .filter(([name]) => !boundInputs.has(name))
    .map(([name, field]) => ({
      name,
      type: field.type,
      required: field.required === true,
      ...(field.description ? { description: field.description } : {}),
    }));

  return {
    source: sourceName,
    integration: sourceName,
    resource: resourceName,
    description: resource.description,
    ...(typedWrapper ? { typedWrapper: typedWrapper.clientSurface } : {}),
    supports: {
      filters: filters.length > 0,
      search: resource.query.search !== undefined,
    },
    filters,
    search: resource.query.search
      ? {
          dialect: resource.query.search.dialect,
          ...(resource.query.search.docs ? { docs: resource.query.search.docs } : {}),
        }
      : undefined,
    contextInputs,
    filterSyntax: getFilterSyntax(integration),
  };
}

function toLegacyApiIntegration(
  source: Source,
  via: string | undefined
): ApiIntegrationSpec | undefined {
  const transport = resolveVia(source, via);
  if (isSqlTransport(transport)) {
    return undefined;
  }

  const { id: _id, ...legacyTransport } = transport as Record<string, unknown>;
  return {
    spec_version: '1',
    type: 'integration',
    name: source.name,
    auth_env_vars: source.auth_env_vars,
    ...(source.description ? { description: source.description } : {}),
    transport: legacyTransport as ApiIntegrationSpec['transport'],
  } as ApiIntegrationSpec;
}

function getResourceVia(resource: ResourceSpec): string | undefined {
  return 'via' in resource ? resource.via : undefined;
}

function getFilterSyntax(integration: ApiIntegrationSpec): QueryResourceSummary['filterSyntax'] {
  switch (integration.transport.type) {
    case 'http':
      return 'mongodb-compatible';
    case 'mcp_http':
    case 'mcp_stdio':
      return 'mcp';
    default:
      return 'sql';
  }
}

function isQueryableFieldType(type: string): type is QueryFilterFieldSpec['type'] {
  return QUERY_SCALAR_FIELD_TYPES.has(type);
}

function isInvalidResourceSpecError(error: unknown): boolean {
  return error instanceof ZodError || error instanceof YAMLError;
}

function buildCachedQuerySummary(
  integrationName: string,
  resourceName: string
): QueryResourceSummary | undefined {
  const cacheKey = `${integrationName}.${resourceName}`;
  if (querySummaryCache.has(cacheKey)) {
    const cachedSummary = querySummaryCache.get(cacheKey);
    return cachedSummary ? cloneQueryResourceSummary(cachedSummary) : undefined;
  }

  let loaded: LoadedQueryResourceSpecs | undefined;
  try {
    loaded = loadQueryableResourceSpecs(integrationName, resourceName);
  } catch (error) {
    // Only swallow spec/YAML validation errors so one malformed resource
    // doesn't hide the rest of the catalog from agents/UI. Filesystem or
    // other runtime failures must still propagate; strict callers also
    // see errors via getQuerySpec().
    if (isInvalidResourceSpecError(error)) {
      querySummaryCache.set(cacheKey, null);
      return undefined;
    }
    throw error;
  }

  if (!loaded) {
    querySummaryCache.set(cacheKey, null);
    return undefined;
  }

  const summary = buildQuerySummary(integrationName, resourceName, loaded);
  querySummaryCache.set(cacheKey, summary);
  return cloneQueryResourceSummary(summary);
}

export function clearQueryResourceCatalogCache(): void {
  querySummaryCache.clear();
  queryResourceCatalogCache = undefined;
}
