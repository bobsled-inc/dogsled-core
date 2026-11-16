import { QUERY_OPERATORS, type QueryOperator } from '@bobsled-inc/extractor/extractor';

import {
  listQueryResources,
  loadQueryableResourceSpecs,
  type QueryFilterFieldSpec,
} from './catalog.js';

export const QUERY_CAPABILITIES_MANIFEST_SCHEMA_VERSION = 1;

export type QueryFilterSyntax = 'mongodb-compatible' | 'mcp' | 'sql';
export type QueryCapabilityFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'timestamp';

export interface QueryCapabilityOperator {
  operator: QueryOperator;
  bindInput: string;
  preserveDefault?: boolean;
}

export interface QueryCapabilityFilter {
  field: string;
  type: QueryCapabilityFieldType;
  description?: string;
  enum?: Array<string | number | boolean>;
  operators: QueryCapabilityOperator[];
}

export interface QueryCapabilitySearch {
  dialect: string;
  bindInput: string;
  append?: string;
  docs?: string;
  preserveDefault?: boolean;
}

export interface QueryCapabilityContextInput {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface QueryCapabilityResource {
  resource: string;
  description?: string;
  typedWrapper?: string;
  filterSyntax: QueryFilterSyntax;
  filters: QueryCapabilityFilter[];
  search?: QueryCapabilitySearch;
  contextInputs: QueryCapabilityContextInput[];
}

export interface QueryCapabilityIntegration {
  integration: string;
  resources: QueryCapabilityResource[];
}

export interface QueryCapabilitiesManifestSummary {
  integrationCount: number;
  resourceCount: number;
  filterableResourceCount: number;
  searchableResourceCount: number;
  wrapperBackedResourceCount: number;
  enumFilterCount: number;
}

export interface QueryCapabilitiesManifest {
  schemaVersion: typeof QUERY_CAPABILITIES_MANIFEST_SCHEMA_VERSION;
  filterSyntax: QueryFilterSyntax | 'mixed';
  summary: QueryCapabilitiesManifestSummary;
  llmEval: {
    status: 'not_implemented';
    requiredForShipping: true;
    note: string;
  };
  integrations: QueryCapabilityIntegration[];
}

interface QueryCapabilityBindSpec {
  input: string;
  preserve_default?: boolean;
}

interface QueryCapabilityFilterSpec {
  operators: QueryOperator[];
  enum?: Array<string | number | boolean>;
  description?: string;
  bind: Partial<Record<QueryOperator, QueryCapabilityBindSpec>>;
}

interface QueryCapabilitySearchSpec {
  dialect: string;
  bind: QueryCapabilityBindSpec;
  append?: string;
  docs?: string;
}

interface QueryCapabilityLoadedResource {
  output: Record<string, { type: string; description?: string } | undefined>;
  query: {
    filters?: Record<string, QueryCapabilityFilterSpec | undefined>;
    search?: QueryCapabilitySearchSpec;
  };
}

export const QUERY_CAPABILITIES_MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Bobsled Core Query Capabilities Manifest',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'filterSyntax', 'summary', 'llmEval', 'integrations'],
  properties: {
    schemaVersion: { const: QUERY_CAPABILITIES_MANIFEST_SCHEMA_VERSION },
    filterSyntax: { enum: ['mongodb-compatible', 'mcp', 'sql', 'mixed'] },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'integrationCount',
        'resourceCount',
        'filterableResourceCount',
        'searchableResourceCount',
        'wrapperBackedResourceCount',
        'enumFilterCount',
      ],
      properties: {
        integrationCount: { type: 'integer', minimum: 0 },
        resourceCount: { type: 'integer', minimum: 0 },
        filterableResourceCount: { type: 'integer', minimum: 0 },
        searchableResourceCount: { type: 'integer', minimum: 0 },
        wrapperBackedResourceCount: { type: 'integer', minimum: 0 },
        enumFilterCount: { type: 'integer', minimum: 0 },
      },
    },
    llmEval: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'requiredForShipping', 'note'],
      properties: {
        status: { const: 'not_implemented' },
        requiredForShipping: { const: true },
        note: { type: 'string', minLength: 1 },
      },
    },
    integrations: {
      type: 'array',
      items: { $ref: '#/$defs/integration' },
    },
  },
  $defs: {
    integration: {
      type: 'object',
      additionalProperties: false,
      required: ['integration', 'resources'],
      properties: {
        integration: { type: 'string', minLength: 1 },
        resources: {
          type: 'array',
          items: { $ref: '#/$defs/resource' },
        },
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['resource', 'filterSyntax', 'filters', 'contextInputs'],
      properties: {
        resource: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        typedWrapper: { type: 'string' },
        filterSyntax: { enum: ['mongodb-compatible', 'mcp', 'sql'] },
        filters: {
          type: 'array',
          items: { $ref: '#/$defs/filter' },
        },
        search: { $ref: '#/$defs/search' },
        contextInputs: {
          type: 'array',
          items: { $ref: '#/$defs/contextInput' },
        },
      },
    },
    filter: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'type', 'operators'],
      properties: {
        field: { type: 'string', minLength: 1 },
        type: { enum: ['string', 'integer', 'number', 'boolean', 'timestamp'] },
        description: { type: 'string' },
        enum: {
          type: 'array',
          items: {
            anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
          },
        },
        operators: {
          type: 'array',
          items: { $ref: '#/$defs/operator' },
        },
      },
    },
    operator: {
      type: 'object',
      additionalProperties: false,
      required: ['operator', 'bindInput'],
      properties: {
        operator: { enum: QUERY_OPERATORS },
        bindInput: { type: 'string', minLength: 1 },
        preserveDefault: { type: 'boolean' },
      },
    },
    search: {
      type: 'object',
      additionalProperties: false,
      required: ['dialect', 'bindInput'],
      properties: {
        dialect: { type: 'string', minLength: 1 },
        bindInput: { type: 'string', minLength: 1 },
        append: { type: 'string' },
        docs: { type: 'string' },
        preserveDefault: { type: 'boolean' },
      },
    },
    contextInput: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'type', 'required'],
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        required: { type: 'boolean' },
        description: { type: 'string' },
      },
    },
  },
} as const;

export function buildQueryCapabilitiesManifest(): QueryCapabilitiesManifest {
  const integrations = new Map<string, QueryCapabilityResource[]>();

  for (const summary of listQueryResources()) {
    const loaded = loadQueryableResourceSpecs(summary.integration, summary.resource);
    if (!loaded) {
      continue;
    }

    const resources = integrations.get(summary.integration) ?? [];
    resources.push({
      resource: summary.resource,
      ...(summary.description ? { description: summary.description } : {}),
      ...(summary.typedWrapper ? { typedWrapper: summary.typedWrapper } : {}),
      filterSyntax: summary.filterSyntax,
      filters: buildManifestFilters(summary.filters, loaded.resource),
      ...(loaded.resource.query.search
        ? { search: buildManifestSearch(loaded.resource.query.search) }
        : {}),
      contextInputs: summary.contextInputs.map((input) => ({
        name: input.name,
        type: input.type,
        required: input.required,
        ...(input.description ? { description: input.description } : {}),
      })),
    });
    integrations.set(summary.integration, resources);
  }

  const groupedIntegrations = [...integrations.entries()]
    .map(([integration, resources]) => ({
      integration,
      resources: resources.sort((left, right) => left.resource.localeCompare(right.resource)),
    }))
    .sort((left, right) => left.integration.localeCompare(right.integration));

  return {
    schemaVersion: QUERY_CAPABILITIES_MANIFEST_SCHEMA_VERSION,
    filterSyntax: deriveManifestFilterSyntax(groupedIntegrations),
    summary: buildSummary(groupedIntegrations),
    llmEval: {
      status: 'not_implemented',
      requiredForShipping: true,
      note: 'Capabilities are generated from static resource metadata. CTO #6 remains non-shipping until an LLM eval harness validates zero-shot filter/tool calls across representative integrations.',
    },
    integrations: groupedIntegrations,
  };
}

function deriveManifestFilterSyntax(
  integrations: QueryCapabilityIntegration[]
): QueryCapabilitiesManifest['filterSyntax'] {
  const syntaxes = new Set<QueryFilterSyntax>();
  for (const integration of integrations) {
    for (const resource of integration.resources) {
      syntaxes.add(resource.filterSyntax);
    }
  }
  if (syntaxes.size === 1) {
    return [...syntaxes][0]!;
  }
  return 'mixed';
}

export function renderQueryCapabilitiesManifestJson(
  manifest: QueryCapabilitiesManifest = buildQueryCapabilitiesManifest()
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildManifestFilters(
  summaryFilters: QueryFilterFieldSpec[],
  resource: QueryCapabilityLoadedResource
): QueryCapabilityFilter[] {
  const filters: QueryCapabilityFilter[] = [];

  for (const summaryFilter of summaryFilters) {
    const fieldQuery = resource.query.filters?.[summaryFilter.field];
    if (!fieldQuery) {
      continue;
    }

    filters.push({
      field: summaryFilter.field,
      type: summaryFilter.type as QueryCapabilityFieldType,
      ...(summaryFilter.description ? { description: summaryFilter.description } : {}),
      ...(summaryFilter.enum ? { enum: [...summaryFilter.enum] } : {}),
      operators: summaryFilter.operators
        .map((operator) => {
          const binding = fieldQuery.bind[operator];
          if (!binding) {
            return undefined;
          }
          return {
            operator,
            bindInput: binding.input,
            ...(binding.preserve_default ? { preserveDefault: true } : {}),
          };
        })
        .filter((operator): operator is QueryCapabilityOperator => operator !== undefined),
    });
  }

  return filters.sort((left, right) => left.field.localeCompare(right.field));
}

function buildManifestSearch(search: QueryCapabilitySearchSpec): QueryCapabilitySearch {
  return {
    dialect: search.dialect,
    bindInput: search.bind.input,
    ...(search.append ? { append: search.append } : {}),
    ...(search.docs ? { docs: search.docs } : {}),
    ...(search.bind.preserve_default ? { preserveDefault: true } : {}),
  };
}

function buildSummary(
  integrations: QueryCapabilityIntegration[]
): QueryCapabilitiesManifestSummary {
  const resources = integrations.flatMap((integration) => integration.resources);
  return {
    integrationCount: integrations.length,
    resourceCount: resources.length,
    filterableResourceCount: resources.filter((resource) => resource.filters.length > 0).length,
    searchableResourceCount: resources.filter((resource) => resource.search !== undefined).length,
    wrapperBackedResourceCount: resources.filter((resource) => resource.typedWrapper !== undefined)
      .length,
    enumFilterCount: resources.reduce(
      (count, resource) => count + resource.filters.filter((filter) => filter.enum).length,
      0
    ),
  };
}
