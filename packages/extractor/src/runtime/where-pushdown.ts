import type { QueryOperator, QuerySpec } from '../framework/extractor/resource.js';
import { predicateOperator, type Predicate } from '../framework/extractor/predicate.js';

/**
 * Result of splitting a list of `extract.where` predicates against a resource's
 * `query.filters` block. Anything with a matching `compile` binding lands in
 * `pushedParams`; the rest stays in `remaining` for client-side evaluation
 * after `mapResponse` runs.
 *
 * `pushedParams` is the flat record consumed by `buildHttpPageIterator`'s
 * `initialParams` (or `buildMcpPageIterator`'s `initialArgs`). Routing into
 * request body vs. URL query happens later via `routePaginationParams`.
 */
export interface WherePushdownSplit {
  pushedParams: Record<string, string | number | boolean>;
  remaining: Predicate[];
}

type CompileConfig = {
  mode?: unknown;
  param?: unknown;
  argument?: unknown;
};

function getCompileConfigForOperator(
  compile: unknown,
  operator: QueryOperator
): CompileConfig | undefined {
  if (!compile || typeof compile !== 'object' || Array.isArray(compile)) {
    return undefined;
  }
  const record = compile as Record<string, unknown>;
  if (typeof record['mode'] === 'string') {
    return record as CompileConfig;
  }
  const operatorConfig = record[operator];
  return operatorConfig && typeof operatorConfig === 'object' && !Array.isArray(operatorConfig)
    ? (operatorConfig as CompileConfig)
    : undefined;
}

function coerceScalar(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/**
 * Walk `predicates` and consult `query.filters[predicate.field].compile[operator]`
 * for each. When the binding exists with mode `http_query` or `direct_arg`,
 * emit the param name and pass the predicate's value through. Multi-value
 * (`in`) predicates are not pushed down today — leave them for client-side
 * fallback.
 *
 * The operator names line up between the predicate vocabulary and `QueryOperator`
 * by convention: `eq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`. `neq` has no
 * direct `QueryOperator` analogue (`not`/`ne` are close but inconsistent across
 * integrations), so it always stays in `remaining`.
 */
export function splitWherePushdown(
  predicates: ReadonlyArray<Predicate>,
  query: QuerySpec | undefined,
  resolvedValues: ReadonlyMap<number, unknown>
): WherePushdownSplit {
  const pushedParams: Record<string, string | number | boolean> = {};
  const remaining: Predicate[] = [];

  const queryFilters = (query?.filters ?? {}) as Record<
    string,
    | {
        compile: unknown;
        bind: Partial<Record<QueryOperator, { input: string }>>;
        operators: QueryOperator[];
      }
    | undefined
  >;

  predicates.forEach((predicate, index) => {
    const operator = predicateOperator(predicate);
    // `in` arrays and operator `neq` never push down — they have no
    // 1:1 query-binding analogue in this MVP. Leave them in `remaining`.
    if (operator === 'in' || operator === 'neq') {
      remaining.push(predicate);
      return;
    }

    const filterSpec = queryFilters[predicate.field];
    if (!filterSpec) {
      remaining.push(predicate);
      return;
    }

    const queryOperator = operator as QueryOperator;
    if (!filterSpec.operators.includes(queryOperator)) {
      remaining.push(predicate);
      return;
    }

    const compileConfig = getCompileConfigForOperator(filterSpec.compile, queryOperator);
    const bindInput = filterSpec.bind[queryOperator]?.input;

    let target: string | undefined;
    if (compileConfig?.mode === 'http_query') {
      target = typeof compileConfig.param === 'string' ? compileConfig.param : bindInput;
    } else if (compileConfig?.mode === 'direct_arg') {
      target = typeof compileConfig.argument === 'string' ? compileConfig.argument : bindInput;
    }

    if (!target) {
      remaining.push(predicate);
      return;
    }

    const resolvedValue = resolvedValues.get(index);
    const scalar = coerceScalar(resolvedValue);
    if (scalar === undefined) {
      remaining.push(predicate);
      return;
    }

    pushedParams[target] = scalar;
  });

  return { pushedParams, remaining };
}
