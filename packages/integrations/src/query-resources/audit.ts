import { resolveVia, SourceSchema } from '@bobsled-inc/extractor/core';
import type {
  ApiIntegrationSpec,
  IntegrationSpec,
  ResourceSpec,
} from '@bobsled-inc/extractor/extractor';
import type { Source } from '@bobsled-inc/extractor/core';

import { listSourceDirs, listResourceFiles, readResourceYaml, readSourceYaml } from '../loader.js';
import { ResourceSpecSchema, SourceSpecSchema } from '../validate.js';
import { analyzeGeneratedFilters } from './audit-candidates.js';
import { collectHttpParamBodyInputRefs } from './audit-input-refs.js';
import {
  getCandidateSearch,
  getFrontSearchBlock,
  getServiceNowSearchBlock,
} from './audit-search.js';
import {
  QUERY_RESOURCE_AUDIT_BUCKETS,
  QUERY_RESOURCE_AUDIT_SCHEMA_VERSION,
  type HttpApiResourceSpec,
  type QueryResourceAuditBucket,
  type QueryResourceAuditEntry,
  type QueryResourceAuditReasonCode,
  type QueryResourceAuditReport,
  type QueryResourceAuditSummary,
} from './audit-types.js';
import { listQueryResources } from './catalog.js';
import { typedWrapperBindings } from './typed-wrapper-bindings.js';

export {
  QUERY_RESOURCE_AUDIT_BUCKETS,
  QUERY_RESOURCE_AUDIT_SCHEMA_VERSION,
  type QueryResourceAuditBlocker,
  type QueryResourceAuditBlockerReason,
  type QueryResourceAuditBucket,
  type QueryResourceAuditEntry,
  type QueryResourceAuditReasonCode,
  type QueryResourceAuditReport,
  type QueryResourceAuditSummary,
  type QueryResourceCandidateFilter,
  type QueryResourceCandidateSearch,
  type SuggestedQueryFilter,
  type SuggestedQuerySpec,
} from './audit-types.js';

export function auditQueryResources(): QueryResourceAuditReport {
  const querySummaries = listQueryResources();
  const querySummariesByKey = new Map(
    querySummaries.map((summary) => [resourceKey(summary.integration, summary.resource), summary])
  );
  const typedWrapperByKey = new Map(
    typedWrapperBindings.map((binding) => [
      resourceKey(binding.integration, binding.resource),
      binding.clientSurface,
    ])
  );

  const entries: QueryResourceAuditEntry[] = [];

  for (const integrationName of listSourceDirs()) {
    const source = SourceSchema.parse(
      SourceSpecSchema.parse(readSourceYaml(integrationName, 'source.yml'))
    );

    for (const resourceName of listResourceFiles(integrationName)) {
      const rawResource = readResourceYaml(integrationName, resourceName) as Record<
        string,
        unknown
      >;
      const resource = {
        ...ResourceSpecSchema.parse(rawResource),
        integration: integrationName,
      };
      const integration = toLegacyIntegration(source, resource);
      const key = resourceKey(integrationName, resourceName);
      const querySummary = querySummariesByKey.get(key);
      const typedWrapper = typedWrapperByKey.get(key);

      if (querySummary) {
        if (!hasHttpApiResource(resource)) {
          entries.push(
            classifyNonQueryResource(integrationName, resourceName, integration, resource)
          );
          continue;
        }
        const generatedFilters = analyzeGeneratedFilters(resource);
        const hasUnresolvedBlockers = generatedFilters.blockers.length > 0;
        entries.push({
          integration: integrationName,
          resource: resourceName,
          bucket: typedWrapper ? 'wrapper_backed' : 'discovery_only',
          reasonCodes: [
            typedWrapper ? 'existing_query_wrapper' : 'existing_query_discovery',
            ...(hasUnresolvedBlockers ? (['unresolved_scalar_cleanup_blockers'] as const) : []),
          ],
          ...(typedWrapper ? { typedWrapper } : {}),
          ...(hasUnresolvedBlockers ? { blockers: generatedFilters.blockers } : {}),
        });
        continue;
      }

      entries.push(classifyNonQueryResource(integrationName, resourceName, integration, resource));
    }
  }

  entries.sort(compareEntries);

  return {
    schemaVersion: QUERY_RESOURCE_AUDIT_SCHEMA_VERSION,
    summary: buildSummary(entries, querySummaries.length),
    entries,
  };
}

function classifyNonQueryResource(
  integrationName: string,
  resourceName: string,
  integration: IntegrationSpec,
  resource: ResourceSpec
): QueryResourceAuditEntry {
  if (hasBilling(resource)) {
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: 'blocked_by_billing',
      reasonCodes: ['billing_metadata_present'],
      ...candidateMetadataForBillableResource(resource),
    };
  }

  const nonHttpReason = getNonHttpReason(integration, resource);
  if (nonHttpReason) {
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: 'not_a_fit_non_http',
      reasonCodes: [nonHttpReason],
    };
  }

  const apiResource = resource as HttpApiResourceSpec;
  const boundInputs = collectHttpParamBodyInputRefs(apiResource.api);

  const serviceNowSearchBlock = getServiceNowSearchBlock(integrationName, apiResource);
  if (serviceNowSearchBlock) {
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: 'search_ready_semantically_blocked',
      reasonCodes: ['servicenow_sysparm_query_contains_orderby'],
      candidateSearch: serviceNowSearchBlock,
    };
  }

  const frontSearchBlock = getFrontSearchBlock(integrationName, apiResource);
  if (frontSearchBlock) {
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: 'search_ready_semantically_blocked',
      reasonCodes: ['front_q_query_object_requires_structured_filters'],
      candidateSearch: frontSearchBlock,
    };
  }

  const generatedFilters = analyzeGeneratedFilters(apiResource, boundInputs);
  if (generatedFilters.candidateFilters.length > 0 || generatedFilters.blockers.length > 0) {
    const needsCleanup = generatedFilters.blockers.length > 0;
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: needsCleanup ? 'query_ready_after_scalar_cleanup' : 'query_ready',
      reasonCodes: needsCleanup
        ? ['generated_filter_candidates', 'scalar_cleanup_required']
        : ['generated_filter_candidates'],
      ...(generatedFilters.candidateFilters.length > 0
        ? { candidateFilters: generatedFilters.candidateFilters }
        : {}),
      ...(generatedFilters.suggestedQuery
        ? { suggestedQuery: generatedFilters.suggestedQuery }
        : {}),
      ...(generatedFilters.blockers.length > 0 ? { blockers: generatedFilters.blockers } : {}),
    };
  }

  const candidateSearch = getCandidateSearch(apiResource, boundInputs);
  if (candidateSearch) {
    return {
      integration: integrationName,
      resource: resourceName,
      bucket: 'search_ready_needs_semantic_review',
      reasonCodes: ['search_like_input'],
      candidateSearch,
      suggestedQuery: {
        search: {
          dialect: candidateSearch.dialect,
          bind: {
            input: candidateSearch.input,
          },
        },
      },
    };
  }

  return {
    integration: integrationName,
    resource: resourceName,
    bucket: 'not_a_fit',
    reasonCodes: ['no_safe_query_or_search_candidate'],
  };
}

function buildSummary(
  entries: QueryResourceAuditEntry[],
  queryResourceCount: number
): QueryResourceAuditSummary {
  const buckets = Object.fromEntries(
    QUERY_RESOURCE_AUDIT_BUCKETS.map((bucket) => [bucket, 0])
  ) as Record<QueryResourceAuditBucket, number>;

  for (const entry of entries) {
    buckets[entry.bucket] = (buckets[entry.bucket] ?? 0) + 1;
  }

  return {
    totalResources: entries.length,
    queryResources: {
      total: queryResourceCount,
      wrapperBacked: buckets.wrapper_backed,
      discoveryOnly: buckets.discovery_only,
    },
    buckets,
  };
}

function resourceKey(integrationName: string, resourceName: string): string {
  return `${integrationName}.${resourceName}`;
}

function compareEntries(left: QueryResourceAuditEntry, right: QueryResourceAuditEntry): number {
  return resourceKey(left.integration, left.resource).localeCompare(
    resourceKey(right.integration, right.resource)
  );
}

function hasBilling(resource: ResourceSpec): boolean {
  return 'billing' in resource && resource.billing !== undefined;
}

function isApiIntegration(integration: IntegrationSpec): integration is ApiIntegrationSpec {
  return (
    (!('source_type' in integration) || integration.source_type === 'api') &&
    'transport' in integration &&
    integration.transport.type === 'http'
  );
}

function hasHttpApiResource(resource: ResourceSpec): resource is HttpApiResourceSpec {
  return 'api' in resource && resource.api !== undefined && !resource.tool;
}

function getNonHttpReason(
  integration: IntegrationSpec,
  resource: ResourceSpec
): QueryResourceAuditReasonCode | undefined {
  if ('tool' in resource && resource.tool) {
    return 'mcp_tool_resource';
  }

  if (!hasHttpApiResource(resource)) {
    return 'missing_http_api_resource';
  }

  if (!isApiIntegration(integration)) {
    if ('source_type' in integration) {
      return 'non_api_integration';
    }
    return 'non_http_transport';
  }

  return undefined;
}

function candidateMetadataForBillableResource(
  resource: ResourceSpec
): Pick<QueryResourceAuditEntry, 'candidateFilters' | 'candidateSearch' | 'blockers'> {
  if (!hasHttpApiResource(resource)) {
    return {};
  }

  const filterAnalysis = analyzeGeneratedFilters(resource);
  const candidateSearch = getCandidateSearch(resource);

  return {
    ...(filterAnalysis.candidateFilters.length > 0
      ? { candidateFilters: filterAnalysis.candidateFilters }
      : {}),
    ...(candidateSearch ? { candidateSearch } : {}),
    ...(filterAnalysis.blockers.length > 0 ? { blockers: filterAnalysis.blockers } : {}),
  };
}

function toLegacyIntegration(source: Source, resource: ResourceSpec): IntegrationSpec {
  const transport = resolveVia(source, getResourceVia(resource));

  const { id: _id, ...legacyTransport } = transport as Record<string, unknown>;
  return {
    spec_version: '1',
    type: 'integration',
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    transport: legacyTransport as ApiIntegrationSpec['transport'],
  } as IntegrationSpec;
}

function getResourceVia(resource: ResourceSpec): string | undefined {
  return 'via' in resource ? resource.via : undefined;
}
