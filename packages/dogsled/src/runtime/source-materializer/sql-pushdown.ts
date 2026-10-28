import { Dialect, parse } from '@polyglot-sql/sdk';
import type { QueryScalarValue, QueryValue } from '@bobsled-inc/extractor';
import type { ApiResourceSpec, QueryOperator } from '@bobsled-inc/extractor/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';

import { sourceNameOf, type ApiResourceEntry } from './load-specs.js';

type IntegrationSpecLoader = typeof loadQueryableResourceSpecs;
type OperatorFilter = Partial<Record<QueryOperator, QueryValue>>;

interface Predicate {
  sourceName: string;
  field: string;
  operator: QueryOperator;
  value: QueryValue;
}

interface ColumnRef {
  qualifier?: string;
  field: string;
}

type MutableFilter = Record<string, QueryValue | OperatorFilter>;

interface SelectScope {
  aliases: Map<string, string>;
  sourceNames: string[];
  allowUnqualifiedSource: boolean;
  whereExpression?: unknown;
}

interface ScopeBuildState {
  unsafe: boolean;
  sourceCounts: Map<string, number>;
}

export interface PartialMaterializationEligibility {
  eligible: boolean;
  limit?: number;
  sourceName?: string;
  reason?:
    | 'not_simple_select'
    | 'no_limit'
    | 'invalid_limit'
    | 'multi_source'
    | 'join'
    | 'group_by'
    | 'having'
    | 'qualify'
    | 'order_by'
    | 'window'
    | 'distinct'
    | 'cte'
    | 'aggregate'
    | 'result_shape'
    | 'residual_filter'
    // Set by the engine (not this analyzer) when the partialMaterialization
    // feature flag is off: a limit-named partial table only pays off when the
    // flag also stores a reduced slice, so a disabled run skips partial naming
    // and uses the canonical per-source cache table.
    | 'partial_materialization_disabled';
}

const MAX_PUSHDOWN_STRING_LENGTH = 1024;
const MAX_PUSHDOWN_IN_CARDINALITY = 100;
const PUSHDOWN_OPERATORS = new Set<QueryOperator>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'not',
]);
const LOWER_BOUND_OPERATORS = new Set<QueryOperator>(['gt', 'gte']);
const UPPER_BOUND_OPERATORS = new Set<QueryOperator>(['lt', 'lte']);
const AGGREGATE_AST_KEYS = new Set([
  'array_agg',
  'avg',
  'count',
  'first',
  'group_concat',
  'last',
  'list',
  'max',
  'median',
  'min',
  'mode',
  'string_agg',
  'sum',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifierName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = value['name'];
  return typeof name === 'string' ? name : undefined;
}

function isSafePushdownString(value: string): boolean {
  if (value.length > MAX_PUSHDOWN_STRING_LENGTH) return false;
  // Reject control chars (C0 + DEL) other than tab/newline/carriage return.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function literalValue(value: unknown): QueryScalarValue | undefined {
  if (!isRecord(value)) return undefined;
  const literal = value['literal'];
  if (isRecord(literal)) {
    const literalType = literal['literal_type'];
    const raw = literal['value'];
    if (literalType === 'string' && typeof raw === 'string') {
      return isSafePushdownString(raw) ? raw : undefined;
    }
    if (literalType === 'number' && typeof raw === 'string') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }

  const booleanValue = value['boolean'];
  if (isRecord(booleanValue) && typeof booleanValue['value'] === 'boolean') {
    return booleanValue['value'];
  }

  return undefined;
}

function columnRef(value: unknown): ColumnRef | undefined {
  if (!isRecord(value)) return undefined;

  const column = value['column'];
  if (isRecord(column)) {
    const field = identifierName(column['name']);
    if (!field) return undefined;
    const qualifier = identifierName(column['table']);
    return qualifier ? { qualifier, field } : { field };
  }

  const dot = value['dot'];
  if (isRecord(dot)) {
    const field = identifierName(dot['field']);
    if (!field) return undefined;
    const base = columnRef(dot['this']);
    if (!base) return undefined;
    return { qualifier: base.field, field };
  }

  return undefined;
}

function collectConjuncts(node: unknown): unknown[] {
  if (!isRecord(node)) return [];
  const and = node['and'];
  if (isRecord(and)) {
    return [...collectConjuncts(and['left']), ...collectConjuncts(and['right'])];
  }
  return [node];
}

function flipComparison(operator: QueryOperator): QueryOperator {
  if (operator === 'gt') return 'lt';
  if (operator === 'gte') return 'lte';
  if (operator === 'lt') return 'gt';
  if (operator === 'lte') return 'gte';
  return operator;
}

function sourceForColumn(
  ref: ColumnRef,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): string | undefined {
  if (!ref.qualifier) {
    return scope.allowUnqualifiedSource && scope.sourceNames.length === 1
      ? scope.sourceNames[0]
      : undefined;
  }
  return scope.aliases.get(ref.qualifier);
}

function comparisonPredicate(
  node: Record<string, unknown>,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): Predicate | undefined {
  const operatorByAstKey = {
    eq: 'eq',
    neq: 'ne',
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte',
  } as const;

  for (const [astKey, operator] of Object.entries(operatorByAstKey)) {
    const comparison = node[astKey];
    if (!isRecord(comparison)) continue;

    const leftColumn = columnRef(comparison['left']);
    const rightValue = literalValue(comparison['right']);
    if (leftColumn && rightValue !== undefined) {
      const sourceName = sourceForColumn(leftColumn, scope);
      return sourceName
        ? { sourceName, field: leftColumn.field, operator, value: rightValue }
        : undefined;
    }

    const rightColumn = columnRef(comparison['right']);
    const leftValue = literalValue(comparison['left']);
    if (rightColumn && leftValue !== undefined) {
      const sourceName = sourceForColumn(rightColumn, scope);
      return sourceName
        ? {
            sourceName,
            field: rightColumn.field,
            operator: flipComparison(operator),
            value: leftValue,
          }
        : undefined;
    }
  }

  return undefined;
}

function inPredicate(
  node: Record<string, unknown>,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): Predicate | undefined {
  const inNode = node['in'];
  if (!isRecord(inNode) || inNode['not'] === true) return undefined;
  const ref = columnRef(inNode['this']);
  const expressions = inNode['expressions'];
  if (!ref || !Array.isArray(expressions) || expressions.length === 0) return undefined;
  if (expressions.length > MAX_PUSHDOWN_IN_CARDINALITY) return undefined;
  const values = expressions.map(literalValue);
  if (values.some((value) => value === undefined)) return undefined;
  // Skip heterogeneous lists — mixed element types may fail provider validation.
  if (new Set(values.map((value) => typeof value)).size > 1) return undefined;
  const sourceName = sourceForColumn(ref, scope);
  return sourceName
    ? { sourceName, field: ref.field, operator: 'in', value: values as QueryScalarValue[] }
    : undefined;
}

function containsValueFromLike(pattern: QueryScalarValue | undefined): string | undefined {
  if (typeof pattern !== 'string') return undefined;
  if (!pattern.startsWith('%') || !pattern.endsWith('%') || pattern.length <= 2) return undefined;
  const inner = pattern.slice(1, -1);
  return inner.includes('%') || inner.includes('_') ? undefined : inner;
}

function likePredicate(
  node: Record<string, unknown>,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): Predicate | undefined {
  const like = node['like'];
  if (!isRecord(like)) return undefined;
  const ref = columnRef(like['left']);
  const contains = containsValueFromLike(literalValue(like['right']));
  if (!ref || contains === undefined) return undefined;
  const sourceName = sourceForColumn(ref, scope);
  return sourceName
    ? { sourceName, field: ref.field, operator: 'contains', value: contains }
    : undefined;
}

function notPredicate(
  node: Record<string, unknown>,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): Predicate | undefined {
  const not = node['not'];
  if (!isRecord(not)) return undefined;
  const ref = columnRef(not['this']);
  if (!ref) return undefined;
  const sourceName = sourceForColumn(ref, scope);
  return sourceName ? { sourceName, field: ref.field, operator: 'not', value: true } : undefined;
}

function predicateFromConjunct(
  conjunct: unknown,
  scope: Pick<SelectScope, 'aliases' | 'sourceNames' | 'allowUnqualifiedSource'>
): Predicate | undefined {
  if (!isRecord(conjunct)) return undefined;
  return (
    comparisonPredicate(conjunct, scope) ??
    inPredicate(conjunct, scope) ??
    likePredicate(conjunct, scope) ??
    notPredicate(conjunct, scope)
  );
}

function tableExpression(node: unknown): Record<string, unknown> | undefined {
  return isRecord(node) && isRecord(node['table']) ? node['table'] : undefined;
}

function registerAlias(
  aliases: Map<string, string>,
  alias: string,
  sourceName: string,
  state: ScopeBuildState
): void {
  const existing = aliases.get(alias);
  if (existing !== undefined) {
    state.unsafe = true;
    return;
  }
  aliases.set(alias, sourceName);
}

function addScopeRelation(
  relation: unknown,
  sourceNameSet: ReadonlySet<string>,
  aliases: Map<string, string>,
  sourceNames: Set<string>,
  state: ScopeBuildState
): boolean {
  const table = tableExpression(relation);
  if (!table) return true;
  if (identifierName(table['schema']) !== 'sources') return true;

  const sourceName = identifierName(table['name']);
  if (!sourceName || !sourceNameSet.has(sourceName)) return true;

  sourceNames.add(sourceName);
  const count = (state.sourceCounts.get(sourceName) ?? 0) + 1;
  state.sourceCounts.set(sourceName, count);
  if (count > 1) state.unsafe = true;

  const alias = identifierName(table['alias']);
  if (alias) {
    registerAlias(aliases, alias, sourceName, state);
  } else {
    registerAlias(aliases, sourceName, sourceName, state);
  }
  return false;
}

function topLevelSelectScope(
  ast: unknown,
  sourceNameSet: ReadonlySet<string>
): SelectScope | undefined {
  if (!Array.isArray(ast) || ast.length !== 1) return undefined;
  const statement = ast[0];
  if (!isRecord(statement) || !isRecord(statement['select'])) return undefined;

  const select = statement['select'];
  const aliases = new Map<string, string>();
  const sourceNames = new Set<string>();
  const state: ScopeBuildState = { unsafe: false, sourceCounts: new Map() };
  let hasNonSourceRelation = false;

  const from = select['from'];
  const fromExpressions =
    isRecord(from) && Array.isArray(from['expressions']) ? from['expressions'] : [];
  for (const expression of fromExpressions) {
    hasNonSourceRelation =
      addScopeRelation(expression, sourceNameSet, aliases, sourceNames, state) ||
      hasNonSourceRelation;
  }

  const joins = Array.isArray(select['joins']) ? select['joins'] : [];
  for (const join of joins) {
    const relation = isRecord(join) ? join['this'] : undefined;
    hasNonSourceRelation =
      addScopeRelation(relation, sourceNameSet, aliases, sourceNames, state) ||
      hasNonSourceRelation;
  }

  if (state.unsafe) return undefined;

  const where = select['where_clause'];
  const whereExpression = isRecord(where) ? where['this'] : undefined;
  return {
    aliases,
    sourceNames: [...sourceNames],
    allowUnqualifiedSource: !hasNonSourceRelation,
    ...(whereExpression !== undefined ? { whereExpression } : {}),
  };
}

function supportedPredicate(
  predicate: Predicate,
  capabilities: ReadonlyMap<string, ReadonlySet<QueryOperator>>
): boolean {
  return capabilities.get(predicate.field)?.has(predicate.operator) === true;
}

function isTopLevelSelect(ast: unknown): ast is Array<Record<string, unknown>> {
  return Array.isArray(ast) && ast.length === 1 && isRecord(ast[0]) && isRecord(ast[0]['select']);
}

function selectNode(ast: unknown): Record<string, unknown> | undefined {
  if (!isTopLevelSelect(ast)) return undefined;
  return ast[0]!['select'] as Record<string, unknown>;
}

function integerLiteralValue(node: unknown): number | undefined {
  if (!isRecord(node) || !isRecord(node['literal'])) return undefined;
  const literal = node['literal'];
  if (literal['literal_type'] !== 'number' || typeof literal['value'] !== 'string') {
    return undefined;
  }
  const value = Number(literal['value']);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function selectLimit(select: Record<string, unknown>): number | undefined {
  const limit = isRecord(select['limit']) ? select['limit'] : undefined;
  const limitThis = limit?.['this'];
  return integerLiteralValue(limitThis);
}

function containsAstKey(node: unknown, key: string): boolean {
  if (Array.isArray(node)) {
    return node.some((value) => containsAstKey(value, key));
  }
  if (!isRecord(node)) return false;
  if (Object.hasOwn(node, key)) return true;
  return Object.values(node).some((value) => containsAstKey(value, key));
}

function containsAnyAstKey(node: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(node)) {
    return node.some((value) => containsAnyAstKey(value, keys));
  }
  if (!isRecord(node)) return false;
  if (Object.keys(node).some((key) => keys.has(key))) return true;
  return Object.values(node).some((value) => containsAnyAstKey(value, keys));
}

function queryCapabilities(
  spec: Pick<ApiResourceSpec, 'query'>
): Map<string, ReadonlySet<QueryOperator>> {
  const out = new Map<string, ReadonlySet<QueryOperator>>();
  for (const [field, filter] of Object.entries(spec.query?.filters ?? {})) {
    if (filter) out.set(field, new Set(filter.operators));
  }
  return out;
}

function isPushdownOperator(operator: string): operator is QueryOperator {
  return PUSHDOWN_OPERATORS.has(operator as QueryOperator);
}

function isOperatorFilter(value: unknown): value is OperatorFilter {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const operator = key.startsWith('$') ? key.slice(1) : key;
    return isPushdownOperator(operator);
  });
}

function normalizeOperatorFilter(value: OperatorFilter): OperatorFilter {
  const normalized: OperatorFilter = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const operator = rawKey.startsWith('$') ? rawKey.slice(1) : rawKey;
    if (isPushdownOperator(operator)) {
      normalized[operator] = rawValue;
    }
  }
  return normalized;
}

function cloneFilter(filter: Record<string, unknown> | undefined): MutableFilter {
  const out: MutableFilter = {};
  for (const [field, value] of Object.entries(filter ?? {})) {
    if (isRecord(value) && !Array.isArray(value)) {
      out[field] = isOperatorFilter(value)
        ? normalizeOperatorFilter(value)
        : { ...(value as OperatorFilter) };
    } else {
      out[field] = value as QueryValue;
    }
  }
  return out;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareBoundValues(left: QueryScalarValue, right: QueryScalarValue): number | undefined {
  if (typeof left !== typeof right) return undefined;
  if (left === right) return 0;

  if (typeof left === 'number' && typeof right === 'number') {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
    return left > right ? 1 : -1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left > right ? 1 : -1;
  }

  return undefined;
}

function isScalarQueryValue(value: QueryValue | undefined): value is QueryScalarValue {
  return value !== undefined && !Array.isArray(value);
}

function isLowerBoundOperator(operator: QueryOperator): boolean {
  return LOWER_BOUND_OPERATORS.has(operator);
}

function isUpperBoundOperator(operator: QueryOperator): boolean {
  return UPPER_BOUND_OPERATORS.has(operator);
}

function isStrictBoundOperator(operator: QueryOperator): boolean {
  return operator === 'gt' || operator === 'lt';
}

function chooseStricterBound(
  current: { operator: QueryOperator; value: QueryScalarValue },
  candidate: { operator: QueryOperator; value: QueryScalarValue },
  kind: 'lower' | 'upper'
): { operator: QueryOperator; value: QueryScalarValue } | undefined {
  const comparison = compareBoundValues(candidate.value, current.value);
  if (comparison === undefined) return undefined;

  if (comparison === 0) {
    return isStrictBoundOperator(candidate.operator) && !isStrictBoundOperator(current.operator)
      ? candidate
      : current;
  }

  if (kind === 'lower') {
    return comparison > 0 ? candidate : current;
  }

  return comparison < 0 ? candidate : current;
}

function mergeBoundPredicate(existing: OperatorFilter, predicate: Predicate): boolean {
  const kind = isLowerBoundOperator(predicate.operator) ? 'lower' : 'upper';
  const operators = kind === 'lower' ? LOWER_BOUND_OPERATORS : UPPER_BOUND_OPERATORS;
  if (!isScalarQueryValue(predicate.value)) return false;

  let winner = { operator: predicate.operator, value: predicate.value };
  for (const operator of operators) {
    const value = existing[operator];
    if (value === undefined) continue;
    if (!isScalarQueryValue(value)) return false;
    const nextWinner = chooseStricterBound(winner, { operator, value }, kind);
    if (!nextWinner) return false;
    winner = nextWinner;
  }

  for (const operator of operators) {
    delete existing[operator];
  }
  existing[winner.operator] = winner.value;
  return true;
}

function restoreOriginalField(
  filter: MutableFilter,
  field: string,
  originalFilter: MutableFilter
): void {
  const original = originalFilter[field];
  if (original === undefined) {
    delete filter[field];
  } else if (isOperatorFilter(original)) {
    filter[field] = { ...original };
  } else {
    filter[field] = original;
  }
}

function addPredicate(filter: MutableFilter, predicate: Predicate): boolean {
  const existing = filter[predicate.field];
  if (existing === undefined) {
    filter[predicate.field] = { [predicate.operator]: predicate.value };
    return true;
  }

  if (!isOperatorFilter(existing)) {
    if (predicate.operator === 'eq') {
      return sameJson(existing, predicate.value);
    }
    const next: OperatorFilter = { eq: existing };
    if (isLowerBoundOperator(predicate.operator) || isUpperBoundOperator(predicate.operator)) {
      if (!mergeBoundPredicate(next, predicate)) return false;
    } else {
      next[predicate.operator] = predicate.value;
    }
    filter[predicate.field] = next;
    return true;
  }

  if (predicate.operator === 'eq') {
    const existingEqValue = existing.eq;
    if (existingEqValue !== undefined) {
      return sameJson(existingEqValue, predicate.value);
    }
    existing.eq = predicate.value;
    return true;
  }

  if (isLowerBoundOperator(predicate.operator) || isUpperBoundOperator(predicate.operator)) {
    return mergeBoundPredicate(existing, predicate);
  }

  const existingOperatorValue = existing[predicate.operator];
  if (existingOperatorValue === undefined || sameJson(existingOperatorValue, predicate.value)) {
    existing[predicate.operator] = predicate.value;
    return true;
  }
  return false;
}

function applyPredicatesToFilter(
  filter: MutableFilter,
  predicates: Predicate[],
  originalFilter: MutableFilter
): Set<string> {
  const skippedFields = new Set<string>();
  for (const predicate of predicates) {
    if (skippedFields.has(predicate.field)) continue;
    if (!addPredicate(filter, predicate)) {
      skippedFields.add(predicate.field);
      restoreOriginalField(filter, predicate.field, originalFilter);
    }
  }
  return skippedFields;
}

export function applySqlWherePushdown(args: {
  sql: string;
  entries: ApiResourceEntry[];
  integrationSpecLoader?: IntegrationSpecLoader;
}): ApiResourceEntry[] {
  const sourceNames = args.entries.map(sourceNameOf);
  const sourceNameSet = new Set(sourceNames);
  if (sourceNames.length === 0) return args.entries;

  const parsed = parse(args.sql, Dialect.DuckDB);
  if (!parsed.success || !parsed.ast) return args.entries;

  const scope = topLevelSelectScope(parsed.ast, sourceNameSet);
  if (!scope?.whereExpression || scope.sourceNames.length === 0) return args.entries;

  const loader = args.integrationSpecLoader ?? loadQueryableResourceSpecs;
  const capabilitiesBySource = new Map<string, ReadonlyMap<string, ReadonlySet<QueryOperator>>>();
  for (const entry of args.entries) {
    const loaded = loader(entry.integration, entry.resource);
    if (!loaded) continue;
    capabilitiesBySource.set(sourceNameOf(entry), queryCapabilities(loaded.resource));
  }

  const pushedBySource = new Map<string, Predicate[]>();
  for (const conjunct of collectConjuncts(scope.whereExpression)) {
    const predicate = predicateFromConjunct(conjunct, scope);
    if (!predicate) continue;
    const capabilities = capabilitiesBySource.get(predicate.sourceName);
    if (!capabilities || !supportedPredicate(predicate, capabilities)) continue;
    const pushed = pushedBySource.get(predicate.sourceName) ?? [];
    pushed.push(predicate);
    pushedBySource.set(predicate.sourceName, pushed);
  }

  if (pushedBySource.size === 0) return args.entries;

  return args.entries.map((entry) => {
    const sourceName = sourceNameOf(entry);
    const predicates = pushedBySource.get(sourceName);
    if (!predicates?.length) return entry;
    const originalFilter = cloneFilter(entry.filter as Record<string, unknown> | undefined);
    const filter = cloneFilter(entry.filter as Record<string, unknown> | undefined);
    applyPredicatesToFilter(filter, predicates, originalFilter);
    if (sameJson(filter, originalFilter)) return entry;
    return { ...entry, filter };
  });
}

export function isPartialMaterializationEligible(args: {
  sql: string;
  entries: ApiResourceEntry[];
  integrationSpecLoader?: IntegrationSpecLoader;
}): PartialMaterializationEligibility {
  const parsed = parse(args.sql, Dialect.DuckDB);
  if (!parsed.success || !parsed.ast) return { eligible: false, reason: 'not_simple_select' };

  const select = selectNode(parsed.ast);
  if (!select) return { eligible: false, reason: 'not_simple_select' };
  if (select['with'] !== null) return { eligible: false, reason: 'cte' };
  if (select['distinct'] === true || select['distinct_on'] !== null) {
    return { eligible: false, reason: 'distinct' };
  }
  if (Array.isArray(select['joins']) && select['joins'].length > 0) {
    return { eligible: false, reason: 'join' };
  }
  if (select['group_by'] !== null) return { eligible: false, reason: 'group_by' };
  if (select['having'] !== null) return { eligible: false, reason: 'having' };
  if (select['qualify'] !== null) return { eligible: false, reason: 'qualify' };
  if (select['order_by'] !== null) return { eligible: false, reason: 'order_by' };
  if (containsAstKey(select['expressions'], 'window_function') || select['windows'] !== null) {
    return { eligible: false, reason: 'window' };
  }
  if (containsAnyAstKey(select, AGGREGATE_AST_KEYS)) {
    return { eligible: false, reason: 'aggregate' };
  }
  if (
    select['offset'] !== null ||
    select['fetch'] !== null ||
    select['top'] !== null ||
    select['sample'] !== null ||
    select['distribute_by'] !== null ||
    select['cluster_by'] !== null ||
    select['sort_by'] !== null ||
    select['connect'] !== null ||
    select['into'] !== null ||
    (Array.isArray(select['lateral_views']) && select['lateral_views'].length > 0) ||
    (Array.isArray(select['locks']) && select['locks'].length > 0)
  ) {
    return { eligible: false, reason: 'result_shape' };
  }

  const limit = selectLimit(select);
  if (select['limit'] === null) return { eligible: false, reason: 'no_limit' };
  if (limit === undefined) return { eligible: false, reason: 'invalid_limit' };

  const sourceNames = args.entries.map(sourceNameOf);
  const sourceNameSet = new Set(sourceNames);
  const scope = topLevelSelectScope(parsed.ast, sourceNameSet);
  if (!scope || scope.sourceNames.length !== 1) {
    return { eligible: false, reason: 'multi_source' };
  }

  const sourceName = scope.sourceNames[0]!;
  if (scope.whereExpression === undefined) {
    return { eligible: true, limit, sourceName };
  }

  const entry = args.entries.find((candidate) => sourceNameOf(candidate) === sourceName);
  if (!entry) return { eligible: false, reason: 'residual_filter' };

  const loader = args.integrationSpecLoader ?? loadQueryableResourceSpecs;
  const loaded = loader(entry.integration, entry.resource);
  if (!loaded) return { eligible: false, reason: 'residual_filter' };
  const capabilities = queryCapabilities(loaded.resource);
  const predicates: Predicate[] = [];

  for (const conjunct of collectConjuncts(scope.whereExpression)) {
    const predicate = predicateFromConjunct(conjunct, scope);
    if (
      !predicate ||
      predicate.sourceName !== sourceName ||
      !supportedPredicate(predicate, capabilities)
    ) {
      return { eligible: false, reason: 'residual_filter' };
    }
    predicates.push(predicate);
  }

  const originalFilter = cloneFilter(entry.filter as Record<string, unknown> | undefined);
  const filter = cloneFilter(entry.filter as Record<string, unknown> | undefined);
  if (applyPredicatesToFilter(filter, predicates, originalFilter).size > 0) {
    return { eligible: false, reason: 'residual_filter' };
  }

  return { eligible: true, limit, sourceName };
}
