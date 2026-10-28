/**
 * SELECT statement AST → TransformSpec.
 *
 * Walks a `node-sql-parser` SELECT statement and produces one head
 * `TransformSpec` plus zero or more ephemeral CTE/UNION-branch models. Set
 * operations (`UNION` / `INTERSECT` / `EXCEPT`) and `WITH` clauses both lift
 * sub-SELECTs into ephemeral models referenced by name from the head model;
 * Model Spec YAML has no inline-SELECT primitive.
 *
 * Strict by design: FROM subqueries, correlated subqueries, and other
 * unsupported constructs throw `ModelSpecGenerationError`.
 */

import type { SourceSpec, TransformSpec } from '../compiler/schemas.js';

import { emitExpr, type ExprContext } from './expr-mapper.js';
import { normalize } from './identifiers.js';
import type { PreprocessResult } from './preprocess.js';
import { SourceResolver } from './sources.js';
import { ModelSpecGenerationError } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const JOIN_TYPE_MAP: Record<string, 'inner' | 'left' | 'cross' | 'full'> = {
  'INNER JOIN': 'inner',
  JOIN: 'inner',
  'LEFT JOIN': 'left',
  'LEFT OUTER JOIN': 'left',
  'CROSS JOIN': 'cross',
  'FULL JOIN': 'full',
  'FULL OUTER JOIN': 'full',
};

interface MapContext extends ExprContext {
  resolver: SourceResolver;
  sources: readonly SourceSpec[];
  cteNamePrefix: string;
  /** Models (ephemeral CTEs / UNION branches) emitted as side-effects. */
  emitted: TransformSpec[];
  /** Set of CTE names declared in the current scope. */
  cteNames: Set<string>;
  /** Used to generate unique sub-model names. */
  nextSubId: { value: number };
  warnings: string[];
}

/** SQL table alias → fully-qualified source/model ref + bare expr qualifier. */
interface AliasBinding {
  /** Expression-side qualifier (the source/model `name` without connection prefix). */
  qualifier: string;
  /** `source.ref` value (`<connection>.<name>` for sources, just `<name>` for CTEs/models). */
  ref: string;
}

export interface MapStatementOptions {
  modelName: string;
  description: string;
  cteNamePrefix: string;
  sources: readonly SourceSpec[];
  preprocessed: PreprocessResult;
  defaultConnection?: string;
}

export interface MapStatementResult {
  drafts: TransformSpec[];
  warnings: string[];
}

export function mapStatement(stmt: Node, opts: MapStatementOptions): MapStatementResult {
  const ctx: MapContext = {
    masks: opts.preprocessed.masks,
    resolver: new SourceResolver(opts.sources, opts.defaultConnection),
    sources: opts.sources,
    cteNamePrefix: opts.cteNamePrefix,
    emitted: [],
    cteNames: new Set<string>(),
    nextSubId: { value: 0 },
    warnings: [],
  };

  // Handle WITH (CTEs): each CTE becomes an ephemeral model referenced by name.
  if (Array.isArray(stmt.with)) {
    for (const cte of stmt.with) {
      const cteName = String(cte.name?.value ?? cte.name);
      if (!cteName) {
        throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'CTE without a name');
      }
      const ephemeralName = `${opts.cteNamePrefix}${cteName}`;
      const inner = cte.stmt?.ast ?? cte.stmt;
      const ephemeral = mapHeadStatement(
        inner,
        ephemeralName,
        `Ephemeral CTE \`${cteName}\``,
        ctx,
        true
      );
      ctx.emitted.push(ephemeral);
      ctx.cteNames.add(normalize(cteName));
    }
  }

  const head = mapHeadStatement(stmt, opts.modelName, opts.description, ctx, false);
  return { drafts: [...ctx.emitted, head], warnings: ctx.warnings };
}

function mapHeadStatement(
  stmt: Node,
  name: string,
  description: string,
  ctx: MapContext,
  ephemeral: boolean
): TransformSpec {
  if (stmt.type !== 'select') {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_STATEMENT',
      `Only SELECT statements are supported; got ${String(stmt.type)}`
    );
  }

  // Set operations: a chain of selects linked via `_next`.
  if (stmt._next) {
    return mapSetOperation(stmt, name, description, ctx, ephemeral);
  }

  return mapSimpleSelect(stmt, name, description, ctx, ephemeral);
}

function mapSetOperation(
  head: Node,
  name: string,
  description: string,
  ctx: MapContext,
  ephemeral: boolean
): TransformSpec {
  const branches: Node[] = [];
  let cur: Node | null = head;
  while (cur) {
    branches.push(cur);
    cur = cur._next ?? null;
  }

  const refs: { ref: string; operation?: 'union_all' | 'union' | 'intersect' | 'except' }[] = [];
  branches.forEach((branch, i) => {
    const subName = i === 0 ? `${name}__branch_0` : `${name}__branch_${i}`;
    const sub = mapHeadStatement(
      { ...branch, set_op: undefined, _next: undefined },
      subName,
      `Branch ${i} of ${name}`,
      ctx,
      true
    );
    ctx.emitted.push(sub);

    const op = i === 0 ? undefined : normalizeSetOp(branch.set_op);
    refs.push(op ? { ref: subName, operation: op } : { ref: subName });
  });

  const head0 = refs[0]!;
  const tail = refs.slice(1);

  const out: TransformSpec = {
    spec_version: '0.2',
    name,
    type: 'model',
    description,
    grain: 'id',
    source: { ref: head0.ref },
    joins: [],
    columns: [],
    include_all_columns: true,
    union: tail.map((r) => ({ ref: r.ref, operation: r.operation ?? 'union_all' })),
    materialization: { type: ephemeral ? 'ephemeral' : 'view' },
    trust_tier: 'bronze',
  } as unknown as TransformSpec;
  return out;
}

function normalizeSetOp(op: unknown): 'union_all' | 'union' | 'intersect' | 'except' {
  const text = String(op ?? '')
    .toUpperCase()
    .trim();
  if (text === 'UNION ALL' || text === 'UNION_ALL') return 'union_all';
  if (text === 'UNION') return 'union';
  if (text === 'INTERSECT') return 'intersect';
  if (text === 'EXCEPT' || text === 'MINUS') return 'except';
  throw new ModelSpecGenerationError(
    'UNSUPPORTED_CONSTRUCT',
    `Unsupported set operation \`${String(op)}\``
  );
}

interface FromMapping {
  source: { ref: string; filter?: string };
  joins: NonNullable<TransformSpec['joins']>;
  aliases: Map<string, AliasBinding>;
  flatten?: TransformSpec['flatten_json'];
}

function mapSimpleSelect(
  stmt: Node,
  name: string,
  description: string,
  ctx: MapContext,
  ephemeral: boolean
): TransformSpec {
  const fromMapping = mapFrom(stmt.from, ctx);

  const columnsResult = mapColumns(stmt.columns, fromMapping.aliases, ctx);
  const columns = columnsResult.columns;

  const where = stmt.where ? emitExprWithAliases(stmt.where, fromMapping.aliases, ctx) : undefined;
  const having = stmt.having
    ? emitExprWithAliases(stmt.having, fromMapping.aliases, ctx)
    : undefined;
  const qualify = stmt.qualify
    ? emitExprWithAliases(stmt.qualify, fromMapping.aliases, ctx)
    : undefined;

  const groupBy = mapGroupBy(stmt.groupby, stmt.columns, fromMapping.aliases, ctx);
  const orderBy = mapOrderBy(stmt.orderby, fromMapping.aliases, ctx);
  const distinct = stmt.distinct?.type ? true : undefined;
  const limit = mapLimit(stmt.limit);

  const grain = inferGrain(columns) ?? defaultGrain(name, ctx);

  const result: TransformSpec = {
    spec_version: '0.2',
    name,
    type: 'model',
    description,
    grain,
    source: fromMapping.source,
    joins: fromMapping.joins,
    columns,
    materialization: { type: ephemeral ? 'ephemeral' : 'view' },
    trust_tier: 'bronze',
  } as TransformSpec;

  if (columnsResult.include_all_columns) {
    (result as { include_all_columns?: boolean }).include_all_columns = true;
  }
  if (columnsResult.exclude_columns?.length) {
    (result as { exclude_columns?: string[] }).exclude_columns = columnsResult.exclude_columns;
  }
  if (distinct) (result as { distinct?: boolean }).distinct = true;
  if (groupBy?.length) (result as { group_by?: string[] }).group_by = groupBy;
  if (where) (result as { where?: string }).where = where;
  if (having) (result as { having?: string }).having = having;
  if (qualify) (result as { qualify?: string }).qualify = qualify;
  if (orderBy?.length) (result as { order_by?: typeof orderBy }).order_by = orderBy;
  if (limit !== undefined) (result as { limit?: number }).limit = limit;
  if (fromMapping.flatten) {
    (result as { flatten_json?: typeof fromMapping.flatten }).flatten_json = fromMapping.flatten;
  }

  return result;
}

function mapFrom(from: Node[] | null | undefined, ctx: MapContext): FromMapping {
  if (!from || from.length === 0) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'SELECT without a FROM clause is not supported'
    );
  }

  const aliases = new Map<string, AliasBinding>();
  const joins: NonNullable<TransformSpec['joins']> = [];
  let headSource: { ref: string; filter?: string } | undefined;
  let flatten: TransformSpec['flatten_json'] | undefined;

  for (let i = 0; i < from.length; i++) {
    const item = from[i]!;

    if (
      item.expr?.type === 'flatten' ||
      item.prefix === 'LATERAL' ||
      item.expr?.ast?.type === 'select'
    ) {
      // LATERAL FLATTEN — encoded as a separate from-list entry by node-sql-parser.
      if (item.expr?.type === 'flatten') {
        if (flatten) {
          throw new ModelSpecGenerationError(
            'UNSUPPORTED_CONSTRUCT',
            'Multiple LATERAL FLATTEN clauses are not yet supported by the Model Spec generator'
          );
        }
        flatten = mapFlatten(item, aliases, ctx);
        continue;
      }
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        'Subqueries in FROM are not supported — extract them into a separate model or CTE'
      );
    }

    if (!item.table) {
      throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', `Unsupported FROM entry shape`);
    }

    const tableName: string = item.table;
    const aliasKey: string = item.as ? normalize(item.as) : normalize(tableName);

    let ref: string;
    let qualifier: string;

    if (ctx.cteNames.has(normalize(tableName))) {
      const cteRef = `${ctx.cteNamePrefix}${tableName}`;
      ref = cteRef;
      qualifier = cteRef;
    } else {
      const resolved = ctx.resolver.resolve(item.db, tableName);
      ref = resolved;
      qualifier = resolved.includes('.') ? resolved.split('.').slice(-1)[0]! : resolved;
    }

    aliases.set(aliasKey, { qualifier, ref });

    if (i === 0) {
      headSource = { ref };
    } else {
      const joinType = item.join ? JOIN_TYPE_MAP[String(item.join).toUpperCase()] : undefined;
      if (!joinType) {
        // Implicit comma-join — convert to CROSS JOIN with no ON.
        joins.push({ ref, type: 'cross', on: '1 = 1' });
      } else {
        if (!item.on && joinType !== 'cross') {
          throw new ModelSpecGenerationError(
            'UNSUPPORTED_CONSTRUCT',
            'JOIN without ON clause is not supported (USING clauses too)'
          );
        }
        const on = item.on ? emitExprWithAliases(item.on, aliases, ctx) : '1 = 1';
        joins.push({ ref, type: joinType, on });
      }
    }
  }

  if (!headSource) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'FROM clause produced no head table'
    );
  }

  return { source: headSource, joins, aliases, flatten };
}

function mapFlatten(
  item: Node,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): TransformSpec['flatten_json'] {
  const flatten = item.expr;
  const args = flatten.args;
  if (!args?.input?.value) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'LATERAL FLATTEN missing INPUT');
  }
  const inputExpr = emitExprWithAliases(args.input.value, aliases, ctx);
  const aliasName = item.as ? String(item.as) : 'flattened';

  // Register the flatten alias so subsequent expressions resolve correctly.
  aliases.set(normalize(aliasName), { qualifier: aliasName, ref: '__flatten__' });

  const step: { input: string; alias: string; outer?: boolean; path?: string } = {
    input: inputExpr,
    alias: aliasName,
  };
  // PATH => 'items' is wrapped as `{ value: { type: 'single_quote_string', value: 'items' } }`
  // OUTER => TRUE  is wrapped as `{ value: { type: 'bool', value: true } }`
  const pathLiteral: unknown = args.path?.value?.value;
  if (typeof pathLiteral === 'string') step.path = pathLiteral;
  if (args.outer?.value?.value === true) step.outer = true;

  return step as TransformSpec['flatten_json'];
}

function emitExprWithAliases(
  node: Node,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): string {
  // Replace user-defined SQL aliases (e.g. `u` → `users`) inline by walking the
  // tree once and rewriting `column_ref.table` to the bound qualifier. We do this
  // by emitting via `emitExpr` with a wrapper node that performs substitution.
  return emitExpr(rewriteAliases(node, aliases), ctx);
}

function rewriteAliases(node: Node, aliases: Map<string, AliasBinding>): Node {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => rewriteAliases(n, aliases));

  if (node.type === 'column_ref' && node.table) {
    const aliasKey = normalize(String(node.table));
    const bound = aliases.get(aliasKey);
    if (bound) {
      return { ...node, table: bound.qualifier };
    }
    // Unknown qualifier — fail fast rather than emitting an invalid expression.
    // Strict-mode contract: every table-qualified column ref must resolve to a
    // FROM/JOIN entry, CTE, or flatten alias.
    throw new ModelSpecGenerationError(
      'UNRESOLVED_TABLE_ALIAS',
      `Column reference \`${String(node.table)}.${String(node.column)}\` uses an unknown table alias. ` +
        `Aliases bound in this scope: ${[...aliases.keys()].join(', ') || '(none)'}.`
    );
  }

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(node as object)) {
    out[k] = rewriteAliases((node as Record<string, unknown>)[k], aliases);
  }
  return out;
}

interface MapColumnsResult {
  columns: NonNullable<TransformSpec['columns']>;
  include_all_columns?: boolean;
  exclude_columns?: string[];
}

function mapColumns(
  cols: Node[] | null | undefined,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): MapColumnsResult {
  if (!cols || cols.length === 0) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'SELECT with no columns');
  }

  const stars = cols.filter(isStarColumn);
  if (stars.length > 0) {
    return mapStarColumns(stars, cols, aliases);
  }

  const out: NonNullable<TransformSpec['columns']> = [];
  for (const col of cols) {
    const expr = emitExprWithAliases(col.expr, aliases, ctx);
    const name = col.as ?? inferColumnName(col.expr, aliases);
    if (!name) {
      throw new ModelSpecGenerationError(
        'UNNAMED_COLUMN',
        `Computed column has no alias: ${expr.slice(0, 60)}. Add an AS <name>.`
      );
    }
    out.push({ name, expr });
  }
  return { columns: out };
}

function isStarColumn(col: Node): boolean {
  return col?.expr?.type === 'column_ref' && col.expr.column === '*';
}

/**
 * Map `SELECT *` / `SELECT t.*` projections to Model Spec's `include_all_columns: true`.
 *
 * Easy-pass scope: bare `*`, `t.*` for a single-FROM SELECT, and full coverage
 * stars (`a.*, b.*` covering every FROM/JOIN alias). Snowflake `EXCLUDE (...)`
 * suffixes aggregate into `exclude_columns`. Mixed star + explicit projections,
 * partial-qualified stars across joins, and CTE/subquery-rooted stars are
 * deferred — they fall through to the explicit error paths.
 */
function mapStarColumns(
  stars: Node[],
  allCols: Node[],
  aliases: Map<string, AliasBinding>
): MapColumnsResult {
  if (stars.length !== allCols.length) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'Mixing `SELECT *` (or `t.*`) with explicit projections is not yet supported by the Model Spec generator. List every column explicitly or remove the explicit projections.'
    );
  }

  // Reject overlapping wildcards: SQL emits duplicate columns for `SELECT *,
  // u.*` and `SELECT u.*, u.*`, but `include_all_columns: true` collapses them
  // into a single expansion, silently changing the projection shape.
  if (stars.length > 1 && stars.some((s) => s.expr.table == null)) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'Combining bare `*` with any additional wildcard projection is not yet supported by the Model Spec generator.'
    );
  }

  const fromAliasKeys = new Set<string>();
  for (const [k, v] of aliases) {
    if (v.ref !== '__flatten__') fromAliasKeys.add(k);
  }

  const qualified = new Set<string>();
  let hasBareStar = false;
  const excludeColumns: string[] = [];

  for (const star of stars) {
    const tableQualifier = star.expr.table;
    if (tableQualifier == null) {
      hasBareStar = true;
    } else {
      const aliasKey = normalize(String(tableQualifier));
      if (!fromAliasKeys.has(aliasKey)) {
        throw new ModelSpecGenerationError(
          'UNRESOLVED_TABLE_ALIAS',
          `\`${String(tableQualifier)}.*\` references an unknown table alias. ` +
            `Aliases bound in this scope: ${[...fromAliasKeys].join(', ') || '(none)'}.`
        );
      }
      qualified.add(aliasKey);
    }

    const suffix = star.expr.suffix;
    if (suffix == null) continue;
    const suffixName = String(suffix?.name?.name?.[0]?.value ?? '').toLowerCase();
    if (suffix.type !== 'function' || suffixName !== 'exclude') {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Unsupported \`*\` suffix: only Snowflake \`EXCLUDE (...)\` is supported (got \`${suffixName || 'unknown'}\`).`
      );
    }
    // Model Spec's `exclude_columns` is global across the source + every join, so an
    // EXCLUDE attached to a qualified star (`u.* EXCLUDE (id)`) in a query that
    // touches multiple FROM aliases would silently exclude the named column from
    // every alias rather than just `u`. Refuse rather than miscompile.
    if (tableQualifier != null && fromAliasKeys.size > 1) {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Qualified \`${String(tableQualifier)}.* EXCLUDE (...)\` across a multi-table FROM/JOIN is not yet supported by the Model Spec generator (Model Spec \`exclude_columns\` is global). Enumerate the columns explicitly or attach EXCLUDE to a bare \`*\`.`
      );
    }
    const args = (suffix.args?.value ?? []) as Node[];
    for (const a of args) {
      if (a?.type === 'column_ref' && typeof a.column === 'string' && a.column !== '*') {
        excludeColumns.push(a.column);
      } else {
        throw new ModelSpecGenerationError(
          'UNSUPPORTED_CONSTRUCT',
          'EXCLUDE expects a list of bare column references'
        );
      }
    }
  }

  if (!hasBareStar && qualified.size < fromAliasKeys.size) {
    const missing = [...fromAliasKeys].filter((k) => !qualified.has(k));
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      `Partial \`alias.*\` projections that select only some FROM/JOIN tables are not yet supported. ` +
        `Either bare \`SELECT *\` or stars covering every alias (missing: ${missing.join(', ')}).`
    );
  }

  // Reject repeated qualified stars (`SELECT u.*, u.*`) — SQL emits each set of
  // columns once per occurrence, but `include_all_columns: true` only expands
  // every alias once.
  if (!hasBareStar && qualified.size !== stars.length) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'Repeated `alias.*` projections are not yet supported by the Model Spec generator.'
    );
  }

  return {
    columns: [],
    include_all_columns: true,
    exclude_columns: excludeColumns.length > 0 ? excludeColumns : undefined,
  };
}

function inferColumnName(node: Node, aliases: Map<string, AliasBinding>): string | undefined {
  if (node?.type === 'column_ref' && typeof node.column === 'string') {
    return node.column;
  }
  if (node?.type === 'double_quote_string' && typeof node.value === 'string') {
    return node.value;
  }
  // Without an explicit alias, we can't safely name computed columns. Caller errors.
  void aliases;
  return undefined;
}

function mapGroupBy(
  groupby: Node | null | undefined,
  selectColumns: Node[] | null | undefined,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): string[] | undefined {
  if (!groupby) return undefined;

  // GROUP BY ALL — expand against the SELECT list (non-aggregated columns).
  if (
    groupby.value === 'ALL' ||
    (groupby.columns && String(groupby.columns).toUpperCase() === 'ALL')
  ) {
    return expandGroupByAll(selectColumns, aliases, ctx);
  }
  const items = Array.isArray(groupby) ? groupby : groupby.columns;
  if (!Array.isArray(items)) return undefined;

  const out: string[] = [];
  for (const item of items) {
    out.push(emitExprWithAliases(item, aliases, ctx));
  }
  return out;
}

function expandGroupByAll(
  cols: Node[] | null | undefined,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): string[] {
  if (!cols) return [];
  const out: string[] = [];
  for (const col of cols) {
    if (containsAggregate(col.expr)) continue;
    out.push(emitExprWithAliases(col.expr, aliases, ctx));
  }
  return out;
}

function containsAggregate(node: Node): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'aggr_func' || node.type === 'window_func') return true;
  for (const v of Object.values(node as object)) {
    if (Array.isArray(v)) {
      for (const x of v) if (containsAggregate(x)) return true;
    } else if (v && typeof v === 'object') {
      if (containsAggregate(v)) return true;
    }
  }
  return false;
}

function mapOrderBy(
  orderby: Node[] | null | undefined,
  aliases: Map<string, AliasBinding>,
  ctx: MapContext
): { column: string; direction?: 'asc' | 'desc' }[] | undefined {
  if (!orderby || orderby.length === 0) return undefined;
  const out: { column: string; direction?: 'asc' | 'desc' }[] = [];
  for (const o of orderby) {
    const expr = emitExprWithAliases(o.expr, aliases, ctx);
    // ORDER BY only accepts identifiers in the Model Spec schema — reject computed exprs
    // to avoid silently dropping them.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `ORDER BY expression \`${expr.slice(0, 40)}\` is not a bare identifier; Model Spec \`order_by\` requires column names only.`
      );
    }
    const rawDir = o.type ? String(o.type).toLowerCase() : undefined;
    const dir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : undefined;
    out.push(dir ? { column: expr, direction: dir } : { column: expr });
  }
  return out;
}

function mapLimit(limit: Node): number | undefined {
  if (!limit?.value) return undefined;
  const arr = Array.isArray(limit.value) ? limit.value : [limit.value];
  if (arr.length === 0) return undefined;
  const first = arr[0];
  if (first?.type === 'number' && typeof first.value === 'number') return first.value;
  return undefined;
}

function inferGrain(cols: NonNullable<TransformSpec['columns']>): string | undefined {
  // If the user explicitly marked a primary_key column, use it. Otherwise return
  // undefined and let `defaultGrain` pick a placeholder.
  for (const c of cols) {
    if ((c as { primary_key?: boolean }).primary_key) return c.name;
  }
  return undefined;
}

function defaultGrain(modelName: string, ctx: MapContext): string {
  ctx.warnings.push(
    `Could not infer grain for \`${modelName}\` — defaulted to \`id\`. Set \`grain\` manually if that's not the unique key.`
  );
  return 'id';
}
