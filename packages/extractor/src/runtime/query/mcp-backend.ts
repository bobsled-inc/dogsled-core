import { QUERY_OPERATORS } from '../../framework/extractor/query-spec.js';
import {
  appendSearchValue,
  invokeBuilder,
  parseFilterExpression,
} from '../../framework/query/index.js';
import { ExtractorConfigError } from '../errors.js';

import type {
  QueryCompileConfig,
  QueryPredicate,
  QueryPredicateOperator,
  QueryPredicateValue,
} from '../../framework/query/index.js';
import type { ApiResourceSpec, QueryOperator, QuerySpec, ResourceSpec } from '../../types/index.js';

export type McpQueryScalarValue = string | number | boolean;
export type McpQueryArrayValue = McpQueryScalarValue[];
export type McpQueryValue = McpQueryScalarValue | McpQueryArrayValue;
export type McpQueryFilterOperators = Partial<
  Record<QueryOperator | `$${QueryOperator}`, McpQueryValue>
>;
export type McpQueryFilterValue = McpQueryScalarValue | McpQueryFilterOperators;
export type McpQueryFilterInput = Record<string, McpQueryFilterValue>;

export interface CompileQueryToMcpArgsOptions {
  resource: ResourceSpec;
  filter?: McpQueryFilterInput;
  filterExpression?: string;
  search?: string;
  input?: Record<string, unknown>;
  compile?: QueryCompileConfig;
}

type QueryWithMcpBuilder = QuerySpec & {
  compile?: QueryCompileConfig;
  compile_mode?: QueryCompileConfig['mode'];
  filter_builder?: QueryCompileConfig;
  mcp?: {
    compile?: QueryCompileConfig;
    filter_builder?: QueryCompileConfig;
  };
};

type NormalizedMcpFilter = Record<string, Partial<Record<QueryOperator, McpQueryValue>>>;
const QUERY_OPERATOR_SET = new Set<string>(QUERY_OPERATORS);

export function compileQueryToMcpArgs(
  optionsOrResource: CompileQueryToMcpArgsOptions | ResourceSpec,
  maybeOptions: Omit<CompileQueryToMcpArgsOptions, 'resource'> = {}
): Record<string, unknown> {
  const options =
    'resource' in optionsOrResource
      ? optionsOrResource
      : { resource: optionsOrResource, ...maybeOptions };
  const resource = options.resource;
  const mcpResource = asMcpResource(resource);
  if (!mcpResource.tool) {
    throw new ExtractorConfigError('compileQueryToMcpArgs() requires an MCP tool resource.');
  }

  const query = mcpResource.query as QueryWithMcpBuilder | undefined;
  if (!query) {
    return { ...(options.input ?? {}) };
  }

  if (options.filter && options.search !== undefined) {
    throw new ExtractorConfigError('compileQueryToMcpArgs() accepts either filter or search.');
  }

  const normalized = normalizeMcpFilterInput(options.filter);
  const expressionPredicates = options.filterExpression
    ? parseFilterExpression(options.filterExpression)
    : [];
  const predicates = [...predicatesFromFilter(query, normalized), ...expressionPredicates];
  const compile = resolveCompileConfig(options.compile, query);

  const args: Record<string, unknown> = { ...(options.input ?? {}) };
  switch (compile.mode) {
    case 'http_query':
    case 'direct_arg':
      Object.assign(args, boundArgumentsFromFilter(query, normalized));
      break;
    case 'filter_dsl':
      if (!compile.builder) {
        throw new ExtractorConfigError('filter_dsl compile mode requires a builder.');
      }
      Object.assign(args, invokeBuilder(compile.builder, compile, predicates));
      break;
  }

  if (options.search !== undefined) {
    if (!query.search) {
      throw new ExtractorConfigError(
        `Resource "${resource.name}" does not declare query.search support.`
      );
    }
    args[query.search.bind.input] = appendSearchValue(options.search, query.search.append);
  }

  return args;
}

function isApiResourceSpec(resource: ResourceSpec): resource is ApiResourceSpec {
  return !('source' in resource) && !('replication' in resource);
}

function asMcpResource(resource: ResourceSpec): ApiResourceSpec {
  if (!isApiResourceSpec(resource)) {
    throw new ExtractorConfigError('compileQueryToMcpArgs() does not support warehouse resources.');
  }
  return resource;
}

function resolveCompileConfig(
  override: QueryCompileConfig | undefined,
  query: QueryWithMcpBuilder
): QueryCompileConfig {
  if (override) {
    return override;
  }
  if (query.mcp?.compile) {
    return query.mcp.compile;
  }
  if (query.compile) {
    return query.compile;
  }
  if (query.mcp?.filter_builder) {
    return { ...query.mcp.filter_builder, mode: 'filter_dsl' };
  }
  if (query.filter_builder) {
    return { ...query.filter_builder, mode: 'filter_dsl' };
  }
  return { mode: query.compile_mode ?? 'direct_arg' };
}

function normalizeMcpFilterInput(filter: McpQueryFilterInput | undefined): NormalizedMcpFilter {
  if (!filter) {
    return Object.create(null) as NormalizedMcpFilter;
  }

  const normalized = Object.create(null) as NormalizedMcpFilter;
  for (const [fieldName, rawValue] of Object.entries(filter)) {
    if (isScalarValue(rawValue)) {
      normalized[fieldName] = { eq: rawValue };
      continue;
    }

    if (!isOperatorObject(rawValue)) {
      throw new ExtractorConfigError(
        `MCP query filter "${fieldName}" must be a scalar or operator object.`
      );
    }

    const operators = Object.create(null) as Partial<Record<QueryOperator, McpQueryValue>>;
    for (const [rawOperator, value] of Object.entries(rawValue)) {
      const operator = normalizeOperatorName(rawOperator);
      if (operator === 'in') {
        if (!isScalarArrayValue(value)) {
          throw new ExtractorConfigError(
            `MCP query filter "${fieldName}" operator "${rawOperator}" must use a non-empty scalar array.`
          );
        }
        operators[operator] = value;
        continue;
      }

      if (!isScalarValue(value)) {
        throw new ExtractorConfigError(
          `MCP query filter "${fieldName}" operator "${rawOperator}" must use a scalar value.`
        );
      }
      operators[operator] = value;
    }
    normalized[fieldName] = operators;
  }

  return normalized;
}

function predicatesFromFilter(query: QuerySpec, filter: NormalizedMcpFilter): QueryPredicate[] {
  const predicates: QueryPredicate[] = [];
  for (const [field, operators] of Object.entries(filter)) {
    const filterSpec = query.filters?.[field];
    if (!filterSpec) {
      throw new ExtractorConfigError(`Resource query does not declare filter "${field}".`);
    }

    for (const [operator, value] of Object.entries(operators) as Array<
      [QueryPredicateOperator, QueryPredicateValue]
    >) {
      if (!filterSpec.operators.includes(operator)) {
        throw new ExtractorConfigError(
          `Query filter "${field}" does not support operator "${operator}".`
        );
      }
      predicates.push({ field, operator, value });
    }
  }
  return predicates;
}

function boundArgumentsFromFilter(
  query: QuerySpec,
  filter: NormalizedMcpFilter
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [field, operators] of Object.entries(filter)) {
    const filterSpec = query.filters?.[field];
    if (!filterSpec) {
      continue;
    }

    for (const [operator, value] of Object.entries(operators) as Array<
      [QueryOperator, McpQueryValue]
    >) {
      const binding = filterSpec.bind[operator];
      if (binding) {
        args[binding.input] = value;
      }
    }
  }
  return args;
}

function normalizeOperatorName(rawOperator: string): QueryOperator {
  const operator = rawOperator.startsWith('$') ? rawOperator.slice(1) : rawOperator;
  if (!isQueryOperator(operator)) {
    throw new ExtractorConfigError(`Unsupported MCP query operator "${rawOperator}".`);
  }
  return operator;
}

function isOperatorObject(value: McpQueryFilterValue): value is McpQueryFilterOperators {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQueryOperator(value: string): value is QueryOperator {
  return QUERY_OPERATOR_SET.has(value);
}

function isScalarValue(value: unknown): value is McpQueryScalarValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isScalarArrayValue(value: unknown): value is McpQueryArrayValue {
  return Array.isArray(value) && value.length > 0 && value.every(isScalarValue);
}
