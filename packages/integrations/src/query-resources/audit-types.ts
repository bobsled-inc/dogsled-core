import type { HttpApiResourceSpec, QueryOperator } from '@bobsled-inc/extractor/extractor';

export type { HttpApiResourceSpec };
export type ScalarFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'timestamp';

export const QUERY_RESOURCE_AUDIT_SCHEMA_VERSION = 1;

export const QUERY_RESOURCE_AUDIT_BUCKETS = [
  'wrapper_backed',
  'discovery_only',
  'query_ready',
  'query_ready_after_scalar_cleanup',
  'search_ready_needs_semantic_review',
  'search_ready_semantically_blocked',
  'blocked_by_billing',
  'not_a_fit',
  'not_a_fit_non_http',
] as const;

export type QueryResourceAuditBucket = (typeof QUERY_RESOURCE_AUDIT_BUCKETS)[number];

export type QueryResourceAuditReasonCode =
  | 'existing_query_wrapper'
  | 'existing_query_discovery'
  | 'billing_metadata_present'
  | 'non_http_transport'
  | 'non_api_integration'
  | 'mcp_tool_resource'
  | 'missing_http_api_resource'
  | 'servicenow_sysparm_query_contains_orderby'
  | 'front_q_query_object_requires_structured_filters'
  | 'generated_filter_candidates'
  | 'scalar_cleanup_required'
  | 'unresolved_scalar_cleanup_blockers'
  | 'search_like_input'
  | 'no_safe_query_or_search_candidate';

export type QueryResourceAuditBlockerReason =
  | 'input_not_scalar'
  | 'output_not_scalar'
  | 'incompatible_scalar_types';

export interface QueryResourceCandidateFilter {
  field: string;
  type: ScalarFieldType;
  operators: QueryOperator[];
  bind: Partial<Record<QueryOperator, string>>;
  enum?: string[];
  description?: string;
}

export type QueryResourceSearchDialect =
  | 'front_q_query_object'
  | 'jira_jql'
  | 'provider_search'
  | 'servicenow_sysparm_query';

export interface QueryResourceCandidateSearch {
  input: string;
  dialect: QueryResourceSearchDialect;
  description?: string;
}

export interface QueryResourceAuditBlocker {
  input: string;
  field: string;
  operator: QueryOperator;
  reason: QueryResourceAuditBlockerReason;
  inputType: string;
  outputType: string;
  message: string;
}

export interface SuggestedQueryFilter {
  operators: QueryOperator[];
  bind: Partial<Record<QueryOperator, { input: string }>>;
  enum?: string[];
  description?: string;
}

export interface SuggestedQuerySearch {
  dialect: QueryResourceSearchDialect;
  bind: {
    input: string;
  };
}

export interface SuggestedQuerySpec {
  filters?: Record<string, SuggestedQueryFilter>;
  search?: SuggestedQuerySearch;
}

export interface QueryResourceAuditEntry {
  integration: string;
  resource: string;
  bucket: QueryResourceAuditBucket;
  reasonCodes: QueryResourceAuditReasonCode[];
  typedWrapper?: string;
  candidateFilters?: QueryResourceCandidateFilter[];
  candidateSearch?: QueryResourceCandidateSearch;
  suggestedQuery?: SuggestedQuerySpec;
  blockers?: QueryResourceAuditBlocker[];
}

export interface QueryResourceAuditSummary {
  totalResources: number;
  queryResources: {
    total: number;
    wrapperBacked: number;
    discoveryOnly: number;
  };
  buckets: Record<QueryResourceAuditBucket, number>;
}

export interface QueryResourceAuditReport {
  schemaVersion: typeof QUERY_RESOURCE_AUDIT_SCHEMA_VERSION;
  summary: QueryResourceAuditSummary;
  entries: QueryResourceAuditEntry[];
}

export interface GeneratedFilterAnalysis {
  candidateFilters: QueryResourceCandidateFilter[];
  blockers: QueryResourceAuditBlocker[];
  suggestedQuery: SuggestedQuerySpec | undefined;
}
