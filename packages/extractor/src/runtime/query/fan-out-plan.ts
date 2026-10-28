import { createHash } from 'node:crypto';

import { resolveDeclaredOutputPath } from '../../framework/core/index.js';
import {
  isLookupOnlyApiResource,
  validatePredicatesAgainstOutput,
} from '../../framework/extractor/index.js';
import { normalizeForEachConfig, type NormalizedForEachBinding } from '../for-each.js';
import { QUERY_FAN_OUT_CONTRACT_VERSION, QueryFanOutError } from './fan-out-contract.js';
import {
  DEFAULT_QUERY_FAN_OUT_LIMITS,
  assertSupportedExecutionTransport,
  emptyQueryFanOutCounts,
} from './fan-out-support.js';

import type { InputFieldDefinition, OutputFieldDefinition } from '../../framework/core/index.js';
import type { ApiResourceSpec, ResourceSpec } from '../../types/index.js';
import type {
  PlanQueryFanOutOptions,
  QueryFanOutPlan,
  QueryFanOutPlanEdge,
} from './fan-out-contract.js';

function resourceFingerprint(resources: readonly ApiResourceSpec[]): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(resources)))
    .digest('hex');
}

export function planFailure(
  target: string,
  message: string,
  context: {
    resource?: string;
    parentResource?: string;
    binding?: NormalizedForEachBinding;
  } = {}
): never {
  throw new QueryFanOutError({
    code: 'QUERY_FAN_OUT_INVALID_PLAN',
    kind: 'validation',
    phase: 'plan',
    target,
    message,
    counts: emptyQueryFanOutCounts(),
    ...context,
  });
}

export function asApiResource(resource: ResourceSpec, target: string): ApiResourceSpec {
  const hasApi = 'api' in resource && resource.api !== undefined;
  const hasTool = 'tool' in resource && resource.tool !== undefined;
  if (isLookupOnlyApiResource(resource) || !('extract' in resource) || (!hasApi && !hasTool)) {
    return planFailure(
      target,
      `Resource "${resource.name}" is not a queryable API or MCP Resource.`
    );
  }
  return resource as ApiResourceSpec;
}

export function requiredInputs(input: Record<string, InputFieldDefinition>): string[] {
  return Object.entries(input)
    .filter(([, definition]) => definition.required === true && definition.default === undefined)
    .map(([name]) => name)
    .sort();
}

function outputAncestorNames(resource: ApiResourceSpec): string[] {
  return [
    ...new Set(
      Object.values(resource.output).flatMap((field) =>
        field.from && 'resource' in field.from ? [field.from.resource] : []
      )
    ),
  ].sort();
}

function sourceField(
  parent: ApiResourceSpec,
  binding: NormalizedForEachBinding
): OutputFieldDefinition | InputFieldDefinition | undefined {
  return binding.source === 'input' ? parent.input[binding.field] : parent.output[binding.field];
}

function assertTransport(resource: ApiResourceSpec, target: string): void {
  if (resource.api && resource.tool) {
    planFailure(target, `Resource "${resource.name}" has ambiguous transports.`, {
      resource: resource.name,
    });
  }
  if (!resource.api && !resource.tool) {
    planFailure(target, `Resource "${resource.name}" has no supported transport.`, {
      resource: resource.name,
    });
  }
}

/** Validate and serialize the canonical extract.for_each chain without network work. */
export function planQueryFanOut(options: PlanQueryFanOutOptions): QueryFanOutPlan {
  const maxDepth = options.maxDepth ?? 5;
  const maxResources = options.maxResources ?? 20;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_QUERY_FAN_OUT_LIMITS.maxConcurrency;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
    return planFailure(options.target, 'maxDepth must be a safe integer between 0 and 20.');
  }
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 100) {
    return planFailure(options.target, 'maxResources must be a safe integer between 1 and 100.');
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
    return planFailure(options.target, 'maxConcurrency must be a safe integer between 1 and 64.');
  }
  const byName = new Map<string, ResourceSpec>();
  for (const candidate of options.resources) {
    if (byName.has(candidate.name)) {
      planFailure(options.target, `Resource "${candidate.name}" is ambiguous.`);
    }
    byName.set(candidate.name, candidate);
  }
  const targetCandidate = byName.get(options.target);
  if (!targetCandidate) {
    planFailure(options.target, `Target Resource "${options.target}" was not supplied.`);
  }
  const target = asApiResource(targetCandidate, options.target);

  const reverse: ApiResourceSpec[] = [];
  const visited = new Set<string>();
  let current = target;
  while (true) {
    if (visited.has(current.name)) {
      planFailure(options.target, `Resource fan-out cycle includes "${current.name}".`, {
        resource: current.name,
      });
    }
    visited.add(current.name);
    assertTransport(current, options.target);
    reverse.push(current);
    if (reverse.length > maxResources) {
      planFailure(
        options.target,
        `Resource fan-out exceeds the configured maximum of ${maxResources} Resources.`
      );
    }
    const forEach = normalizeForEachConfig(current.extract.for_each);
    if (!forEach) break;
    if (reverse.length - 1 >= maxDepth) {
      planFailure(
        options.target,
        `Resource fan-out depth exceeds the configured maximum of ${maxDepth}.`
      );
    }
    const parentCandidate = byName.get(forEach.resource);
    if (!parentCandidate) {
      planFailure(
        options.target,
        `Resource "${current.name}" references missing parent "${forEach.resource}".`,
        { resource: current.name, parentResource: forEach.resource }
      );
    }
    const parent = asApiResource(parentCandidate, options.target);
    assertTransport(parent, options.target);
    const boundInputs = new Set<string>();
    for (const binding of forEach.bindings) {
      if (boundInputs.has(binding.input)) {
        planFailure(
          options.target,
          `Resource "${current.name}" has multiple for_each bindings for input "${binding.input}".`,
          { resource: current.name, parentResource: parent.name, binding }
        );
      }
      boundInputs.add(binding.input);
      const source = sourceField(parent, binding);
      const childInput = current.input[binding.input];
      if (!source || !childInput) {
        planFailure(
          options.target,
          `Incomplete binding "${current.name}.${binding.input}" from "${parent.name}.${binding.field}".`,
          { resource: current.name, parentResource: parent.name, binding }
        );
      }
      if (source.type !== childInput.type) {
        planFailure(
          options.target,
          `Incompatible binding "${parent.name}.${binding.field}" (${source.type}) -> "${current.name}.${binding.input}" (${childInput.type}).`,
          { resource: current.name, parentResource: parent.name, binding }
        );
      }
    }
    const predicateIssues: string[] = [];
    validatePredicatesAgainstOutput(
      forEach.where ?? [],
      parent.output,
      {
        path: [],
        addIssue: (issue: { message?: string }) => {
          predicateIssues.push(issue.message ?? 'invalid predicate');
        },
      } as unknown as Parameters<typeof validatePredicatesAgainstOutput>[2],
      ['extract', 'for_each', 'where']
    );
    if (predicateIssues.length > 0) {
      planFailure(
        options.target,
        `Invalid for_each.where on "${current.name}" against parent "${parent.name}": ${predicateIssues.join('; ')}.`,
        { resource: current.name, parentResource: parent.name }
      );
    }
    current = parent;
  }

  const chain = reverse.reverse();
  for (const [index, resource] of chain.entries()) {
    if (index < chain.length - 1 && !resource.query) {
      planFailure(
        options.target,
        `Ancestor Resource "${resource.name}" does not declare query support and cannot be used for query-time fan-out.`,
        { resource: resource.name }
      );
    }
    if (options.integration) {
      assertSupportedExecutionTransport(
        options.integration,
        resource,
        options.target,
        emptyQueryFanOutCounts()
      );
    }
  }
  const knownAncestors = new Set<string>();
  for (const resource of chain) {
    for (const [field, output] of Object.entries(resource.output)) {
      if (!output.from || !('resource' in output.from)) continue;
      const originRef = output.from;
      if (!knownAncestors.has(originRef.resource)) {
        planFailure(
          options.target,
          `Contextual output "${resource.name}.${field}" references unavailable ancestor "${originRef.resource}". Use $.__input__ for a bound request input.`,
          { resource: resource.name, parentResource: originRef.resource }
        );
      }
      const origin = chain.find((candidate) => candidate.name === originRef.resource);
      const originField = origin && resolveDeclaredOutputPath(origin.output, originRef.path);
      if (!originField) {
        planFailure(
          options.target,
          `Contextual output "${resource.name}.${field}" has invalid ancestor path "${originRef.resource}${originRef.path.slice(1)}".`,
          { resource: resource.name, parentResource: originRef.resource }
        );
      }
      if (originField.type !== output.type) {
        planFailure(
          options.target,
          `Contextual output "${resource.name}.${field}" type "${output.type}" is not compatible with "${originRef.resource}${originRef.path.slice(1)}" (${originField.type}).`,
          { resource: resource.name, parentResource: originRef.resource }
        );
      }
    }
    knownAncestors.add(resource.name);
  }

  const edges: QueryFanOutPlanEdge[] = [];
  for (let index = 1; index < chain.length; index++) {
    const child = chain[index]!;
    const forEach = normalizeForEachConfig(child.extract.for_each)!;
    edges.push({
      parent: chain[index - 1]!.name,
      child: child.name,
      bindings: forEach.bindings.map((binding) => ({ ...binding })),
      ...(forEach.where ? { where: forEach.where.map((predicate) => ({ ...predicate })) } : {}),
      effectiveConcurrency: Math.min(forEach.concurrency, maxConcurrency),
    });
  }
  return {
    contractVersion: QUERY_FAN_OUT_CONTRACT_VERSION,
    target: target.name,
    nodes: chain.map((resource, index) => ({
      name: resource.name,
      role:
        index === 0
          ? chain.length === 1
            ? 'target'
            : 'root'
          : index === chain.length - 1
            ? 'target'
            : 'intermediate',
      requiredInputs: requiredInputs(resource.input),
      contextualAncestors: outputAncestorNames(resource),
      effectiveConcurrency: index === 0 ? 1 : edges[index - 1]!.effectiveConcurrency,
    })),
    edges,
    topologicalOrder: chain.map((resource) => resource.name),
    requiredRootInputs: requiredInputs(chain[0]!.input),
    resourceFingerprint: resourceFingerprint(chain),
  };
}
