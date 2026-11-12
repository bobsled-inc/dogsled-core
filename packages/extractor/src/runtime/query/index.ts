import { QUERY_OPERATORS } from '../../framework/extractor/query-spec.js';

import { ExtractorClient } from '../client.js';
import { classifyMcpError, ExtractorConfigError, toExtractorMcpRuntimeError } from '../errors.js';
import { McpExtractorClient } from '../mcp-client.js';
import { RateLimiter } from '../rate-limiter.js';
import { paginateMcpTool } from '../mcp-pagination.js';
import { paginate } from '../pagination.js';
import { extractRecords, mapOutput, withOutputContext } from '../response-mapper.js';
import { buildApiIntegrationSpec } from '../api-integration-spec.js';
import { compileQueryToMcpArgs } from './mcp-backend.js';
import {
  hasFanOutOutputOrigin,
  isSourceSpec,
  isSqlTransport,
  resolveVia,
} from '../../framework/core/index.js';
import { appendSearchValue } from '../../framework/query/index.js';
import type { AuthorizeBillableResource } from '../billable-authorization.js';
import type { CustomTokenStore } from '../../framework/runtime/index.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  buildTargetedFanOutContext,
  normalizeForEachConfig,
  type FanOutContext,
} from '../for-each.js';

import type { InputFieldDefinition } from '../../framework/core/index.js';
import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  HttpApiResourceSpec,
  IntegrationSpec,
  QueryOperator,
  QuerySpec,
  ResourceSpec,
} from '../../types/index.js';

const INTERNAL_PAGE_LIMIT = 50;
const MAX_QUERY_LIMIT = 10_000;

// RFC 7232 permits ETag values to be any quoted-string (weakly or strongly
// validated). Keep the accepted character set tight (printable ASCII minus
// double-quote / backslash) and cap the payload at 200 chars so we never
// persist a pathological upstream value.
const ETAG_PATTERN = /^(W\/)?"[!#-~]{0,200}"$/;

function assertValidEtag(etag: string): void {
  if (!ETAG_PATTERN.test(etag)) {
    throw new ExtractorConfigError(
      `queryResource() etag must match RFC 7232 (W/)"..." with printable ASCII and length <= 200.`
    );
  }
}

export type QueryScalarValue = string | number | boolean;
export type QueryArrayValue = QueryScalarValue[];
export type QueryValue = QueryScalarValue | QueryArrayValue;
export type PrefixedQueryOperator = `$${QueryOperator}`;
export type QueryFilterOperators = Partial<
  Record<QueryOperator | PrefixedQueryOperator, QueryValue>
>;
export type QueryFilterValue = QueryScalarValue | QueryFilterOperators;
export type QueryFilterInput = Record<string, QueryFilterValue>;

export interface QueryResourceOptions {
  integration: IntegrationSpec;
  resource: ResourceSpec;
  input?: Record<string, unknown>;
  filter?: QueryFilterInput;
  search?: string;
  limit?: number;
  etag?: string;
  /**
   * Optional secret map injected into the transport auth resolution. When
   * omitted the client falls back to `process.env`, preserving the default
   * CLI behavior. Library callers can pass resolved secrets without mutating
   * the host process environment.
   *
   * Injected values satisfy both `${{ secrets.<NAME> }}` and `${{ env.<NAME> }}`
   * templates, so credentials resolve regardless of which namespace the catalog
   * transport auth uses (catalog integrations conventionally use `env.<NAME>`).
   * Any `env.<NAME>` not present in this map still falls back to `process.env`.
   */
  secrets?: Record<string, string | undefined>;
  declaredSecretNames?: readonly string[];
  /** Cooperative cancellation for HTTP/MCP requests and pagination. */
  signal?: AbortSignal;
  /**
   * Internal graph-execution context. Supplying it is additive and lets the
   * fan-out executor preserve mapped ancestor outputs without changing the
   * public single-resource semantics.
   */
  fanOutContext?: FanOutContext;
  /** Called immediately before every provider attempt, including retries. */
  beforeRequestAttempt?: () => void;
  /** @internal Shared by graph execution so sibling queries use one token bucket. */
  rateLimiter?: RateLimiter;
  /** @internal Fan-out disables speculative cursor work so limits remain fail-closed. */
  mcpPrefetchCursor?: boolean;
  /** @internal Fan-out owns its MCP client, so connect can use the aggregate signal. */
  mcpConnectWithCallerSignal?: boolean;
  /** @internal Adds resolved transport credentials to the error redaction set. */
  onResolvedSecret?: (value: string) => void;
  /** @internal Canonical for_each destinations that graph execution may bind directly. */
  fanOutBoundInputNames?: readonly string[];
  /** Called synchronously for every mapped record before it is retained. */
  onMappedRecord?: (record: Record<string, unknown>) => void;
  /** @internal Fan-out may stop pagination once descendant demand is satisfied. */
  shouldStopAfterMappedRecord?: (
    record: Record<string, unknown>
  ) => boolean | void | Promise<boolean | void>;
  /** @internal Fan-out can consume ancestor rows without retaining them. */
  collectMappedRecords?: boolean;
  /** @internal Aggregate fan-out budgets replace the flat-query page safety cap. */
  skipUnboundedPageLimit?: boolean;
  /** Required approval callback for a billable Resource. Calls fail closed when absent or denied. */
  authorizeBillable?: AuthorizeBillableResource;
  /** Host store that shares minted custom tokens across workers. */
  customTokenStore?: CustomTokenStore;
}

export interface QueryRateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: string;
}

export interface QueryResourceResult<TRecord> {
  records: TRecord[];
  limitReached: boolean;
  requestCount: number;
  etag?: string;
  notModified?: boolean;
  rateLimit?: QueryRateLimitInfo;
}

type NormalizedQueryFilter = Record<string, Partial<Record<QueryOperator, QueryValue>>>;

type QueryResourceTarget = ApiResourceSpec;

/** @internal Create one limiter per resolved transport for bounded graph execution. */
export function createQueryRateLimiter(
  integration: IntegrationSpec,
  resource: ApiResourceSpec
): RateLimiter | undefined {
  const resolved = resolveQueryTransport(integration, resource);
  if (resolved.kind === 'sql') return undefined;
  const transport = resolved.integration.transport;
  if (transport.type === 'http') {
    const rateLimit = transport.rate_limit;
    const retry = transport.retry;
    return new RateLimiter({
      ...(rateLimit?.requests_per_second !== undefined
        ? { requestsPerSecond: rateLimit.requests_per_second }
        : {}),
      ...(rateLimit?.burst !== undefined ? { burst: rateLimit.burst } : {}),
      ...(retry?.retry_on !== undefined ? { retryOn: retry.retry_on } : {}),
      ...(retry?.max_retries !== undefined ? { maxRetries: retry.max_retries } : {}),
      ...(retry?.backoff !== undefined ? { backoff: retry.backoff } : {}),
      ...(retry?.retry_after_header !== undefined
        ? { retryAfterHeader: retry.retry_after_header }
        : {}),
    });
  }
  const rateLimit = 'rate_limit' in transport ? transport.rate_limit : undefined;
  return rateLimit
    ? new RateLimiter({
        requestsPerSecond: rateLimit.requests_per_second,
        burst: rateLimit.burst,
      })
    : undefined;
}

/** @internal Stable identity for Resources that resolve to the same physical transport. */
export function queryRateLimiterKey(
  integration: IntegrationSpec,
  resource: ApiResourceSpec
): string {
  const resolved = resolveQueryTransport(integration, resource);
  return resolved.kind === 'sql'
    ? 'sql'
    : JSON.stringify([resolved.integration.name, resolved.integration.transport]);
}

/**
 * Execute an API resource and return the decoded records.
 *
 * Resources without a query block may be listed without a filter or search. The
 * caller must use a bounded limit or the internal page safety cap applies.
 *
 * `TRecord` is a caller-supplied type parameter and is **not validated at
 * runtime**. Records are shaped by `mapOutput(withOutputContext(...),
 * resource.output)` and then cast to `TRecord`. The wrapper under
 * `@bobsled-inc/integrations` is responsible for hand-writing a record
 * interface that matches the resource's `output` block; a mismatched
 * `TRecord` will surface as runtime errors at the call site rather than
 * inside this function.
 */
export async function queryResource<TRecord = Record<string, unknown>>(
  options: QueryResourceOptions
): Promise<QueryResourceResult<TRecord>> {
  options.signal?.throwIfAborted();
  const { input, search } = options;
  const resource = asQueryResourceTarget(options.resource);
  const queryTransport = resolveQueryTransport(options.integration, resource);

  if (resource.billing) {
    const approved = await options.authorizeBillable?.({
      operation: 'query',
      resource,
      billing: resource.billing,
    });
    if (approved !== true) {
      throw new ExtractorConfigError(
        `Resource "${resource.name}" is billable and requires explicit authorization before query.`
      );
    }
  }

  if (options.filter && search !== undefined) {
    throw new ExtractorConfigError('queryResource() accepts either filter or search, not both.');
  }

  if (options.etag !== undefined) {
    assertValidEtag(options.etag);
  }

  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new ExtractorConfigError('queryResource() limit must be a positive integer.');
    }
    if (options.limit > MAX_QUERY_LIMIT) {
      throw new ExtractorConfigError(
        `queryResource() limit must not exceed ${MAX_QUERY_LIMIT}. Lower the limit or add a more selective filter.`
      );
    }
  }

  const normalizedFilter = normalizeFilterInput(options.filter);
  validateQueryInput(resource, normalizedFilter, search);

  const boundInputNames = resource.query
    ? collectBoundInputNames(resource.query)
    : new Set<string>();
  const preservedDefaultInputNames = resource.query
    ? collectPreservedDefaultInputNames(resource.query)
    : new Set<string>();
  const allowedFanOutBindings = new Set(options.fanOutBoundInputNames ?? []);
  if (input) {
    for (const name of Object.keys(input)) {
      if (boundInputNames.has(name) && !allowedFanOutBindings.has(name)) {
        throw new ExtractorConfigError(
          `queryResource() input cannot override bound query input "${name}". Use filter or search instead.`
        );
      }
    }
  }
  const operationInput = cloneInputSchema(
    resource.input,
    boundInputNames,
    preservedDefaultInputNames
  );
  const boundInputs = resource.query
    ? translateQueryToInput(resource.query, normalizedFilter, search)
    : {};
  const mergedInput = {
    ...(input ?? {}),
    ...boundInputs,
  };
  const fanOutContext = options.fanOutContext ?? resolveQueryFanOutContext(resource, mergedInput);

  if (queryTransport.kind === 'sql') {
    throw new ExtractorConfigError(
      `queryResource() does not execute SQL transports for resource "${resource.name}". Use the warehouse/materializer query path instead.`
    );
  }

  if (queryTransport.kind === 'mcp') {
    if (options.etag !== undefined) {
      throw new ExtractorConfigError('queryResource() etag is only supported for HTTP resources.');
    }
    return executeMcpQueryResource<TRecord>({
      options,
      integration: queryTransport.integration,
      resource,
      baseInput: input ?? {},
      fanOutContext,
    });
  }

  const integration = queryTransport.integration;
  const httpResource = resource as HttpApiResourceSpec;
  const etagEligible = options.etag !== undefined && isWholeResourceEtagEligible(resource);

  // Injected secrets feed both the `secrets.*` and `env.*` interpolation
  // namespaces. Every catalog transport writes its auth as `${{ env.<NAME> }}`
  // (the extract convention, where the credential is a real process.env var),
  // but the source-query/live path injects credentials per request via
  // `secrets`. Feeding them to `env` too lets request-scoped credentials
  // satisfy those templates without a caller mutating process.env. Per-key
  // fallback to process.env (for non-injected, non-blocked env vars) is
  // preserved by resolveNamedValue.
  const client = new ExtractorClient({
    integration,
    ...(options.secrets !== undefined
      ? {
          secrets: options.secrets,
          env: options.secrets,
          declaredSecretNames: options.declaredSecretNames,
        }
      : {}),
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    beforeRequestAttempt: options.beforeRequestAttempt,
    onResolvedSecret: options.onResolvedSecret,
    ...(options.customTokenStore ? { customTokenStore: options.customTokenStore } : {}),
  });

  try {
    await client.connect();
    options.signal?.throwIfAborted();
    const records: TRecord[] = [];
    let requestCount = 0;
    let latestEtag: string | undefined;
    let latestRateLimit: QueryRateLimitInfo | undefined;
    let attemptedPageCount = 0;

    for await (const page of paginate(
      integration,
      httpResource,
      async (queryParams, url) => {
        attemptedPageCount += 1;
        if (
          options.limit === undefined &&
          !options.skipUnboundedPageLimit &&
          attemptedPageCount > INTERNAL_PAGE_LIMIT
        ) {
          throw new ExtractorConfigError(
            `queryResource() exceeded the unbounded page safety cap of ${INTERNAL_PAGE_LIMIT} pages. Pass limit <= ${MAX_QUERY_LIMIT} or add a more selective filter.`
          );
        }
        requestCount += 1;
        const response = await client.request({
          operation: {
            api: httpResource.api,
            input: operationInput,
          },
          input: mergedInput,
          queryParams,
          url,
          headers:
            etagEligible && requestCount === 1 ? { 'If-None-Match': options.etag! } : undefined,
          allowStatus: etagEligible && requestCount === 1 ? [304] : undefined,
          signal: options.signal,
          beforeRequestAttempt: options.beforeRequestAttempt,
        });
        const responseEtag =
          etagEligible && response.status === 304
            ? options.etag
            : (response.headers.get('etag') ?? undefined);
        // Drop non-conforming upstream ETags instead of storing garbage into
        // the metadata row and sending it back as If-None-Match next time.
        latestEtag =
          responseEtag !== undefined && ETAG_PATTERN.test(responseEtag) ? responseEtag : undefined;
        latestRateLimit = readRateLimitHeaders(response.headers) ?? latestRateLimit;
        return response;
      },
      // Query mode suppresses pagination warnings: callers bound results via
      // `limit` (or the internal page cap), not the normalization warning channel.
      async () => undefined,
      options.limit === undefined ? undefined : { recordLimit: options.limit }
    )) {
      options.signal?.throwIfAborted();
      if (page.status === 304) {
        return {
          records,
          limitReached: false,
          requestCount,
          ...(latestEtag !== undefined ? { etag: latestEtag } : {}),
          notModified: true,
          ...(latestRateLimit !== undefined ? { rateLimit: latestRateLimit } : {}),
        };
      }

      const rawRecords = page.records ?? extractRecords(page.data, resource);
      for (const rawRecord of rawRecords) {
        const mapped = mapOutput(
          withOutputContext(rawRecord, mergedInput),
          resource.output,
          undefined,
          fanOutContext
        ) as TRecord;
        options.onMappedRecord?.(mapped as Record<string, unknown>);
        const demandSatisfied = await options.shouldStopAfterMappedRecord?.(
          mapped as Record<string, unknown>
        );
        if (options.collectMappedRecords !== false) records.push(mapped);
        if (demandSatisfied === true) {
          return {
            records,
            limitReached: true,
            requestCount,
            ...(latestEtag !== undefined ? { etag: latestEtag } : {}),
            ...(latestRateLimit !== undefined ? { rateLimit: latestRateLimit } : {}),
          };
        }
        if (options.limit !== undefined && records.length >= options.limit) {
          return {
            records,
            limitReached: true,
            requestCount,
            ...(latestEtag !== undefined ? { etag: latestEtag } : {}),
            ...(latestRateLimit !== undefined ? { rateLimit: latestRateLimit } : {}),
          };
        }
      }
    }

    return {
      records,
      limitReached: false,
      requestCount,
      ...(latestEtag !== undefined ? { etag: latestEtag } : {}),
      ...(latestRateLimit !== undefined ? { rateLimit: latestRateLimit } : {}),
    };
  } finally {
    await client.close();
  }
}

function isWholeResourceEtagEligible(resource: QueryResourceTarget): boolean {
  const pagination = resource.extract?.pagination;
  return pagination === undefined || pagination.type === 'none';
}

function readRateLimitHeaders(headers: Headers): QueryRateLimitInfo | undefined {
  const limit = parseHeaderNumber(
    headers.get('x-ratelimit-limit') ?? headers.get('ratelimit-limit')
  );
  const remaining = parseHeaderNumber(
    headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining')
  );
  const reset = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset') ?? undefined;

  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { reset } : {}),
  };
}

function parseHeaderNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function executeMcpQueryResource<TRecord>(params: {
  options: QueryResourceOptions;
  integration: ApiIntegrationSpec;
  resource: QueryResourceTarget;
  baseInput: Record<string, unknown>;
  fanOutContext: FanOutContext;
}): Promise<QueryResourceResult<TRecord>> {
  const { options, integration, resource, baseInput, fanOutContext } = params;
  if (!resource.tool) {
    throw new ExtractorConfigError(
      'queryResource() selected an MCP transport for a non-MCP resource.'
    );
  }

  // See the HTTP path above: injected secrets satisfy `${{ env.<NAME> }}` auth
  // templates so MCP source-query credentials stay request-scoped too.
  const client = new McpExtractorClient({
    integration,
    ...(options.secrets !== undefined
      ? {
          secrets: options.secrets,
          env: options.secrets,
          declaredSecretNames: options.declaredSecretNames,
        }
      : {}),
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    beforeRequestAttempt: options.beforeRequestAttempt,
    connectWithCallerSignal: options.mcpConnectWithCallerSignal,
    onResolvedSecret: options.onResolvedSecret,
  });
  try {
    try {
      await client.connect(options.signal);
    } catch (error) {
      throw toExtractorMcpRuntimeError(classifyMcpError(error), options.signal);
    }
    options.signal?.throwIfAborted();
    const records: TRecord[] = [];
    let requestCount = 0;
    let attemptedPageCount = 0;
    const compiledInput = compileQueryToMcpArgs({
      resource,
      input: baseInput,
      filter: options.filter,
      search: options.search,
    });

    for await (const page of paginateMcpTool(
      resource,
      async (argumentOverrides) => {
        attemptedPageCount += 1;
        if (
          options.limit === undefined &&
          !options.skipUnboundedPageLimit &&
          attemptedPageCount > INTERNAL_PAGE_LIMIT
        ) {
          throw new ExtractorConfigError(
            `queryResource() exceeded the unbounded page safety cap of ${INTERNAL_PAGE_LIMIT} pages. Pass limit <= ${MAX_QUERY_LIMIT} or add a more selective filter.`
          );
        }
        requestCount += 1;
        return client.callTool({
          operation: {
            input: resource.input,
            tool: resource.tool!,
          },
          input: compiledInput,
          argumentOverrides,
          signal: options.signal,
          beforeRequestAttempt: options.beforeRequestAttempt,
        });
      },
      async () => undefined,
      { prefetchCursor: options.mcpPrefetchCursor !== false }
    )) {
      options.signal?.throwIfAborted();
      const rawRecords = page.records ?? extractRecords(page.data, resource);
      for (const rawRecord of rawRecords) {
        const mapped = mapOutput(
          withOutputContext(rawRecord, compiledInput),
          resource.output,
          undefined,
          fanOutContext
        ) as TRecord;
        options.onMappedRecord?.(mapped as Record<string, unknown>);
        const demandSatisfied = await options.shouldStopAfterMappedRecord?.(
          mapped as Record<string, unknown>
        );
        if (options.collectMappedRecords !== false) records.push(mapped);
        if (demandSatisfied === true) {
          return { records, limitReached: true, requestCount };
        }
        if (options.limit !== undefined && records.length >= options.limit) {
          return { records, limitReached: true, requestCount };
        }
      }
    }

    return { records, limitReached: false, requestCount };
  } finally {
    await client.close();
  }
}

function resolveQueryFanOutContext(
  resource: QueryResourceTarget,
  inputs: Record<string, unknown>
): FanOutContext {
  if (!hasFanOutOutputOrigin(resource.output)) return EMPTY_FAN_OUT_CONTEXT;
  const forEach = normalizeForEachConfig(resource.extract.for_each);
  if (!forEach) {
    throw new ExtractorConfigError(
      `queryResource() cannot resolve contextual outputs for "${resource.name}" without extract.for_each.`
    );
  }
  try {
    return buildTargetedFanOutContext(resource, forEach, inputs);
  } catch (error) {
    throw new ExtractorConfigError(
      `queryResource() cannot prove fan-out context for "${resource.name}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

type QueryTransportResolution =
  | { kind: 'http'; integration: ApiIntegrationSpec }
  | { kind: 'mcp'; integration: ApiIntegrationSpec }
  | { kind: 'sql' };

function resolveQueryTransport(
  integration: IntegrationSpec,
  resource: QueryResourceTarget
): QueryTransportResolution {
  if (isSourceSpec(integration)) {
    const transport = resolveVia(integration, resource.via);
    if (isSqlTransport(transport)) {
      return { kind: 'sql' };
    }

    const apiIntegration = buildApiIntegrationSpec(integration, transport);
    if (transport.type === 'http') {
      if (!resource.api) {
        throw new ExtractorConfigError(
          'queryResource() selected an HTTP transport for an MCP resource.'
        );
      }
      return { kind: 'http', integration: apiIntegration };
    }

    if (resource.api) {
      throw new ExtractorConfigError(
        'queryResource() selected an MCP transport for an HTTP resource.'
      );
    }
    return { kind: 'mcp', integration: apiIntegration };
  }

  if (!('transport' in integration)) {
    throw new ExtractorConfigError(
      `queryResource() cannot resolve a transport for integration "${integration.name}".`
    );
  }

  if (integration.transport.type.startsWith('sql_')) {
    return { kind: 'sql' };
  }

  if (integration.transport.type === 'http') {
    if (!resource.api) {
      throw new ExtractorConfigError(
        'queryResource() selected an HTTP transport for an MCP resource.'
      );
    }
    return { kind: 'http', integration };
  }

  if (resource.api) {
    throw new ExtractorConfigError(
      'queryResource() selected an MCP transport for an HTTP resource.'
    );
  }
  return { kind: 'mcp', integration };
}

function asQueryResourceTarget(resource: ResourceSpec): QueryResourceTarget {
  if ('source' in resource || 'replication' in resource) {
    throw new ExtractorConfigError('queryResource() does not support warehouse resources.');
  }

  if (!resource.api && !resource.tool) {
    throw new ExtractorConfigError('queryResource() requires an HTTP API or MCP tool resource.');
  }

  return resource;
}

function normalizeFilterInput(filter: QueryFilterInput | undefined): NormalizedQueryFilter {
  if (!filter) {
    return Object.create(null) as NormalizedQueryFilter;
  }

  const normalized = Object.create(null) as NormalizedQueryFilter;

  for (const [fieldName, rawValue] of Object.entries(filter)) {
    if (isQueryScalar(rawValue)) {
      const scalarOperators = Object.create(null) as Partial<Record<QueryOperator, QueryValue>>;
      scalarOperators.eq = rawValue;
      normalized[fieldName] = scalarOperators;
      continue;
    }

    if (!isOperatorObject(rawValue)) {
      throw new ExtractorConfigError(
        `Query filter "${fieldName}" must be a scalar or an operator object.`
      );
    }

    const operatorEntries = Object.entries(rawValue);
    if (operatorEntries.length === 0) {
      throw new ExtractorConfigError(`Query filter "${fieldName}" must not be empty.`);
    }

    const normalizedOperators = Object.create(null) as Partial<Record<QueryOperator, QueryValue>>;
    for (const [rawOperator, operatorValue] of operatorEntries) {
      const operator = normalizeOperatorName(fieldName, rawOperator, normalizedOperators);
      if (operator === 'in') {
        if (!isQueryScalarArray(operatorValue)) {
          throw new ExtractorConfigError(
            `Query filter "${fieldName}" operator "${rawOperator}" must use a non-empty scalar array value.`
          );
        }
        normalizedOperators[operator] = operatorValue;
        continue;
      }

      if (!isQueryScalar(operatorValue)) {
        throw new ExtractorConfigError(
          `Query filter "${fieldName}" operator "${rawOperator}" must use a scalar value.`
        );
      }
      normalizedOperators[operator] = operatorValue;
    }

    normalized[fieldName] = normalizedOperators;
  }

  return normalized;
}

function normalizeOperatorName(
  fieldName: string,
  rawOperator: string,
  normalizedOperators: Partial<Record<QueryOperator, QueryValue>>
): QueryOperator {
  const unprefixedOperator = rawOperator.startsWith('$') ? rawOperator.slice(1) : rawOperator;
  if (!isQueryOperator(unprefixedOperator)) {
    throw new ExtractorConfigError(
      `Query filter "${fieldName}" uses unsupported operator "${rawOperator}". Supported operators: ${formatOperators(
        QUERY_OPERATORS
      )}.`
    );
  }

  if (normalizedOperators[unprefixedOperator] !== undefined) {
    throw new ExtractorConfigError(
      `Query filter "${fieldName}" cannot mix "${unprefixedOperator}" and "$${unprefixedOperator}".`
    );
  }

  return unprefixedOperator;
}

function validateQueryInput(
  resource: QueryResourceTarget,
  filter: NormalizedQueryFilter,
  search: string | undefined
): void {
  if (search !== undefined && !resource.query?.search) {
    throw new ExtractorConfigError(
      `Resource "${resource.name}" does not declare query.search support.`
    );
  }

  for (const [fieldName, operators] of Object.entries(filter)) {
    const filterSpec = resource.query?.filters?.[fieldName];
    if (!filterSpec) {
      throw new ExtractorConfigError(
        `Resource "${resource.name}" does not declare query filter "${fieldName}".`
      );
    }

    const outputField = resource.output[fieldName];
    if (!outputField) {
      throw new ExtractorConfigError(
        `Query filter "${fieldName}" does not map to an output field on "${resource.name}".`
      );
    }

    for (const [operator, value] of Object.entries(operators) as Array<
      [QueryOperator, QueryValue]
    >) {
      if (!filterSpec.operators.includes(operator)) {
        throw new ExtractorConfigError(
          `Query filter "${fieldName}" does not support operator "${operator}". Supported operators: ${formatOperators(
            filterSpec.operators
          )}.`
        );
      }

      if (filterSpec.enum && !doesValueMatchEnum(value, filterSpec.enum)) {
        throw new ExtractorConfigError(
          `Query filter "${fieldName}" must use one of: ${filterSpec.enum
            .map((entry) => JSON.stringify(entry))
            .join(', ')}.`
        );
      }

      if (!isCompatibleQueryValue(outputField.type, value)) {
        throw new ExtractorConfigError(
          operator === 'in'
            ? `Query filter "${fieldName}" operator "${operator}" expects an array of ${outputField.type} values.`
            : `Query filter "${fieldName}" operator "${operator}" expects a ${outputField.type} value.`
        );
      }
    }
  }
}

export function translateQueryToInput(
  query: QuerySpec,
  filter: NormalizedQueryFilter,
  search: string | undefined
): Record<string, QueryValue> {
  const inputOverrides = Object.create(null) as Record<string, QueryValue>;

  for (const [fieldName, operators] of Object.entries(filter)) {
    const filterSpec = query.filters?.[fieldName];
    if (!filterSpec) {
      continue;
    }

    for (const [operator, value] of Object.entries(operators) as Array<
      [QueryOperator, QueryValue]
    >) {
      const binding = filterSpec.bind[operator];
      if (!binding) {
        continue;
      }
      inputOverrides[binding.input] = value;
    }
  }

  if (search !== undefined && query.search) {
    inputOverrides[query.search.bind.input] = appendSearchValue(search, query.search.append);
  }

  return inputOverrides;
}

export function collectBoundInputNames(query: QuerySpec): Set<string> {
  const names = new Set<string>();

  for (const filterSpec of Object.values(query.filters ?? {})) {
    for (const binding of Object.values(filterSpec.bind)) {
      if (binding) {
        names.add(binding.input);
      }
    }
  }

  if (query.search) {
    names.add(query.search.bind.input);
  }

  return names;
}

/** Inputs that this concrete filter/search request would populate through query bindings. */
export function collectQueryOverrideInputNames(
  query: QuerySpec | undefined,
  filter: QueryFilterInput | undefined,
  search: string | undefined
): Set<string> {
  if (!query) return new Set();
  return new Set(Object.keys(translateQueryToInput(query, normalizeFilterInput(filter), search)));
}

function collectPreservedDefaultInputNames(query: QuerySpec): Set<string> {
  const names = new Set<string>();

  for (const filterSpec of Object.values(query.filters ?? {})) {
    for (const binding of Object.values(filterSpec.bind)) {
      if (binding?.preserve_default) {
        names.add(binding.input);
      }
    }
  }

  if (query.search?.bind.preserve_default) {
    names.add(query.search.bind.input);
  }

  return names;
}

function cloneInputSchema(
  input: Record<string, InputFieldDefinition>,
  boundInputs: Set<string>,
  preservedDefaultInputs: Set<string>
): Record<string, InputFieldDefinition> {
  const clonedEntries = Object.entries(input).map(([name, field]) => {
    const nextField = { ...field };
    if (boundInputs.has(name) && !preservedDefaultInputs.has(name)) {
      delete nextField.default;
    }
    return [name, nextField];
  });

  return Object.fromEntries(clonedEntries);
}

function isCompatibleQueryValue(outputType: string, value: QueryValue): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => isCompatibleQueryValue(outputType, entry));
  }

  switch (outputType) {
    case 'string':
    case 'timestamp':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function doesValueMatchEnum(value: QueryValue, enumValues: QueryScalarValue[]): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => enumValues.includes(entry));
  }
  return enumValues.includes(value);
}

function isOperatorObject(value: QueryFilterValue): value is QueryFilterOperators {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQueryOperator(value: string): value is QueryOperator {
  return (QUERY_OPERATORS as readonly string[]).includes(value);
}

function isQueryScalar(value: unknown): value is QueryScalarValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isQueryScalarArray(value: unknown): value is QueryArrayValue {
  return Array.isArray(value) && value.length > 0 && value.every(isQueryScalar);
}

function formatOperators(operators: readonly QueryOperator[]): string {
  return operators.map((operator) => `$${operator}`).join(', ');
}
