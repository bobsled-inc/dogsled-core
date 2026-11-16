/**
 * Public Resource operations for server hosts.
 *
 * This entry point stays separate from the Dogsled package root so callers that
 * only need project metadata do not load the Resource execution runtime.
 */
export {
  CUSTOM_TOKEN_EXPIRY_BUFFER_MS,
  lookupResource,
  queryResource,
  resolveCustomTokenAuthorization,
  sharesCustomToken,
  planQueryFanOut,
  queryResourceFanOut,
  QueryFanOutError,
  QUERY_FAN_OUT_CONTRACT_VERSION,
} from '@bobsled-inc/extractor/resources';
export type {
  AuthorizeBillableResource,
  BillableResourceAuthorizationContext,
  CustomTokenAuthorization,
  CustomTokenGrant,
  CustomTokenStore,
  CustomTokenStoreRequest,
  LookupResourceLimits,
  LookupResourceOptions,
  PrefixedQueryOperator,
  QueryFilterInput,
  QueryFilterOperators,
  QueryFilterValue,
  QueryRateLimitInfo,
  QueryResourceOptions,
  QueryResourceResult,
  QueryScalarValue,
  QueryValue,
  PlanQueryFanOutOptions,
  QueryFanOutBinding,
  QueryFanOutCounts,
  QueryFanOutLimits,
  QueryFanOutPhase,
  QueryFanOutPlan,
  QueryFanOutPlanEdge,
  QueryFanOutPlanNode,
  QueryResourceFanOutOptions,
  QueryResourceFanOutResult,
  ResolveCustomTokenAuthorizationOptions,
} from '@bobsled-inc/extractor/resources';

export { getResourceCapabilities, isLookupOnlyApiResource } from '@bobsled-inc/extractor/extractor';
export type {
  IntegrationSpec,
  LookupOnlyApiResourceSpec,
  ResourceCapabilities,
  ResourceSpec,
} from '@bobsled-inc/extractor/extractor';
