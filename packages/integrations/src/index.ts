import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  clearCache as clearLoaderCache,
  readYamlFile,
  listSourceDirs,
  getSourceDir,
  listResourceFiles,
  getResourcePath,
} from './loader.js';
import { clearQueryResourceCatalogCache } from './query-resources/catalog.js';
import { MetaSpecSchema, SourceSpecSchema, ResourceSpecSchema } from './validate.js';

import type {
  IntegrationSummary,
  Integration,
  IntegrationResource,
  Source,
  SourceSummary,
  SourceType,
} from './types.js';

export type {
  SourceSummary,
  Source,
  SourceResource,
  SourceType,
  SourceSpec,
  IntegrationSummary,
  Integration,
  IntegrationResource,
  IntegrationType,
  QueryContextInputSpec,
  QueryFilterFieldSpec,
  QueryResourceSummary,
  QuerySearchSpec,
  MetaSpec,
  Category,
  AuthSetupEntry,
} from './types.js';
export { CATEGORIES } from './validate.js';
export {
  ActionSpecSchema,
  MetaSpecSchema,
  SourceSpecSchema,
  IntegrationSpecSchema,
  ResourceSpecSchema,
} from './validate.js';
export {
  getSourcesDir,
  getSourceDir,
  listSourceDirs,
  getIntegrationsDir,
  listActionFiles,
  listResourceFiles,
  listEntities,
  getEntityVariants,
  type EntityVariantEntry,
} from './loader.js';
export {
  filterActions,
  findAction,
  getAction,
  listActions,
  loadActions,
  type Action,
  type ActionFilter,
  type ActionLookupResult,
} from './actions.js';
export { queryResources } from './query-resources/index.js';
export {
  getQuerySpec,
  listQueryResources,
  loadQueryableResourceSpecs,
} from './query-resources/catalog.js';
export {
  QUERY_CAPABILITIES_MANIFEST_JSON_SCHEMA,
  QUERY_CAPABILITIES_MANIFEST_SCHEMA_VERSION,
  buildQueryCapabilitiesManifest,
  renderQueryCapabilitiesManifestJson,
  type QueryCapabilitiesManifest,
  type QueryCapabilityFilter,
  type QueryCapabilityIntegration,
  type QueryCapabilityOperator,
  type QueryCapabilityResource,
} from './query-resources/capabilities-manifest.js';
export {
  CATALOG_MANIFEST_JSON_SCHEMA,
  CATALOG_MANIFEST_SCHEMA_VERSION,
  type CatalogAuthSetupEntry,
  type CatalogColumn,
  type CatalogColumnType,
  type CatalogIncrementalStrategy,
  type CatalogManifest,
  type CatalogManifestSummary,
  type CatalogResource,
  type CatalogResourceTransportVariant,
  type CatalogSource,
  type CatalogSourceType,
} from './catalog/types.js';
export {
  buildCatalogManifest,
  catalogForEachParent,
  renderCatalogManifestJson,
} from './catalog/manifest.js';
export {
  QUERY_ENUM_ALIGNMENT_SCHEMA_VERSION,
  analyzeQueryEnumAlignmentResource,
  auditQueryEnumAlignment,
  renderQueryEnumAlignmentReport,
  type QueryEnumAlignmentFinding,
  type QueryEnumAlignmentReport,
} from './query-resources/enum-alignment.js';
export {
  makeQuerySource,
  FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES,
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES,
} from './query-resources/index.js';
export type {
  CalendlyEventType,
  CalendlyGetEventTypesFilter,
  CalendlyGetEventTypesInput,
  GithubBranch,
  GithubBranchesFilter,
  GithubBranchesInput,
  GithubIssue,
  GithubIssuesFilter,
  GithubIssuesInput,
  GithubPullRequest,
  GithubPullRequestsFilter,
  GithubPullRequestsInput,
  GithubPullRequestState,
  JiraIssue,
  JiraSearchIssuesInput,
  QuerySourceCapabilities,
  QuerySource,
  QuerySourceListOptions,
  StripeCustomer,
  StripeCustomersFilter,
  StripeCustomersInput,
  StripeInvoice,
  StripeInvoicesFilter,
  StripeInvoicesInput,
  StripeInvoiceStatus,
  StripePrice,
  StripePricesFilter,
  StripePricesInput,
  StripePriceType,
  StripeProduct,
  StripeProductMetadata,
  StripeProductsFilter,
  StripeProductsInput,
  StripeSubscription,
  StripeSubscriptionsFilter,
  StripeSubscriptionsInput,
  StripeSubscriptionStatusFilter,
  StripeSubscriptionStatus,
  TwilioListUsageRecordsFilter,
  TwilioListUsageRecordsInput,
  TwilioUsageRecord,
} from './query-resources/index.js';
export {
  queryIntegrationResource,
  querySourceResource,
  type QueryIntegrationResourceInput,
  type QueryIntegrationResourceOptions,
  type QueryIntegrationResourceRecord,
  type QuerySourceResourceInput,
  type QuerySourceResourceOptions,
  type QuerySourceResourceRecord,
} from './query-resources/query-integration-resource.js';

export function clearCache(): void {
  clearLoaderCache();
  clearQueryResourceCatalogCache();
}

function deriveSourceType(spec: Record<string, unknown>): SourceType {
  const transports = spec['transports'] as Array<Record<string, unknown>> | undefined;
  if (
    transports?.some(
      (transport) => transport['type'] === 'mcp_http' || transport['type'] === 'mcp_stdio'
    )
  ) {
    if (transports.length === 1) return 'mcp';
  }

  if (transports) {
    if (
      transports.every(
        (transport) => transport['type'] === 'mcp_http' || transport['type'] === 'mcp_stdio'
      )
    ) {
      return 'mcp';
    }
    return 'api';
  }

  const transport = spec['transport'] as Record<string, unknown> | undefined;
  if (transport) {
    const type = transport['type'] as string | undefined;
    if (type === 'mcp_http' || type === 'mcp_stdio') return 'mcp';
  }
  const sourceType = spec['source_type'] as string | undefined;
  if (sourceType && sourceType !== 'api') return 'db';
  return 'api';
}

export function listSources(): SourceSummary[] {
  return listSourceDirs().map((name) => {
    const dir = getSourceDir(name);
    const meta = MetaSpecSchema.parse(readYamlFile(join(dir, 'meta.yml')));
    const spec = readYamlFile(join(dir, 'source.yml')) as Record<string, unknown>;
    const resourceNames = listResourceFiles(name);
    const sourceType = deriveSourceType(spec);
    return {
      name,
      display_name: meta.display_name,
      category: meta.category,
      tags: meta.tags,
      resource_count: resourceNames.length,
      source_type: sourceType,
      integration_type: sourceType,
    };
  });
}

export function listIntegrations(): IntegrationSummary[] {
  return listSources();
}

export function getSource(name: string): Source {
  const dir = getSourceDir(name);
  const meta = MetaSpecSchema.parse(readYamlFile(join(dir, 'meta.yml')));
  const spec = SourceSpecSchema.parse(readYamlFile(join(dir, 'source.yml')));
  const resourceNames = listResourceFiles(name);
  return {
    name,
    meta,
    spec: {
      ...spec,
      auth_env_vars: [
        ...new Set([
          ...(spec.auth_env_vars ?? []),
          ...(meta.auth_setup ?? []).map((entry) => entry.env),
        ]),
      ],
    },
    resource_names: resourceNames,
  };
}

export function getIntegration(name: string): Integration {
  return getSource(name);
}

export function getResources(sourceName: string): IntegrationResource[] {
  return listResourceFiles(sourceName).map((resourceName) => getResource(sourceName, resourceName));
}

export function getResource(sourceName: string, resourceName: string): IntegrationResource {
  const resourcePath = getResourcePath(sourceName, resourceName);
  if (!existsSync(resourcePath)) {
    throw new Error(`Resource "${resourceName}" not found for source "${sourceName}"`);
  }
  const resource = ResourceSpecSchema.parse(readYamlFile(resourcePath));
  return { source_name: sourceName, integration_name: sourceName, resource };
}

/**
 * Normalized view of a single output field on a resource, suitable for agents
 * and UI code that want to discover what's available without parsing
 * integration YAML themselves.
 */
export interface ResourceField {
  name: string;
  type: string;
  description?: string;
  embedding_candidate?: boolean;
  path?: string;
}

function readResourceOutput(integration: IntegrationResource): Record<string, unknown> {
  const resource = integration.resource as { output?: unknown };
  const output = resource.output;
  return output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
}

function toResourceField(name: string, raw: unknown): ResourceField {
  const field = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = typeof field.type === 'string' ? field.type : 'unknown';
  const description = typeof field.description === 'string' ? field.description : undefined;
  const embeddingCandidate =
    typeof field.embedding_candidate === 'boolean' ? field.embedding_candidate : undefined;
  const path = typeof field.path === 'string' ? field.path : undefined;
  return { name, type, description, embedding_candidate: embeddingCandidate, path };
}

/**
 * List every output field declared by a source's resource, with the metadata
 * an agent or UI needs to drive embed configuration: type, description, and
 * whether the field is flagged as an embedding candidate.
 */
export function getResourceFields(source: string, resource: string): ResourceField[] {
  const integration = getResource(source, resource);
  return Object.entries(readResourceOutput(integration)).map(([name, raw]) =>
    toResourceField(name, raw)
  );
}

/**
 * Return the names of fields a resource flags as good targets for embedding
 * (`embedding_candidate: true` in the integration YAML). Used by agents
 * authoring `dogsled.yml` embed blocks to surface sensible defaults.
 */
export function getEmbeddingCandidates(source: string, resource: string): string[] {
  return getResourceFields(source, resource)
    .filter((field) => field.embedding_candidate === true)
    .map((field) => field.name);
}

export function searchIntegrations(query: string): IntegrationSummary[] {
  return searchSources(query);
}

export function searchSources(query: string): SourceSummary[] {
  const q = query.toLowerCase();
  return listSources().filter(
    (p) =>
      p.name.includes(q) ||
      p.display_name.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q)) ||
      p.category.includes(q)
  );
}
