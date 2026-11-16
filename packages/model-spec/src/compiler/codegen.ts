/**
 * SQL code generation from resolved transform specs.
 *
 * All queries (with or without joins) go through raw SQL construction
 * + `transpile()` for validation and dialect-specific normalisation.
 *
 * Identifier casing and quoting varies by dialect (see dialect.ts).
 *
 * Expression AST: Individual column expressions are transpiled per-expression
 * for cross-dialect function mapping (DATEDIFF, DATE_TRUNC, etc.).
 *
 * Error convention: Functions in codegen and materializer throw on internal
 * errors (transpilation failure, missing unique_key). The orchestration layer
 * (run.ts, compile.ts) wraps calls in try/catch to convert to CompileResult.
 * Parser/DAG functions return Result types ({ ok, error }) for validation errors.
 */

import { transpile } from '@polyglot-sql/sdk';
import {
  transpileOrEmit,
  prepareAstForEmit,
  resolveNamedWindows,
  getFlattenAlias,
  collectFlattenAliases,
  normalizeQualifiedValueReference,
  type CodegenOptions,
} from './codegen-expressions.js';
export { transpileExpr } from './codegen-expressions.js';

import {
  buildFqName,
  buildFqNameWithDatabase,
  caseName,
  escapeSqlString,
  formatTableRef,
  getCanonicalDialect,
  getOrThrow,
  quoteColumnAlias,
  quoteLiteral,
  supportsDialectCapability,
  toPolyglotDialect,
  unsupportedDialectFeatureError,
} from './dialect.js';
import { emitExpr, emitOrderByItems, emitWindowFrame, renderOrderByTerm } from './expr/index.js';
import { materializeSql } from './materializer.js';
import { buildCteDefinitions } from './codegen-ctes.js';
import { buildRecursiveSelect } from './recursion.js';
import { dedupeEmulationPlan, planQualifyEmulation, wrapForQualify } from './qualify.js';
import type { QualifyEmulationPlan } from './qualify.js';
import {
  appendSetOperations,
  buildCanonicalBigQuerySetColumns,
  buildSelectStarPart,
  renderCanonicalBigQuerySetProjection,
} from './set-operations.js';

import type { SupportedDialect } from './dialect.js';
import type { DedupeSpec } from './schemas.js';
import { getSourceEntry } from './parser.js';
import type {
  ResolvedFlattenJson,
  ResolvedTransformSpec,
  ResolvedUnpivot,
  SourceEntryRegistry,
} from './parser.js';

/** Pre-compiled regex for detecting `self` references in incremental filters. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SELF_REF_DETECT = /\bself\b/i;

// ---------------------------------------------------------------------------
// Helper: SELECT column list
// ---------------------------------------------------------------------------

/**
 * Build the SELECT column list (including `*`, `* EXCEPT/EXCLUDE`, and
 * explicit column expressions).
 *
 * Returns the joined column SQL string.
 */
function buildSelectClause(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect,
  opts: CodegenOptions
): string {
  const { sourceDialect } = opts;
  const canonicalBigQueryColumns = buildCanonicalBigQuerySetColumns(
    spec,
    dialect,
    opts.entryRegistry
  );
  if (canonicalBigQueryColumns) {
    return renderCanonicalBigQuerySetProjection(
      canonicalBigQueryColumns,
      spec.source.refKey ?? spec.sourceRef,
      spec.source.alias,
      spec.columns,
      dialect,
      opts.entryRegistry,
      (expr) => transpileOrEmit(expr, sourceDialect, dialect, opts)
    );
  }

  const columnParts: string[] = [];

  // SELECT * / SELECT * EXCEPT(...) / SELECT * EXCLUDE(...)
  const starPart = buildSelectStarPart(spec.includeAllColumns, spec.excludeColumns, dialect);
  if (starPart) {
    columnParts.push(starPart);
  }

  // Transpile explicit column expressions for cross-dialect function mapping
  for (const c of spec.columns) {
    const alias = quoteColumnAlias(c.name, dialect);
    const expr = transpileOrEmit(c.expr, sourceDialect, dialect, opts);
    columnParts.push(`${expr} AS ${alias}`);
  }

  return columnParts.join(', ');
}

/**
 * Build a QUALIFY ROW_NUMBER() clause from a dedupe spec.
 *
 * For dialects that support QUALIFY (Snowflake, BigQuery, Databricks, DuckDB),
 * this emits: `QUALIFY ROW_NUMBER() OVER (PARTITION BY <keys> ORDER BY <order_by>) = 1`
 *
 * For dialects without QUALIFY (Postgres, MySQL), callers should wrap the query
 * in an outer subquery with the ROW_NUMBER as a column, then filter on it. Use an
 * ephemeral intermediate model to stage the deduplication in those dialects.
 */
function buildDedupeRowNumber(dedupe: DedupeSpec, dialect: SupportedDialect): string {
  const partitionBy = dedupe.keys.map((k) => caseName(k, dialect)).join(', ');
  let orderByClause = '';
  if (dedupe.order_by && dedupe.order_by.length > 0) {
    const orderItems = dedupe.order_by.map((o) => {
      const dir =
        dedupe.strategy === 'keep_last' ? (o.direction === 'asc' ? 'desc' : 'asc') : o.direction;
      return renderOrderByTerm(
        caseName(o.column, dialect),
        dir.toUpperCase() as 'ASC' | 'DESC',
        o.nulls ? (o.nulls.toUpperCase() as 'FIRST' | 'LAST') : undefined,
        dialect
      );
    });
    orderByClause = ` ORDER BY ${orderItems.join(', ')}`;
  }
  return `ROW_NUMBER() OVER (PARTITION BY ${partitionBy}${orderByClause})`;
}

/** Omits the root source alias when the query only reads a single source and never references it. */
function shouldEmitSourceAlias(spec: ResolvedTransformSpec): boolean {
  if (spec.joins.length > 0 || spec.flattenJson) {
    return true;
  }

  const sourceAlias = spec.source.alias.trim();
  if (sourceAlias.length === 0) {
    return false;
  }

  const sourceAliasPattern = new RegExp(`\\b${escapeRegExp(sourceAlias)}\\s*\\.`, 'i');
  const candidateExpressions = [
    spec.source.filter,
    spec.materializationConfig?.incremental_filter,
    spec.where,
    spec.having,
    spec.qualify,
    ...spec.columns.map((column) => column.expr),
    ...(spec.groupBy ?? []),
    ...(spec.orderBy?.map((orderBy) => orderBy.column) ?? []),
    ...(spec.windows?.flatMap((window) => [
      ...(window.partitionBy ?? []),
      ...(window.orderBy?.map((orderBy) => orderBy.column) ?? []),
      ...(window.frame ? [window.frame] : []),
    ]) ?? []),
  ];

  return candidateExpressions.some(
    (expression): expression is string =>
      typeof expression === 'string' && sourceAliasPattern.test(expression)
  );
}

// ---------------------------------------------------------------------------
// Helper: FROM + JOIN + FLATTEN clauses
// ---------------------------------------------------------------------------

function formatApiResourceRef(
  tableReference: string,
  alias: string | undefined,
  dialect: SupportedDialect
): string {
  const [schema, table] = tableReference.split('.');
  if (!schema || !table) {
    throw new Error(`Invalid api_resource table reference "${tableReference}"`);
  }
  const tableRef = buildFqName(schema, table, dialect);
  return alias ? `${tableRef} AS ${caseName(alias, dialect)}` : tableRef;
}

/**
 * Build the FROM clause (with CTE substitution), JOIN clauses, and
 * FLATTEN clause. Returns a partial SQL string starting from `FROM ...`.
 */
function buildFromJoinClauses(
  spec: ResolvedTransformSpec,
  fqToCte: Map<string, string>,
  dialect: SupportedDialect,
  opts: CodegenOptions
): string {
  const { sourceDialect } = opts;
  const sourceEntry = getSourceEntry(opts.entryRegistry, spec.source.refKey ?? spec.sourceRef);
  // Canonical BigQuery union projection emits `${alias}.<col>` references for
  // include_all_columns even when the user's spec.columns never names the
  // alias. `shouldEmitSourceAlias` can't see those synthetic refs, so we have
  // to force the FROM clause to bind the alias whenever canonical projection
  // is active — otherwise the rendered SQL references an undeclared `t0`.
  const forceSourceAlias =
    getCanonicalDialect(dialect) === 'bigquery' &&
    !!buildCanonicalBigQuerySetColumns(spec, dialect, opts.entryRegistry);
  // Use CTE name instead of fqTableName when available
  const sourceTable = fqToCte.get(spec.source.fqTableName) ?? spec.source.fqTableName;
  const sourceAlias =
    forceSourceAlias || shouldEmitSourceAlias(spec) ? spec.source.alias : undefined;
  const fromTable = fqToCte.has(spec.source.fqTableName)
    ? sourceAlias
      ? `${sourceTable} AS ${caseName(sourceAlias, dialect)}`
      : sourceTable
    : sourceEntry?.kind === 'api_resource'
      ? formatApiResourceRef(sourceEntry.fqRef, sourceAlias, dialect)
      : formatTableRef(sourceTable, sourceAlias, dialect);

  const joinClauses = spec.joins
    .map((join) => {
      const joinEntry = getSourceEntry(opts.entryRegistry, join.ref);
      const joinTable = fqToCte.has(join.fqTableName)
        ? `${getOrThrow(fqToCte, join.fqTableName, 'fqToCte join')} AS ${caseName(join.alias, dialect)}`
        : joinEntry?.kind === 'api_resource'
          ? formatApiResourceRef(joinEntry.fqRef, join.alias, dialect)
          : formatTableRef(join.fqTableName, join.alias, dialect);
      const joinType = join.type.toUpperCase();
      const onClause = transpileOrEmit(join.on, sourceDialect, dialect, opts);
      return `${joinType} JOIN ${joinTable} ON ${onClause}`;
    })
    .join(' ');

  // Build flatten clause if present
  let flattenClause = '';
  if (spec.flattenJson) {
    flattenClause = generateFlattenClause(
      spec.flattenJson,
      spec.source.alias,
      dialect,
      sourceDialect,
      opts
    );
  }

  let result = fromTable;

  if (flattenClause) {
    result += ` ${flattenClause}`;
  }

  if (joinClauses) {
    result += ` ${joinClauses}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: WHERE clause
// ---------------------------------------------------------------------------

/**
 * Build the WHERE clause from source filter, incremental filter, and
 * user-specified WHERE. Returns the full ` WHERE ...` string, or empty
 * string if there are no conditions.
 */
function buildWhereClause(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect,
  opts: CodegenOptions
): string {
  const { sourceDialect, isFullRefresh, warnings, strict, flattenAliases } = opts;
  const whereParts: string[] = [];

  if (spec.source.filter) {
    const filterExpr = transpileOrEmit(spec.source.filter, sourceDialect, dialect, {
      warnings,
      strict,
      flattenAliases,
    });
    whereParts.push(`(${filterExpr})`);
  }
  if (spec.materializationConfig?.incremental_filter && !isFullRefresh) {
    let incFilter = spec.materializationConfig.incremental_filter;
    // Resolve `self` references to the model's target table name (before AST parsing).
    // Edge case: `self` inside SQL string literals would be incorrectly replaced.
    // The `\bself\b` word-boundary guard prevents matching inside words like `myself`,
    // but cannot distinguish quoted string contexts from real identifier references.
    if (opts.targetSchema && SELF_REF_DETECT.test(incFilter)) {
      // Use the same 3-part qualification (database.schema.table) as upstream
      // model refs so the compiled SQL is executable against a session with no
      // default database — without this, Snowflake returns error 391918 for
      // any caller that doesn't pre-set DEFAULT_NAMESPACE.
      const selfFqName = opts.targetDatabase
        ? buildFqNameWithDatabase(opts.targetSchema, spec.name, dialect, opts.targetDatabase)
        : buildFqName(opts.targetSchema, spec.name, dialect);
      incFilter = incFilter.replaceAll(/\bself\b/gi, selfFqName);
    }
    const incExpr = transpileOrEmit(incFilter, sourceDialect, dialect, {
      warnings,
      strict,
      flattenAliases,
    });
    whereParts.push(`(${incExpr})`);
  }
  if (spec.where) {
    const whereExpr = transpileOrEmit(spec.where, sourceDialect, dialect, {
      warnings,
      strict,
      flattenAliases,
    });
    whereParts.push(`(${whereExpr})`);
  }

  if (whereParts.length > 0) {
    return ` WHERE ${whereParts.join(' AND ')}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the SELECT portion of a query from a resolved transform spec.
 *
 * When `cteMap` is provided, any source or join whose fqTableName appears
 * in the map is replaced with a CTE reference. The CTE definitions are
 * prepended as a WITH clause.
 *
 * When `sourceDialect` differs from `dialect`, individual column expressions
 * are transpiled for cross-dialect function mapping.
 */
export function generateSelectSql(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect = 'snowflake',
  cteMap?: Map<string, string>,
  options?: {
    sourceDialect?: SupportedDialect;
    isFullRefresh?: boolean;
    /** Target schema for resolving `self` references in incremental filters. */
    targetSchema?: string;
    /** Target database for fully-qualifying `self` references (Snowflake/BigQuery/Databricks). */
    targetDatabase?: string;
    /** Collects warnings (e.g. raw_sql fallbacks) for this compilation. */
    warnings?: string[];
    /** Reject implicit raw_sql fallbacks (parse failures). Explicit raw_sql() calls are still allowed. */
    strict?: boolean;
    /** Source entry metadata, used to render api_resource refs as sources.<name>. */
    entryRegistry?: SourceEntryRegistry;
  }
): string {
  const polyDialect = toPolyglotDialect(dialect);
  const sourceDialect = options?.sourceDialect ?? dialect;
  const opts: CodegenOptions = {
    sourceDialect,
    isFullRefresh: options?.isFullRefresh ?? false,
    targetSchema: options?.targetSchema,
    targetDatabase: options?.targetDatabase,
    warnings: options?.warnings,
    strict: options?.strict,
    flattenAliases: collectFlattenAliases(spec.flattenJson),
    entryRegistry: options?.entryRegistry,
  };
  opts.modelName = spec.name;
  opts.namedWindows = resolveNamedWindows(spec, dialect, opts);

  // QUALIFY has to be decided before the SELECT list is built: on a target
  // without the clause, the predicate's window expressions are hoisted into that
  // list and filtered from a wrapping subquery.
  if (spec.dedupe && spec.qualify) {
    throw new Error(
      `Model "${spec.name}" cannot set both "qualify" and "dedupe" — use one or the other`
    );
  }
  let nativeQualifyClause: string | undefined;
  let qualifyEmulation: QualifyEmulationPlan | undefined;
  if (spec.qualify || spec.dedupe) {
    const dedupeRowNumber = spec.dedupe ? buildDedupeRowNumber(spec.dedupe, dialect) : undefined;
    if (supportsDialectCapability(dialect, 'qualify')) {
      nativeQualifyClause = spec.qualify
        ? transpileOrEmit(spec.qualify, sourceDialect, dialect, opts)
        : `${dedupeRowNumber} = 1`;
    } else {
      // The hoisted helper column would be returned by `SELECT *`, and neither
      // target needing this rewrite has a star-except modifier to drop it.
      if (spec.includeAllColumns) {
        throw unsupportedDialectFeatureError(
          dialect,
          'qualify',
          `Model "${spec.name}" combines include_all_columns with ` +
            `${spec.qualify ? 'qualify' : 'dedupe'}, and target "${dialect}" has no QUALIFY ` +
            `clause. Emulating it adds a helper column that "SELECT *" would return, and ` +
            `"${dialect}" has no SELECT * EXCEPT to remove it. List the columns explicitly.`
        );
      }
      qualifyEmulation = spec.qualify
        ? planQualifyEmulation(spec.qualify, {
            emit: (expr) => emitExpr(prepareAstForEmit(expr, dialect, opts), dialect),
            dialect,
            modelName: spec.name,
          })
        : dedupeEmulationPlan(dedupeRowNumber ?? '', dialect);
    }
  }

  // 1. Build CTE definitions (ephemeral refs + pre-aggregate CTEs)
  const {
    cteDefs,
    fqToCte,
    inlineFqToCte,
    recursive: cteRecursive,
  } = buildCteDefinitions(spec, cteMap, dialect, opts);

  // 2. Build SELECT column list
  const declaredColumnsSql = buildSelectClause(spec, dialect, opts);
  let columnsSql = declaredColumnsSql;
  if (qualifyEmulation && qualifyEmulation.selectItems.length > 0) {
    // The window expression stays in this list rather than one level out, so it
    // still reads every source column instead of only the projected ones.
    // `declaredColumnsSql` deliberately keeps the original list: set-operation
    // branches are rendered from it, and giving them the helper column too
    // would make the branches wider than the wrapped first branch.
    columnsSql += `, ${qualifyEmulation.selectItems.join(', ')}`;
  }

  // 3. Build FROM + JOIN + FLATTEN clauses
  const fromJoinSql = buildFromJoinClauses(spec, fqToCte, dialect, opts);

  // 4. Build WHERE clause
  const whereSql = buildWhereClause(spec, dialect, opts);

  // Assemble the core SELECT statement
  // With an emulated QUALIFY, DISTINCT is applied by the wrapping SELECT instead:
  // SQL evaluates DISTINCT after QUALIFY, and leaving it here would deduplicate
  // on the hoisted predicate column too.
  const selectKeyword = spec.distinct && !qualifyEmulation ? 'SELECT DISTINCT' : 'SELECT';
  let rawSql = `${selectKeyword} ${columnsSql} FROM ${fromJoinSql}${whereSql}`;

  // GROUP BY support
  // When a group_by entry is a bare identifier that matches a column name,
  // resolve it to the column's expression (which is already alias-qualified
  // from ref substitution, e.g. t0."EVENT_ID"). This prevents ambiguous
  // column references in JOINs where multiple tables share the same column name.
  // Also include flatten aliases so group_by: [flattened] resolves correctly.
  if (spec.groupBy && spec.groupBy.length > 0) {
    const colExprMap =
      spec.joins.length > 0 || spec.flattenJson
        ? new Map(spec.columns.map((c) => [c.name.toLowerCase(), c.expr]))
        : undefined;
    if (spec.flattenJson && colExprMap) {
      for (const flatten of spec.flattenJson) {
        const flattenAlias = getFlattenAlias(flatten).toLowerCase();
        colExprMap.set(flattenAlias, caseName(flattenAlias, dialect));
      }
    }
    const groupByCols = spec.groupBy
      .map((g) => {
        if (colExprMap && !g.includes('.')) {
          const colExpr = colExprMap.get(g.toLowerCase());
          if (colExpr) return colExpr;
        }
        return normalizeQualifiedValueReference(g, dialect, opts.flattenAliases);
      })
      .join(', ');
    rawSql += ` GROUP BY ${groupByCols}`;
  }

  // HAVING support
  if (spec.having) {
    const havingExpr = transpileOrEmit(spec.having, sourceDialect, dialect, opts);
    rawSql += ` HAVING ${havingExpr}`;
  }

  // WINDOW clause (named windows) — must come before ORDER BY per SQL standard.
  // Targets without a WINDOW clause had each reference inlined at emit time, so
  // there is nothing left to declare here.
  if (spec.windows && spec.windows.length > 0 && opts.namedWindows) {
    if (supportsDialectCapability(dialect, 'namedWindowClause')) {
      const windowDefs = spec.windows
        .map((w) => {
          const resolved = opts.namedWindows?.get(w.name.toLocaleLowerCase());
          if (!resolved) {
            throw new Error(`Model "${spec.name}" window "${w.name}" failed to resolve`);
          }
          const parts: string[] = [];
          if (resolved.partitionBy && resolved.partitionBy.length > 0) {
            parts.push(
              `PARTITION BY ${resolved.partitionBy.map((e) => emitExpr(e, dialect)).join(', ')}`
            );
          }
          if (resolved.orderBy && resolved.orderBy.length > 0) {
            const logicalFrame =
              resolved.frame?.type === 'RANGE' || resolved.frame?.type === 'GROUPS';
            parts.push(`ORDER BY ${emitOrderByItems(resolved.orderBy, dialect, { logicalFrame })}`);
          }
          if (resolved.frame) {
            parts.push(emitWindowFrame(resolved.frame, dialect));
          }
          return `${caseName(w.name, dialect)} AS (${parts.join(' ')})`;
        })
        .join(', ');
      rawSql += ` WINDOW ${windowDefs}`;
    }
  }

  // QUALIFY is emitted natively where the target has the clause. Where it does
  // not, `qualifyEmulation` was planned before the SELECT list was built, and
  // the statement is wrapped here — ahead of ORDER BY and LIMIT, so those keep
  // landing outside the filter exactly as they do with the native clause.
  if (nativeQualifyClause) {
    rawSql += ` QUALIFY ${nativeQualifyClause}`;
  }
  if (qualifyEmulation) {
    rawSql = wrapForQualify(rawSql, spec.columns, qualifyEmulation, dialect, {
      distinct: spec.distinct === true,
    });
  }

  // ORDER BY, LIMIT and OFFSET keep their existing position for every model
  // except a recursive one. A recursive model applies them to the closure in the
  // outer SELECT rather than to the anchor rows inside the CTE, so only that
  // case defers them; deferring unconditionally would move them across the
  // union, pivot and unpivot steps below and change what existing models emit.
  let outerSuffix = '';
  if (spec.orderBy && spec.orderBy.length > 0) {
    const orderCols = spec.orderBy
      .map((o) =>
        renderOrderByTerm(
          normalizeQualifiedValueReference(o.column, dialect, opts.flattenAliases),
          o.direction ? (o.direction.toUpperCase() as 'ASC' | 'DESC') : undefined,
          o.nulls ? (o.nulls.toUpperCase() as 'FIRST' | 'LAST') : undefined,
          dialect
        )
      )
      .join(', ');
    outerSuffix += ` ORDER BY ${orderCols}`;
  }
  if (spec.limit !== undefined) {
    outerSuffix += ` LIMIT ${spec.limit}`;
  }
  if (spec.offset !== undefined) {
    outerSuffix += ` OFFSET ${spec.offset}`;
  }
  if (!spec.recurse) {
    rawSql += outerSuffix;
    outerSuffix = '';
  }

  // Pivot support
  if (spec.pivot) {
    rawSql = generatePivotSql(rawSql, spec.pivot, dialect);
  }

  // Prepend WITH clause if there are CTEs
  if (cteDefs.length > 0) {
    const withClause = cteDefs.map((cte) => `${cte.cteName} AS (${cte.sql})`).join(', ');
    rawSql = `WITH ${cteRecursive ? 'RECURSIVE ' : ''}${withClause} ${rawSql}`;
  }

  // Union support — render `<setOp> SELECT ...` per branch.
  if (spec.union && spec.union.length > 0) {
    rawSql = appendSetOperations(
      rawSql,
      spec,
      declaredColumnsSql,
      spec.source.alias,
      dialect,
      options?.entryRegistry,
      (expr) => transpileOrEmit(expr, sourceDialect, dialect, opts),
      formatApiResourceRef,
      inlineFqToCte
    );
  }

  // Unpivot support (moved after union so unpivot applies to combined result)
  if (spec.unpivot) {
    rawSql = generateUnpivotSql(rawSql, spec.unpivot, dialect);
  }

  // Recursion wraps everything built so far: the SELECT assembled above is the
  // anchor that seeds the walk, and the step joins the source back to the
  // in-progress result. The schema rejects recursion alongside the clauses that
  // reshape the FROM clause or run after aggregation, so nothing above this
  // point can conflict with the wrap.
  if (spec.recurse) {
    rawSql = buildRecursiveSelect({
      anchorSql: rawSql,
      stepSourceTable: fqToCte.get(spec.recurse.stepSourceTable) ?? spec.recurse.stepSourceTable,
      stepSourceIsCte: fqToCte.has(spec.recurse.stepSourceTable),
      recurse: spec.recurse.spec,
      outputColumns: spec.columns.map((c) => ({ name: c.name })),
      ...(spec.recurse.hierarchy ? { hierarchy: spec.recurse.hierarchy } : {}),
      modelName: spec.name,
      dialect,
      outerSuffix,
    });
    outerSuffix = '';
  }
  rawSql += outerSuffix;

  // Run through transpile() for dialect validation & normalisation
  const result = transpile(rawSql, polyDialect, polyDialect);
  const normalized = result.sql?.[0];
  if (!normalized) {
    // Carry the transpiler's own diagnostic. A bare "transpilation failed"
    // leaves no way to tell a malformed expression from an unsupported
    // construct; set BOBSLED_CORE_MODEL_SPEC_DEBUG_SQL to also dump the emitted statement.
    const detail = typeof result.error === 'string' ? `: ${result.error}` : '';
    throw new Error(
      `SQL transpilation failed for model "${spec.name}"${detail}` +
        (process.env.BOBSLED_CORE_MODEL_SPEC_DEBUG_SQL ? `\n--- emitted SQL ---\n${rawSql}` : '')
    );
  }
  const transpiled = preserveWindowSemantics(rawSql, normalized, spec.name, opts.warnings);

  // Append derived columns as outer SELECT if present
  if (spec.derivedColumns && spec.derivedColumns.length > 0) {
    return wrapWithDerivedColumns(transpiled, spec, sourceDialect, dialect, opts);
  }

  return transpiled;
}

/**
 * Keep the emitted SQL when the same-dialect normalisation pass would drop
 * window semantics we deliberately emitted.
 *
 * `transpile(sql, d, d)` is run for validation and formatting, not to change
 * meaning, but its round trip rewrites three constructs in ways that change
 * results:
 *
 * - `NULLS LAST` inside a window ORDER BY is dropped on BigQuery, DuckDB and
 *   MySQL, and inside a WINDOW clause on Snowflake, Postgres, Redshift, DuckDB
 *   and MySQL. Null placement decides which row `ROW_NUMBER() = 1` returns, so
 *   losing it changes `dedupe` and `qualify` results.
 * - The frame `EXCLUDE` clause is dropped.
 * - `QUALIFY` is rewritten into a wrapping subquery for Postgres-family
 *   targets, and the rewrite moves `LIMIT` inside the subquery, so rows are
 *   taken before the window filter rather than after. On a fixture of three
 *   users with two rows each, `QUALIFY ... = 1 ORDER BY user_id LIMIT 2`
 *   returns two rows and the rewrite returns one. Redshift supports QUALIFY
 *   natively, so keeping the emitted form is both correct and simpler; targets
 *   with no QUALIFY clause never reach here, because their predicate was
 *   already hoisted into a subquery by `planQualifyEmulation`.
 *
 * Where a marker count falls, the pre-normalisation SQL is used instead: it is
 * what the dialect-aware emitter produced, so it is already valid for the
 * target, and only the cosmetic normalisation is given up.
 */
function preserveWindowSemantics(
  emitted: string,
  normalized: string,
  modelName: string,
  warnings?: string[]
): string {
  const markers: ReadonlyArray<readonly [string, RegExp]> = [
    ['NULLS FIRST/LAST', /\bNULLS\s+(?:FIRST|LAST)\b/gi],
    ['frame EXCLUDE', /\bEXCLUDE\s+(?:CURRENT\s+ROW|GROUP|TIES|NO\s+OTHERS)\b/gi],
    ['QUALIFY', /\bQUALIFY\b/gi],
  ];
  for (const [label, pattern] of markers) {
    const before = emitted.match(pattern)?.length ?? 0;
    const after = normalized.match(pattern)?.length ?? 0;
    if (after < before) {
      warnings?.push(
        `Model "${modelName}": SQL normalisation dropped ${label}; kept the emitted SQL instead`
      );
      return emitted;
    }
  }
  return normalized;
}

/**
 * Generate full DDL from a resolved transform spec.
 *
 * Uses the materializer to wrap SELECT SQL in the appropriate DDL
 * based on the spec's materialization type.
 */
export function generateSql(
  spec: ResolvedTransformSpec,
  targetSchema: string,
  dialect: SupportedDialect = 'snowflake',
  cteMap?: Map<string, string>,
  options?: {
    sourceDialect?: SupportedDialect;
    isFullRefresh?: boolean;
    /** Collects warnings (e.g. raw_sql fallbacks) for this compilation. */
    warnings?: string[];
    /** Reject implicit raw_sql fallbacks. */
    strict?: boolean;
    /** Target database for DDL (e.g., Snowflake). Per-model spec.targetDatabase takes precedence. */
    targetDatabase?: string;
    /** Default Snowflake warehouse for dynamic table DDL. Per-model materialization config takes precedence. */
    defaultDynamicTableWarehouse?: string;
    /** Source entry metadata, used to render api_resource refs as sources.<name>. */
    entryRegistry?: SourceEntryRegistry;
  }
): string {
  // Use per-model target schema/database if specified, otherwise use global
  const effectiveSchema = spec.targetSchema ?? targetSchema;
  const effectiveDatabase = spec.targetDatabase ?? options?.targetDatabase;
  const selectSql = generateSelectSql(spec, dialect, cteMap, {
    ...options,
    targetSchema: effectiveSchema,
    targetDatabase: effectiveDatabase,
  });
  const header = buildMetadataHeader(spec);
  const ddlStatements = materializeSql(
    selectSql,
    spec,
    effectiveSchema,
    dialect,
    { defaultDynamicTableWarehouse: options?.defaultDynamicTableWarehouse },
    effectiveDatabase
  );
  if (ddlStatements.length === 0) return ''; // ephemeral
  return ddlStatements.map((stmt) => `${header}${stmt}`).join('\n\n');
}

// ---------------------------------------------------------------------------
// Metadata header
// ---------------------------------------------------------------------------

export function buildMetadataHeader(spec: ResolvedTransformSpec): string {
  const lines: string[] = [];
  lines.push(`-- Model: ${spec.name}`);

  if (spec.description) {
    lines.push(`-- Description: ${spec.description.replace(/[\r\n]+/g, ' ')}`);
  }

  if (spec.grain) {
    const grain = Array.isArray(spec.grain) ? spec.grain.join(', ') : spec.grain;
    lines.push(`-- Grain: ${grain}`);
  }

  // Trust tier
  lines.push(`-- Trust: ${spec.trustTier}`);

  // Collect all refs (raw ref names)
  const refs: string[] = [];
  if (spec.sourceRef) refs.push(spec.sourceRef);
  for (const join of spec.joins) {
    if (join.ref) refs.push(join.ref);
  }
  if (refs.length > 0) {
    lines.push(`-- Refs: ${refs.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the flatten step's input SQL — either an inline expression (`input`)
 * or a qualified source column (`column`). The schema guarantees exactly one is
 * present, so the trailing throw is a defense-in-depth invariant check.
 */
function resolveFlattenInputSql(
  flatten: ResolvedFlattenJson,
  sourceAlias: string,
  dialect: SupportedDialect,
  sourceDialect: SupportedDialect,
  opts: CodegenOptions,
  availableAliases: ReadonlySet<string>
): string {
  if (flatten.input) {
    return transpileOrEmit(flatten.input, sourceDialect, dialect, {
      warnings: opts.warnings,
      strict: opts.strict,
      flattenAliases: availableAliases,
    });
  }
  if (flatten.column) {
    return `${caseName(sourceAlias, dialect)}.${caseName(flatten.column, dialect)}`;
  }
  throw new Error('flatten_json requires either column or input');
}

function generateFlattenClause(
  flattenSteps: ResolvedFlattenJson[],
  sourceAlias: string,
  dialect: SupportedDialect,
  sourceDialect: SupportedDialect,
  opts: CodegenOptions
): string {
  if (!supportsDialectCapability(dialect, 'flattenJson')) {
    throw unsupportedDialectFeatureError(
      dialect,
      'flattenJson',
      `flatten_json is not supported for compiler target "${dialect}"`
    );
  }
  const availableAliases = new Set<string>();

  return flattenSteps
    .map((flatten) => {
      if (flatten.outer && !supportsDialectCapability(dialect, 'outerFlatten')) {
        throw unsupportedDialectFeatureError(
          dialect,
          'outerFlatten',
          `flatten_json "outer: true" is not supported for compiler target "${dialect}" — use a LEFT JOIN subquery instead`
        );
      }

      const alias = getFlattenAlias(flatten);
      const inputSql = resolveFlattenInputSql(
        flatten,
        sourceAlias,
        dialect,
        sourceDialect,
        opts,
        availableAliases
      );

      availableAliases.add(alias.toLowerCase());

      switch (getCanonicalDialect(dialect)) {
        case 'snowflake': {
          const safePath = flatten.path ? escapeSqlString(flatten.path, dialect) : '';
          const pathExpr = flatten.path ? `, PATH => '${safePath}'` : '';
          const outerExpr = flatten.outer ? ', OUTER => TRUE' : '';
          return `, LATERAL FLATTEN(INPUT => ${inputSql}${pathExpr}${outerExpr}) AS ${caseName(alias, dialect)}`;
        }
        case 'bigquery': {
          const safePath = flatten.path ? escapeSqlString(flatten.path, dialect) : '';
          const pathExpr = flatten.path ? `'$.${safePath}'` : '';
          const jsonExtract = pathExpr
            ? `JSON_EXTRACT_ARRAY(${inputSql}, ${pathExpr})`
            : `JSON_EXTRACT_ARRAY(${inputSql})`;
          if (flatten.outer) {
            return ` LEFT JOIN UNNEST(${jsonExtract}) AS ${caseName(alias, dialect)} ON TRUE`;
          }
          return `, UNNEST(${jsonExtract}) AS ${caseName(alias, dialect)}`;
        }
        case 'postgres': {
          const pathTarget = flatten.path
            ? flatten.path
                .split('.')
                .filter((part) => part.length > 0)
                .reduce((sql, part) => `${sql} -> '${escapeSqlString(part, dialect)}'`, inputSql)
            : inputSql;
          if (flatten.outer) {
            return ` LEFT JOIN LATERAL json_array_elements(${pathTarget}) AS ${caseName(alias, dialect)} ON TRUE`;
          }
          return `, json_array_elements(${pathTarget}) AS ${caseName(alias, dialect)}`;
        }
        case 'databricks': {
          const explodeFunc = flatten.outer ? 'EXPLODE_OUTER' : 'EXPLODE';
          const pathExpr = flatten.path
            ? `.${flatten.path
                .split('.')
                .filter((part) => part.length > 0)
                .join('.')}`
            : '';
          return ` LATERAL VIEW ${explodeFunc}(${inputSql}${pathExpr}) AS ${caseName(alias, dialect)}`;
        }
        case 'mysql': {
          const safePath = flatten.path ? escapeSqlString(flatten.path, dialect) : '';
          const pathExpr = safePath ? `'$.${safePath}[*]'` : `'$[*]'`;
          return `, JSON_TABLE(${inputSql}, ${pathExpr} COLUMNS(value JSON PATH '$')) AS ${caseName(alias, dialect)}`;
        }
        case 'duckdb': {
          if (flatten.path) {
            const safePath = escapeSqlString(flatten.path, dialect);
            return `, UNNEST(json_extract(${inputSql}, '$.${safePath}')) AS ${caseName(alias, dialect)}`;
          }
          return `, UNNEST(${inputSql}) AS ${caseName(alias, dialect)}`;
        }
        case 'clickhouse':
          // Unreachable today: `flattenJson` is false for ClickHouse, so the
          // guard at the top of generateFlattenClause throws first. Kept so the
          // switch stays exhaustive if that capability is ever turned on.
          throw unsupportedDialectFeatureError(
            dialect,
            'flattenJson',
            `flatten_json is not supported for compiler target "${dialect}"`
          );
      }
    })
    .join('');
}

/**
 * Map a set operation type to its SQL keyword, accounting for dialect differences.
 *
 * Note: The polyglot-sql transpiler normalizes MINUS to EXCEPT even for Snowflake,
 * so we emit EXCEPT for all dialects to match actual transpiler behavior.
 * All supported dialects accept EXCEPT (Snowflake also accepts MINUS as synonym).
 *
 * - Snowflake: EXCEPT and MINUS both work; transpiler normalizes to EXCEPT
 * - Other dialects: EXCEPT is standard
 * - INTERSECT: universal across all supported dialects
 * - UNION: universal (deduplicates)
 * - UNION ALL: universal (preserves duplicates)
 */
function generatePivotSql(
  baseSql: string,
  pivot: { column: string; values: (string | number)[]; aggregate: string; value_column: string },
  dialect: SupportedDialect
): string {
  const { column, values, aggregate, value_column } = pivot;
  const valuesList = values.map((v) => quoteLiteral(v, dialect)).join(', ');

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
    case 'databricks':
    case 'duckdb':
      return `SELECT * FROM (${baseSql}) PIVOT(${aggregate.toUpperCase()}(${caseName(value_column, dialect)}) FOR ${caseName(column, dialect)} IN (${valuesList}))`;
    case 'bigquery':
    case 'postgres':
    case 'mysql':
    case 'clickhouse': {
      // Conditional aggregation fallback — wrap baseSql as subquery to avoid fragile regex replacement
      const pivotCols = values
        .map((v) => {
          const valStr = quoteLiteral(v, dialect);
          const colAlias = typeof v === 'string' ? caseName(v, dialect) : `_${v}`;
          return `${aggregate.toUpperCase()}(CASE WHEN ${caseName(column, dialect)} = ${valStr} THEN ${caseName(value_column, dialect)} END) AS ${colAlias}`;
        })
        .join(', ');
      return `SELECT ${pivotCols} FROM (${baseSql}) AS __pivot_src`;
    }
  }
}

function generateUnpivotSql(
  baseSql: string,
  unpivot: ResolvedUnpivot,
  dialect: SupportedDialect
): string {
  const { columns, exclude, field_name, value_name, cast_to } = unpivot;

  const fieldName = caseName(field_name, dialect);
  const valueName = caseName(value_name, dialect);
  const colList = columns.map((c) => caseName(c, dialect)).join(', ');

  const excludeCols = exclude ?? [];
  const excludeStr =
    excludeCols.length > 0 ? excludeCols.map((c) => caseName(c, dialect)).join(', ') + ', ' : '';

  // Native UNPIVOT for dialects that support it (only when no cast_to — native syntax lacks CAST)
  const canonicalDialect = getCanonicalDialect(dialect);
  if (
    !cast_to &&
    (canonicalDialect === 'snowflake' ||
      canonicalDialect === 'databricks' ||
      canonicalDialect === 'duckdb')
  ) {
    const projectedCols = [...excludeCols, fieldName, valueName]
      .map((c) => caseName(c, dialect))
      .join(', ');
    return `SELECT ${projectedCols} FROM (${baseSql}) UNPIVOT(${valueName} FOR ${fieldName} IN (${colList}))`;
  }

  // UNION ALL fallback for all other cases (cast_to, BigQuery, Postgres, MySQL)
  const unionParts = columns.map((col) => {
    const colName = caseName(col, dialect);
    const fieldLiteral = quoteLiteral(caseName(col, dialect), dialect);
    const valueExpr = cast_to ? `CAST(${colName} AS ${cast_to})` : colName;
    return `SELECT ${excludeStr}${fieldLiteral} AS ${fieldName}, ${valueExpr} AS ${valueName} FROM (${baseSql}) AS __unpivot_src`;
  });
  return unionParts.join(' UNION ALL ');
}

function wrapWithDerivedColumns(
  innerSql: string,
  spec: ResolvedTransformSpec,
  sourceDialect: SupportedDialect,
  targetDialect: SupportedDialect,
  options?: { warnings?: string[]; strict?: boolean }
): string {
  const baseCols = spec.includeAllColumns
    ? '*'
    : spec.columns.map((c) => quoteColumnAlias(c.name, targetDialect)).join(', ');

  const derived = spec.derivedColumns;
  if (!derived || derived.length === 0) return innerSql;

  const derivedCols = derived
    .map((dc) => {
      const expr = transpileOrEmit(dc.expr, sourceDialect, targetDialect, options);
      return `${expr} AS ${quoteColumnAlias(dc.name, targetDialect)}`;
    })
    .join(', ');

  return `SELECT ${baseCols}, ${derivedCols} FROM (${innerSql}) AS __base`;
}
