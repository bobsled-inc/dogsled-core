import {
  EMPTY_FAN_OUT_CONTEXT,
  assertCompleteFanOutContext,
  extendFanOutContext,
  getContextProjectionValues,
  type FanOutContext,
} from '../for-each.js';
import { evaluateResolvedPredicate, resolvePredicate } from '../predicates.js';
import {
  collectBoundInputNames,
  collectQueryOverrideInputNames,
  createQueryRateLimiter,
  queryRateLimiterKey,
  queryResource,
  type QueryResourceResult,
} from './index.js';
import { QUERY_FAN_OUT_CONTRACT_VERSION, QueryFanOutError } from './fan-out-contract.js';
import { asApiResource, planFailure, planQueryFanOut, requiredInputs } from './fan-out-plan.js';
import {
  addQueryFanOutRedactionValues,
  assertQueryFanOutInput as assertInput,
  assertRequestedLimit,
  assertSupportedExecutionTransport,
  awaitWithSignal,
  collectRedactionSecrets,
  combinedSignal,
  emptyQueryFanOutCounts as emptyCounts,
  queryFanOutErrorFrom as errorFrom,
  resolveQueryFanOutLimits as resolveLimits,
  runFailFast,
} from './fan-out-support.js';

import type { AuthorizeBillableResource } from '../billable-authorization.js';
import type { ApiResourceSpec } from '../../types/index.js';
import type {
  QueryFanOutBinding,
  QueryFanOutPhase,
  QueryFanOutPlan,
  QueryFanOutPlanEdge,
  QueryResourceFanOutOptions,
  QueryResourceFanOutResult,
} from './fan-out-contract.js';

export { QUERY_FAN_OUT_CONTRACT_VERSION, QueryFanOutError } from './fan-out-contract.js';
export { planQueryFanOut } from './fan-out-plan.js';
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
} from './fan-out-contract.js';

function preservesQueryDefault(resource: ApiResourceSpec, inputName: string): boolean {
  const query = resource.query;
  if (!query) return false;

  for (const filter of Object.values(query.filters ?? {})) {
    for (const binding of Object.values(filter?.bind ?? {})) {
      if (binding?.input === inputName && binding.preserve_default) {
        return true;
      }
    }
  }

  return query.search?.bind.input === inputName && query.search.bind.preserve_default === true;
}

function withInputDefaults(
  resource: ApiResourceSpec,
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  const boundInputNames = resource.query
    ? collectBoundInputNames(resource.query)
    : new Set<string>();
  for (const [name, definition] of Object.entries(resource.input)) {
    if (input[name] !== undefined) {
      resolved[name] = input[name];
    } else if (
      definition.default !== undefined &&
      (!boundInputNames.has(name) || preservesQueryDefault(resource, name))
    ) {
      resolved[name] = definition.default;
    }
  }
  return resolved;
}

interface WorkItem {
  inputs: Record<string, unknown>;
  context: FanOutContext;
  ordinal: number;
}

interface WorkResult {
  work: WorkItem;
  records: Record<string, unknown>[];
  limitReached: boolean;
}

type MappedRecordHandler = (
  record: Record<string, unknown>
) => void | boolean | Promise<void | boolean>;

interface ExecutionErrorContext {
  resource?: string;
  parentResource?: string;
  binding?: QueryFanOutBinding;
  parentOrdinal?: number;
}

/** Execute a planned Resource chain without extraction state or durable writes. */
export async function queryResourceFanOut<TRecord = Record<string, unknown>>(
  options: QueryResourceFanOutOptions
): Promise<QueryResourceFanOutResult<TRecord>> {
  const executionStartedAt = Date.now();
  if (options.mode !== 'targeted' && options.mode !== 'fan_out') {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_INVALID_MODE',
      kind: 'validation',
      phase: 'plan',
      target: options.target,
      message: 'queryResourceFanOut() mode must be "targeted" or "fan_out".',
      counts: emptyCounts(),
      correlationId: options.correlationId,
    });
  }
  assertRequestedLimit(options.limit, options.target, options.correlationId);
  const suppliedPlanConcurrency = options.plan
    ? Math.max(1, ...options.plan.edges.map((edge) => edge.effectiveConcurrency))
    : undefined;
  let expectedPlan: QueryFanOutPlan;
  try {
    expectedPlan = planQueryFanOut({
      resources: options.resources,
      target: options.target,
      maxConcurrency:
        options.maxConcurrency ?? suppliedPlanConcurrency ?? options.limits?.maxConcurrency,
      maxDepth: options.maxDepth,
      maxResources: options.maxResources,
    });
  } catch (error) {
    if (error instanceof QueryFanOutError && options.correlationId && !error.correlationId) {
      throw new QueryFanOutError({
        code: error.code,
        kind: error.kind,
        phase: error.phase,
        target: error.target,
        message: error.message,
        counts: error.counts,
        retryable: error.retryable,
        correlationId: options.correlationId,
        ...(error.resource ? { resource: error.resource } : {}),
        ...(error.parentResource ? { parentResource: error.parentResource } : {}),
        ...(error.binding ? { binding: error.binding } : {}),
        ...(error.parentOrdinal !== undefined ? { parentOrdinal: error.parentOrdinal } : {}),
        ...(error.providerStatus !== undefined ? { providerStatus: error.providerStatus } : {}),
      });
    }
    throw error;
  }
  const plan = options.plan ?? expectedPlan;
  if (plan.contractVersion !== QUERY_FAN_OUT_CONTRACT_VERSION || plan.target !== options.target) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_PLAN_VERSION',
      kind: 'validation',
      phase: 'plan',
      target: options.target,
      message: 'The supplied query fan-out plan is not compatible with this target.',
      counts: emptyCounts(),
      correlationId: options.correlationId,
    });
  }
  if (options.plan && JSON.stringify(options.plan) !== JSON.stringify(expectedPlan)) {
    throw new QueryFanOutError({
      code: 'QUERY_FAN_OUT_PLAN_MISMATCH',
      kind: 'validation',
      phase: 'plan',
      target: options.target,
      message: 'The supplied query fan-out plan does not match the supplied Resource definitions.',
      counts: emptyCounts(),
      correlationId: options.correlationId,
    });
  }
  const limits = resolveLimits(options.limits, options.target, options.correlationId);
  const counts = emptyCounts();
  const redactionSecrets = collectRedactionSecrets(options.integration, options.secrets, [
    options.input,
    options.filter,
    options.search,
    ...options.resources.map((resource) =>
      'api' in resource ? resource.api?.request_body : undefined
    ),
  ]);
  const addRedactionValue = (value: unknown): void =>
    addQueryFanOutRedactionValues(redactionSecrets, value);
  const updateDuration = (): void => {
    counts.durationMs = Date.now() - executionStartedAt;
  };
  const suppliedByName = new Map(options.resources.map((resource) => [resource.name, resource]));
  const byName = new Map(
    plan.topologicalOrder.map((name) => {
      const resource = suppliedByName.get(name);
      if (!resource) {
        return planFailure(
          options.target,
          `Resource "${name}" is not present in the supplied graph.`
        );
      }
      return [name, asApiResource(resource, options.target)] as const;
    })
  );
  const root = byName.get(plan.topologicalOrder[0]!);
  if (!root) {
    return planFailure(options.target, 'The plan root is not present in the supplied Resources.');
  }
  const suppliedInput = options.input ?? {};
  const rateLimiters = new Map<string, ReturnType<typeof createQueryRateLimiter>>();
  const rateLimiterFor = (resource: ApiResourceSpec) => {
    const key = queryRateLimiterKey(options.integration, resource);
    if (!rateLimiters.has(key)) {
      rateLimiters.set(key, createQueryRateLimiter(options.integration, resource));
    }
    return rateLimiters.get(key);
  };
  const input = withInputDefaults(root, suppliedInput);
  const abort = new AbortController();
  const signal = AbortSignal.any([
    combinedSignal(options.signal, abort),
    AbortSignal.timeout(limits.deadlineMs),
  ]);
  const boundedAuthorization: AuthorizeBillableResource | undefined = options.authorizeBillable
    ? async (context) =>
        await awaitWithSignal(Promise.resolve(options.authorizeBillable!(context)), signal)
    : undefined;
  const deadline = Date.now() + limits.deadlineMs;
  const checkStop = (context: ExecutionErrorContext = {}): void => {
    updateDuration();
    if (signal.aborted) {
      if (signal.reason instanceof QueryFanOutError) throw signal.reason;
      const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
      throw new QueryFanOutError({
        code: timedOut ? 'QUERY_FAN_OUT_DEADLINE' : 'QUERY_FAN_OUT_CANCELLED',
        kind: timedOut ? 'timeout' : 'cancellation',
        phase: timedOut ? 'limit' : 'cancelled',
        target: plan.target,
        message: timedOut ? 'Query fan-out exceeded its deadline.' : 'Query fan-out was cancelled.',
        counts,
        cause: signal.reason,
        correlationId: options.correlationId,
        ...context,
      });
    }
    if (Date.now() > deadline) {
      throw new QueryFanOutError({
        code: 'QUERY_FAN_OUT_DEADLINE',
        kind: 'timeout',
        phase: 'limit',
        target: plan.target,
        message: 'Query fan-out exceeded its deadline.',
        counts,
        correlationId: options.correlationId,
        ...context,
      });
    }
  };
  const attempt = (context: ExecutionErrorContext = {}): void => {
    checkStop(context);
    counts.providerAttempts += 1;
    counts.requestCount = counts.providerAttempts;
    if (counts.providerAttempts > limits.maxProviderAttempts) {
      const error = new QueryFanOutError({
        code: 'QUERY_FAN_OUT_REQUEST_LIMIT',
        kind: 'validation',
        phase: 'limit',
        target: plan.target,
        message: 'Query fan-out exceeded its provider-attempt budget.',
        counts,
        correlationId: options.correlationId,
        ...context,
      });
      abort.abort(error);
      throw error;
    }
  };
  const recordMapped = (
    resource: ApiResourceSpec,
    record: Record<string, unknown>,
    context: ExecutionErrorContext
  ): void => {
    counts.mappedBytes += Buffer.byteLength(JSON.stringify(record));
    if (resource.name === plan.target) {
      counts.targetRows += 1;
      counts.resultCount = counts.targetRows;
    }
    if (counts.targetRows > limits.maxTargetRows || counts.mappedBytes > limits.maxMappedBytes) {
      const error = new QueryFanOutError({
        code: 'QUERY_FAN_OUT_RESULT_LIMIT',
        kind: 'validation',
        phase: 'limit',
        target: plan.target,
        resource: resource.name,
        message: 'Query fan-out exceeded its target-row or mapped-byte budget.',
        counts,
        correlationId: options.correlationId,
        ...context,
      });
      abort.abort(error);
      throw error;
    }
  };

  try {
    for (const name of plan.topologicalOrder) {
      assertSupportedExecutionTransport(
        options.integration,
        byName.get(name)!,
        plan.target,
        counts,
        options.correlationId
      );
    }
    if (options.mode === 'targeted') {
      const target = byName.get(plan.target)!;
      const targetInput = withInputDefaults(target, suppliedInput);
      counts.maxConcurrency = 1;
      assertInput(
        requiredInputs(target.input),
        targetInput,
        plan.target,
        target.name,
        counts,
        options.mode,
        options.correlationId
      );
      const targetEdge = plan.edges.at(-1);
      if (targetEdge) {
        assertInput(
          targetEdge.bindings.map((binding) => binding.input),
          targetInput,
          plan.target,
          target.name,
          counts,
          options.mode,
          options.correlationId
        );
        const overriddenInputs = collectQueryOverrideInputNames(
          target.query,
          options.filter,
          options.search
        );
        const overwrittenBinding = targetEdge.bindings.find((binding) =>
          overriddenInputs.has(binding.input)
        );
        if (overwrittenBinding) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_BINDING_OVERRIDE',
            kind: 'validation',
            phase: 'plan',
            target: plan.target,
            resource: target.name,
            parentResource: targetEdge.parent,
            binding: overwrittenBinding,
            message: `Query filter/search cannot override fan-out input "${target.name}.${overwrittenBinding.input}".`,
            counts,
            correlationId: options.correlationId,
          });
        }
      }
      const targetExecutionContext: ExecutionErrorContext = {
        resource: target.name,
        ...(targetEdge ? { parentResource: targetEdge.parent } : {}),
        ...(targetEdge?.bindings[0] ? { binding: targetEdge.bindings[0] } : {}),
      };
      let result: QueryResourceResult<TRecord>;
      try {
        addRedactionValue(targetInput);
        result = await queryResource<TRecord>({
          integration: options.integration,
          resource: target,
          input: targetInput,
          filter: options.filter,
          search: options.search,
          limit: options.limit,
          secrets: options.secrets,
          declaredSecretNames: options.declaredSecretNames,
          signal,
          authorizeBillable: boundedAuthorization,
          beforeRequestAttempt: () => attempt(targetExecutionContext),
          mcpPrefetchCursor: false,
          mcpConnectWithCallerSignal: true,
          onResolvedSecret: addRedactionValue,
          ...(options.customTokenStore ? { customTokenStore: options.customTokenStore } : {}),
          fanOutBoundInputNames: targetEdge
            ? targetEdge.bindings.map((binding) => binding.input)
            : Object.keys(targetInput),
          ...(rateLimiterFor(target) ? { rateLimiter: rateLimiterFor(target) } : {}),
          onMappedRecord: (record) => recordMapped(target, record, targetExecutionContext),
        });
      } catch (error) {
        updateDuration();
        if (error instanceof QueryFanOutError) throw error;
        if (signal.reason instanceof QueryFanOutError) throw signal.reason;
        const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
        if (timedOut) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_DEADLINE',
            kind: 'timeout',
            phase: 'limit',
            target: plan.target,
            resource: target.name,
            message: 'Query fan-out exceeded its deadline.',
            counts,
            cause: error,
            correlationId: options.correlationId,
            ...targetExecutionContext,
          });
        }
        if (signal.aborted) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_CANCELLED',
            kind: 'cancellation',
            phase: 'cancelled',
            target: plan.target,
            resource: target.name,
            message: 'Query fan-out was cancelled.',
            counts,
            cause: error,
            correlationId: options.correlationId,
            ...targetExecutionContext,
          });
        }
        throw errorFrom(error, {
          phase: 'child',
          target: plan.target,
          resource: target.name,
          counts,
          correlationId: options.correlationId,
          secrets: redactionSecrets,
        });
      }
      counts.providerAttempts = Math.max(counts.providerAttempts, result.requestCount);
      counts.requestCount = counts.providerAttempts;
      checkStop();
      return {
        contractVersion: QUERY_FAN_OUT_CONTRACT_VERSION,
        plan,
        records: result.records,
        limitReached: result.limitReached,
        counts,
      };
    }

    assertInput(
      plan.requiredRootInputs,
      input,
      plan.target,
      root.name,
      counts,
      options.mode,
      options.correlationId
    );
    for (const edge of plan.edges) {
      const child = byName.get(edge.child)!;
      const childInput = withInputDefaults(child, suppliedInput);
      assertInput(
        requiredInputs(child.input).filter(
          (name) => !edge.bindings.some((binding) => binding.input === name)
        ),
        childInput,
        plan.target,
        child.name,
        counts,
        options.mode,
        options.correlationId
      );
    }
    for (const [edgeIndex, edge] of plan.edges.entries()) {
      const parent = byName.get(edge.parent)!;
      const previousEdge = edgeIndex > 0 ? plan.edges[edgeIndex - 1] : undefined;
      const availableParentInput = withInputDefaults(parent, suppliedInput);
      for (const binding of edge.bindings) {
        if (binding.source !== 'input') continue;
        const suppliedByParentBinding = previousEdge?.bindings.some(
          (candidate) => candidate.input === binding.field
        );
        if (
          !suppliedByParentBinding &&
          (availableParentInput[binding.field] === undefined ||
            availableParentInput[binding.field] === null)
        ) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_MISSING_INPUT',
            kind: 'validation',
            phase: 'plan',
            target: plan.target,
            resource: edge.child,
            parentResource: edge.parent,
            binding,
            message: `Binding source "${edge.parent}.${binding.field}" for "${edge.child}.${binding.input}" is missing.`,
            counts,
            correlationId: options.correlationId,
          });
        }
      }
    }
    const targetEdge = plan.edges.at(-1);
    if (targetEdge) {
      const target = byName.get(plan.target)!;
      const overriddenInputs = collectQueryOverrideInputNames(
        target.query,
        options.filter,
        options.search
      );
      const overwrittenBinding = targetEdge.bindings.find((binding) =>
        overriddenInputs.has(binding.input)
      );
      if (overwrittenBinding) {
        throw new QueryFanOutError({
          code: 'QUERY_FAN_OUT_BINDING_OVERRIDE',
          kind: 'validation',
          phase: 'plan',
          target: plan.target,
          resource: target.name,
          parentResource: targetEdge.parent,
          binding: overwrittenBinding,
          message: `Query filter/search cannot override fan-out input "${target.name}.${overwrittenBinding.input}".`,
          counts,
          correlationId: options.correlationId,
        });
      }
    }

    // Authorization is a graph-wide preflight: no ancestor request is made if
    // any billable Resource lacks approval. The inner callback merely consumes
    // that already granted decision when queryResource executes each node.
    const authorized = new Set<string>();
    for (const name of plan.topologicalOrder) {
      const resource = byName.get(name)!;
      if (!resource.billing) continue;
      let approved: boolean | undefined;
      try {
        approved = await boundedAuthorization?.({
          operation: 'query',
          resource,
          billing: resource.billing,
        });
      } catch (error) {
        updateDuration();
        checkStop();
        throw errorFrom(error, {
          phase: 'plan',
          target: plan.target,
          resource: name,
          counts,
          correlationId: options.correlationId,
          secrets: redactionSecrets,
        });
      }
      if (approved !== true) {
        throw new QueryFanOutError({
          code: 'QUERY_FAN_OUT_BILLING_DENIED',
          kind: 'validation',
          phase: 'plan',
          target: plan.target,
          resource: name,
          message: `Resource "${name}" is billable and requires explicit authorization.`,
          counts,
          correlationId: options.correlationId,
        });
      }
      authorized.add(name);
    }
    const authorization: AuthorizeBillableResource | undefined = options.authorizeBillable
      ? async ({ resource }) => authorized.has(resource.name)
      : undefined;

    const execute = async (
      resource: ApiResourceSpec,
      work: WorkItem,
      phase: QueryFanOutPhase,
      parentResource?: string,
      recordLimit?: number,
      onMappedRecord?: MappedRecordHandler
    ): Promise<WorkResult> => {
      const incomingEdge = plan.edges.find((edge) => edge.child === resource.name);
      const executionContext: ExecutionErrorContext = {
        resource: resource.name,
        ...(parentResource ? { parentResource } : {}),
        parentOrdinal: work.ordinal,
        ...(incomingEdge?.bindings[0] ? { binding: incomingEdge.bindings[0] } : {}),
      };
      try {
        checkStop(executionContext);
        addRedactionValue(work.inputs);
        assertCompleteFanOutContext(resource.name, resource.output, work.context);
        const result = await queryResource<Record<string, unknown>>({
          integration: options.integration,
          resource,
          input: work.inputs,
          ...(resource.name === plan.target
            ? {
                filter: options.filter,
                search: options.search,
                ...(recordLimit !== undefined ? { limit: recordLimit } : {}),
              }
            : {}),
          secrets: options.secrets,
          declaredSecretNames: options.declaredSecretNames,
          signal,
          fanOutContext: work.context,
          authorizeBillable: authorization,
          beforeRequestAttempt: () => attempt(executionContext),
          mcpPrefetchCursor: false,
          mcpConnectWithCallerSignal: true,
          onResolvedSecret: addRedactionValue,
          ...(options.customTokenStore ? { customTokenStore: options.customTokenStore } : {}),
          ...(incomingEdge
            ? { fanOutBoundInputNames: incomingEdge.bindings.map((binding) => binding.input) }
            : resource.name === root.name
              ? { fanOutBoundInputNames: Object.keys(work.inputs) }
              : {}),
          ...(rateLimiterFor(resource) ? { rateLimiter: rateLimiterFor(resource) } : {}),
          ...(onMappedRecord ? { collectMappedRecords: false } : {}),
          ...(onMappedRecord ? { skipUnboundedPageLimit: true } : {}),
          onMappedRecord: (record) => recordMapped(resource, record, executionContext),
          ...(onMappedRecord ? { shouldStopAfterMappedRecord: onMappedRecord } : {}),
        });
        counts.providerAttempts = Math.max(counts.providerAttempts, result.requestCount);
        counts.requestCount = counts.providerAttempts;
        checkStop(executionContext);
        return { work, records: result.records, limitReached: result.limitReached };
      } catch (error) {
        updateDuration();
        if (error instanceof QueryFanOutError) throw error;
        if (signal.reason instanceof QueryFanOutError) throw signal.reason;
        checkStop(executionContext);
        const wrapped = errorFrom(error, {
          phase,
          target: plan.target,
          resource: resource.name,
          ...(parentResource ? { parentResource } : {}),
          parentOrdinal: work.ordinal,
          counts,
          correlationId: options.correlationId,
          secrets: redactionSecrets,
        });
        if (
          wrapped.kind === 'cancellation' &&
          (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
        ) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_DEADLINE',
            kind: 'timeout',
            phase: 'limit',
            target: plan.target,
            resource: resource.name,
            ...(parentResource ? { parentResource } : {}),
            parentOrdinal: work.ordinal,
            message: 'Query fan-out exceeded its deadline.',
            counts,
            cause: error,
            correlationId: options.correlationId,
          });
        }
        abort.abort(wrapped);
        throw wrapped;
      }
    };

    const runStartedAt = new Date(executionStartedAt);
    const resolvedEdgePredicates = new Map(
      plan.edges.map((edge) => [
        edge,
        edge.where?.map((predicate) => resolvePredicate(predicate as never, runStartedAt)) ?? [],
      ])
    );
    const target = byName.get(plan.target)!;
    const createWorkItem = (
      edge: QueryFanOutPlanEdge,
      child: ApiResourceSpec,
      parentResult: WorkResult,
      parentRecord: Record<string, unknown>,
      predicates: ReturnType<typeof resolvePredicate>[],
      seenWorkKeys: Set<string>,
      ordinal: number
    ): WorkItem | undefined => {
      checkStop();
      if (!predicates.every((predicate) => evaluateResolvedPredicate(parentRecord, predicate))) {
        return undefined;
      }
      const childInput = withInputDefaults(child, suppliedInput);
      for (const binding of edge.bindings) {
        const source = binding.source === 'input' ? parentResult.work.inputs : parentRecord;
        const value = source[binding.field];
        if (value === undefined || value === null) {
          throw new QueryFanOutError({
            code: 'QUERY_FAN_OUT_NULL_BINDING',
            kind: 'validation',
            phase: 'child',
            target: plan.target,
            resource: child.name,
            parentResource: edge.parent,
            binding,
            parentOrdinal: parentResult.work.ordinal,
            message: `Binding "${edge.parent}.${binding.field}" for "${child.name}.${binding.input}" is missing or null.`,
            counts,
            correlationId: options.correlationId,
          });
        }
        childInput[binding.input] = value;
      }
      assertInput(
        edge.bindings.map((binding) => binding.input),
        childInput,
        plan.target,
        child.name,
        counts,
        'fan_out',
        options.correlationId
      );
      const context = extendFanOutContext(parentResult.work.context, edge.parent, parentRecord);
      const key = JSON.stringify([
        edge.bindings.map((binding) => childInput[binding.input]),
        getContextProjectionValues(child.output, context),
        // Preserve lineage that is only consumed by a deeper descendant.
        // An intermediate Resource may have no `output.from` fields of its
        // own, while the target still maps a distinct ancestor value. Do
        // not coalesce those work items before the target can observe the
        // difference; values not present yet are intentionally undefined
        // and become part of the key once that ancestor is resolved.
        getContextProjectionValues(target.output, context),
      ]);
      if (seenWorkKeys.has(key)) return undefined;
      seenWorkKeys.add(key);
      counts.parentWorkItems += 1;
      if (counts.parentWorkItems > limits.maxParentWorkItems) {
        throw new QueryFanOutError({
          code: 'QUERY_FAN_OUT_PARENT_LIMIT',
          kind: 'validation',
          phase: 'limit',
          target: plan.target,
          resource: child.name,
          parentResource: edge.parent,
          binding: edge.bindings[0],
          parentOrdinal: parentResult.work.ordinal,
          message: 'Query fan-out exceeded its parent-work-item budget.',
          counts,
          correlationId: options.correlationId,
        });
      }
      return { inputs: childInput, context, ordinal };
    };

    let demandLimitReached = false;
    let previous: WorkResult[];
    counts.maxConcurrency = 1;
    if (options.limit !== undefined && plan.edges.length > 0) {
      // A target limit makes the whole chain demand-driven. Execute one
      // deterministic path at a time so an early target result does not force
      // us to materialize or execute unrelated intermediate parents. The
      // work-key and ordinal state remains per edge, matching the flat
      // executor's duplicate coalescing and ordering semantics.
      const seenWorkKeysByEdge = plan.edges.map(() => new Set<string>());
      const nextOrdinalByEdge = plan.edges.map(() => 0);
      const results: WorkResult[] = [];
      let returned = 0;
      const targetLimit = options.limit;
      const visit = async (edgeIndex: number, parentResult: WorkResult): Promise<boolean> => {
        const edge = plan.edges[edgeIndex]!;
        const child = byName.get(edge.child)!;
        const isTarget = child.name === target.name;
        const predicates = resolvedEdgePredicates.get(edge)!;
        for (const parentRecord of parentResult.records) {
          const work = createWorkItem(
            edge,
            child,
            parentResult,
            parentRecord,
            predicates,
            seenWorkKeysByEdge[edgeIndex]!,
            nextOrdinalByEdge[edgeIndex]!
          );
          if (!work) continue;
          nextOrdinalByEdge[edgeIndex] = work.ordinal + 1;
          let descendantSatisfied = false;
          const result = await execute(
            child,
            work,
            isTarget ? 'child' : 'parent',
            edge.parent,
            isTarget ? targetLimit - returned : undefined,
            isTarget
              ? undefined
              : async (record) => {
                  descendantSatisfied = await visit(edgeIndex + 1, {
                    work,
                    records: [record],
                    limitReached: false,
                  });
                  return descendantSatisfied;
                }
          );
          if (isTarget) {
            results.push(result);
            returned += result.records.length;
            if (returned >= targetLimit) {
              demandLimitReached = true;
              return true;
            }
          } else if (descendantSatisfied) {
            return true;
          }
        }
        return false;
      };

      const rootWork: WorkItem = {
        inputs: input,
        context: EMPTY_FAN_OUT_CONTEXT,
        ordinal: 0,
      };
      await execute(
        root,
        rootWork,
        'parent',
        undefined,
        undefined,
        async (record) =>
          await visit(0, {
            work: rootWork,
            records: [record],
            limitReached: false,
          })
      );
      // `createWorkItem` raises QUERY_FAN_OUT_PARENT_LIMIT at the first actual
      // work item beyond the budget. If traversal naturally exhausts exactly
      // at the boundary, returning an empty/partial result is valid and must
      // not be turned into a false parent-limit error here.
      previous = results;
    } else {
      previous = [
        await execute(
          root,
          { inputs: input, context: EMPTY_FAN_OUT_CONTEXT, ordinal: 0 },
          plan.edges.length > 0 ? 'parent' : 'child',
          undefined,
          root.name === plan.target ? options.limit : undefined
        ),
      ];
      for (const edge of plan.edges) {
        const child = byName.get(edge.child)!;
        const work: WorkItem[] = [];
        const seenWorkKeys = new Set<string>();
        const predicates = resolvedEdgePredicates.get(edge)!;
        for (const parentResult of previous) {
          for (const parentRecord of parentResult.records) {
            const item = createWorkItem(
              edge,
              child,
              parentResult,
              parentRecord,
              predicates,
              seenWorkKeys,
              work.length
            );
            if (item) work.push(item);
          }
        }
        const results: WorkResult[] = new Array(work.length);
        const concurrency = Math.min(limits.maxConcurrency, edge.effectiveConcurrency);
        let inFlight = 0;
        await runFailFast(work, concurrency, async (item, index) => {
          inFlight += 1;
          counts.maxConcurrency = Math.max(counts.maxConcurrency, inFlight);
          try {
            results[index] = await execute(
              child,
              item,
              child.name === plan.target ? 'child' : 'parent',
              edge.parent
            );
          } finally {
            inFlight -= 1;
          }
        });
        previous = results;
      }
    }
    const records: TRecord[] = [];
    let limitReached = demandLimitReached || previous.some((result) => result.limitReached);
    for (const result of previous) {
      for (const record of result.records) {
        if (options.limit !== undefined && records.length >= options.limit) {
          limitReached = true;
          continue;
        }
        records.push(record as TRecord);
      }
    }
    checkStop();
    return { contractVersion: QUERY_FAN_OUT_CONTRACT_VERSION, plan, records, limitReached, counts };
  } catch (error) {
    updateDuration();
    if (error instanceof QueryFanOutError) throw error;
    if (signal.reason instanceof QueryFanOutError) throw signal.reason;
    const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
    if (timedOut) {
      throw new QueryFanOutError({
        code: 'QUERY_FAN_OUT_DEADLINE',
        kind: 'timeout',
        phase: 'limit',
        target: options.target,
        message: 'Query fan-out exceeded its deadline.',
        counts,
        cause: error,
        correlationId: options.correlationId,
      });
    }
    throw errorFrom(error, {
      phase: signal.aborted ? 'cancelled' : 'child',
      target: options.target,
      counts,
      correlationId: options.correlationId,
      secrets: redactionSecrets,
    });
  } finally {
    abort.abort();
  }
}
