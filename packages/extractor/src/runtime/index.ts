/**
 * Public library API for @bobsled-inc/extractor.
 */

export { RateLimiter, RateLimitTimeoutError } from './rate-limiter.js';
export { ExtractorClient } from './client.js';
export type { InterpolationMappedValues } from '../framework/runtime/index.js';
export { paginate } from './pagination.js';
export { mapResponse, extractJsonPath } from './response-mapper.js';
export type { MapResponseOptions } from './response-mapper.js';
export { createFanOutContext } from './for-each.js';
export type { FanOutContext } from './for-each.js';
export {
  loadState,
  saveState,
  getStreamBookmark,
  setStreamBookmark,
  mergeDurableBookmark,
  FileStateStore,
} from './state.js';
export { BatchWriter } from './batch-writer.js';
export type { BatchWriterOptions, FinalizedBatch } from './batch-writer.js';
export { Emitter } from './emitter.js';
export { ControlLogger } from './control.js';
export { lookupResource } from './lookup.js';
export type { LookupResourceLimits, LookupResourceOptions } from './lookup.js';
export { queryResource, collectBoundInputNames } from './query/index.js';
export {
  QUERY_FAN_OUT_CONTRACT_VERSION,
  QueryFanOutError,
  planQueryFanOut,
  queryResourceFanOut,
} from './query/fan-out.js';
export { buildApiIntegrationSpec } from './api-integration-spec.js';
export type {
  AuthorizeBillableResource,
  BillableResourceAuthorizationContext,
} from './billable-authorization.js';
export { TransportClientPool, resolveApiTransport } from './transport-client-pool.js';
export type { ExtractRuntimeClient, ResolvedTransportClient } from './transport-client-pool.js';
export { McpExtractorClient } from './mcp-client.js';
export type {
  McpClientOptions,
  McpCallToolOptions,
  McpToolInfo,
  RuntimeClient,
} from './mcp-client.js';
export { paginateMcpTool } from './mcp-pagination.js';
export type { McpPageFetcher } from './mcp-pagination.js';
export {
  classifyMcpError,
  isConnectionError,
  withRetry,
  ExtractorTransientError,
  ExtractorConfigError,
  ExtractorDataError,
} from './errors.js';
export type { ExtractorError } from './errors.js';
export { SFTP_ERROR_CODES } from './clients/sftp-errors.js';
export type { SftpErrorCode } from './clients/sftp-errors.js';
export { mapFields } from './activate/field-mapper.js';
export { runActivateDispatcher } from './activate/dispatcher.js';
export type {
  ActivateDispatchOptions,
  ActivationSummary,
  ActivationResult,
  ActivationRecord,
} from './activate/dispatcher.js';
export { emitActivationRecord, emitActivationMetric } from './activate/result-emitter.js';
export { computeIdempotencyKey } from './activate/idempotency.js';
export type { ActivationErrorCode } from './activate/retry.js';
export { parseCursorValue } from './time.js';
export { compareCursors, maxCursor, inferCursorKind, resolveCursorKind } from './cursor.js';
export type { CursorKind } from './cursor.js';
export type { StateStore, StreamBookmark } from './state.js';
export { ExtractorStateSchema } from '../schemas/state.js';
export type { ExtractorState } from '../types/index.js';
export type {
  PrefixedQueryOperator,
  QueryFilterInput,
  QueryFilterOperators,
  QueryFilterValue,
  QueryRateLimitInfo,
  QueryResourceOptions,
  QueryResourceResult,
  QueryScalarValue,
  QueryValue,
} from './query/index.js';
export type {
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
} from './query/fan-out.js';
export {
  quoteIdentifier,
  buildFullyQualifiedTable,
  buildWhereClause,
  buildExtractionQuery,
} from './warehouse-query-builder.js';
export type {
  Dialect,
  ChangeTrackingConfig,
  QueryBuilderConfig,
  BuildResult,
} from './warehouse-query-builder.js';
export { mapColumnType } from './warehouse-type-mapper.js';
// Note: extractResource lives in commands/extract.ts (CLI orchestration layer).
// Import it directly from '@bobsled-inc/extractor/commands/extract' for programmatic use.
export type { ExtractResourceParams, ExtractOptions } from '../commands/extract.js';
