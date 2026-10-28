/**
 * Column-level lineage extraction from expression ASTs.
 *
 * Walks each column's expression to find column_ref nodes, mapping output
 * columns to their upstream source/model columns.
 */

import { parseExprField } from './expr/index.js';
import { walkExpr } from './expr/walker.js';

import type { ResolvedTransformSpec } from './parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnLineageUpstream {
  /** Table alias (t0, t1, etc.) or undefined for unqualified refs */
  alias?: string;
  /** Resolved source/model name (e.g. "ecom.raw_orders" or "stg_orders") */
  source?: string;
  /** Source column name */
  column: string;
}

export interface ColumnLineageEntry {
  /** Model name */
  model: string;
  /** Output column name */
  column: string;
  /** Upstream column dependencies */
  upstream: ColumnLineageUpstream[];
  /** false when provenance is opaque, including agentic outputs, raw SQL, or subqueries */
  isComplete: boolean;
}

export interface SourceColumnState {
  /** Explicitly known output columns for a source or upstream model. */
  columns: string[];
  /** True when the upstream model still has unresolved passthrough columns. */
  hasUnknownPassthrough: boolean;
}

export interface ColumnLineageOptions {
  /**
   * Optional resolved column names by source/model ref. Used to expand
   * include_all_columns passthrough edges when the upstream schema is known.
   */
  sourceColumns?: Map<string, SourceColumnState>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract column-level lineage from a resolved transform spec.
 *
 * For each column, parses the expression through the AST and collects
 * all column_ref nodes. Table aliases (t0, t1, ...) are resolved back
 * to the original source/model ref name.
 */
export function extractColumnLineage(
  spec: ResolvedTransformSpec,
  options: ColumnLineageOptions = {}
): ColumnLineageEntry[] {
  // Build alias → ref name map: t0 → sourceRef, t1 → first join ref, etc.
  const aliasToRef = new Map<string, string>();
  aliasToRef.set(spec.source.alias, spec.sourceRef);
  for (const join of spec.joins) {
    aliasToRef.set(join.alias, join.ref);
  }

  const entries: ColumnLineageEntry[] = [];
  const globalLineage = collectIndirectUpstream(spec, aliasToRef);
  const joinLineageByAlias = collectJoinLineageByAlias(spec, aliasToRef);
  const incompleteTransforms =
    (spec.flattenJson?.length ?? 0) > 0 || spec.pivot !== undefined || spec.unpivot !== undefined;

  for (const col of spec.columns) {
    const ast = parseExprField(col.expr);
    const upstream: ColumnLineageUpstream[] = [];
    let isComplete = !incompleteTransforms && globalLineage.isComplete;

    walkExpr(ast, (node) => {
      if (node.kind === 'column_ref') {
        const source = node.table ? aliasToRef.get(node.table) : undefined;
        upstream.push({
          alias: node.table,
          source,
          column: node.column,
        });
      }
      if (
        node.kind === 'raw_sql' ||
        node.kind === 'subquery' ||
        node.kind === 'in_subquery' ||
        node.kind === 'exists'
      ) {
        isComplete = false;
      }
    });

    // Collect join additions separately to avoid mutating `upstream` during iteration.
    const joinAdditions: ColumnLineageUpstream[] = [];
    for (const ref of upstream) {
      if (!ref.alias) continue;
      const joinLineage = joinLineageByAlias.get(ref.alias);
      if (!joinLineage) continue;
      if (!joinLineage.isComplete) isComplete = false;
      joinAdditions.push(...joinLineage.upstream);
    }
    upstream.push(...joinAdditions, ...globalLineage.upstream);

    entries.push({
      model: spec.name,
      column: col.name,
      upstream: dedupeUpstream(upstream),
      isComplete,
    });
  }

  if (spec.includeAllColumns) {
    const explicitColumns = new Set(spec.columns.map((col) => col.name.toLowerCase()));
    const excludedColumns = new Set((spec.excludeColumns ?? []).map((col) => col.toLowerCase()));
    const passthroughState = options.sourceColumns?.get(spec.sourceRef);
    const hasUnknownPassthrough = passthroughState?.hasUnknownPassthrough ?? false;
    const resolvedPassthroughColumns =
      passthroughState && passthroughState.columns.length > 0
        ? passthroughState.columns
        : undefined;
    const passthroughComplete =
      resolvedPassthroughColumns !== undefined &&
      !hasUnknownPassthrough &&
      !incompleteTransforms &&
      globalLineage.isComplete;

    for (const column of resolvedPassthroughColumns ?? []) {
      if (explicitColumns.has(column.toLowerCase()) || excludedColumns.has(column.toLowerCase())) {
        continue;
      }
      entries.push({
        model: spec.name,
        column,
        upstream: dedupeUpstream([
          {
            alias: spec.source.alias,
            source: spec.sourceRef,
            column,
          },
          ...globalLineage.upstream,
        ]),
        isComplete: passthroughComplete,
      });
    }

    if (!resolvedPassthroughColumns || hasUnknownPassthrough) {
      entries.push({
        model: spec.name,
        column: '*',
        upstream: dedupeUpstream([
          {
            alias: spec.source.alias,
            source: spec.sourceRef,
            column: '*',
          },
          ...globalLineage.upstream,
        ]),
        isComplete: false,
      });
    }
  }

  return entries;
}

/**
 * Collects row-filtering dependencies that constrain every output column.
 */
function collectIndirectUpstream(
  spec: ResolvedTransformSpec,
  aliasToRef: Map<string, string>
): { upstream: ColumnLineageUpstream[]; isComplete: boolean } {
  return collectMany([spec.source.filter, spec.where, spec.having, spec.qualify], aliasToRef);
}

/**
 * Collects join predicate dependencies by joined alias for conditional propagation.
 */
function collectJoinLineageByAlias(
  spec: ResolvedTransformSpec,
  aliasToRef: Map<string, string>
): Map<string, { upstream: ColumnLineageUpstream[]; isComplete: boolean }> {
  const refsByAlias = new Map<string, { upstream: ColumnLineageUpstream[]; isComplete: boolean }>();
  for (const join of spec.joins) {
    refsByAlias.set(join.alias, collectUpstream(join.on, aliasToRef));
  }
  return refsByAlias;
}

/**
 * Walks one expression and reports upstream refs plus whether traversal stayed transparent.
 */
function collectUpstream(
  expr: string,
  aliasToRef: Map<string, string>
): { upstream: ColumnLineageUpstream[]; isComplete: boolean } {
  const ast = parseExprField(expr);
  const upstream: ColumnLineageUpstream[] = [];
  let isComplete = true;
  walkExpr(ast, (node) => {
    if (node.kind === 'column_ref') {
      upstream.push({
        alias: node.table,
        source: node.table ? aliasToRef.get(node.table) : undefined,
        column: node.column,
      });
    }
    if (
      node.kind === 'raw_sql' ||
      node.kind === 'subquery' ||
      node.kind === 'in_subquery' ||
      node.kind === 'exists'
    ) {
      isComplete = false;
    }
  });
  return { upstream: dedupeUpstream(upstream), isComplete };
}

/**
 * Merges upstream refs and completeness flags across optional expressions.
 */
function collectMany(
  exprs: Array<string | undefined>,
  aliasToRef: Map<string, string>
): { upstream: ColumnLineageUpstream[]; isComplete: boolean } {
  const upstream: ColumnLineageUpstream[] = [];
  let isComplete = true;
  for (const expr of exprs) {
    if (!expr) continue;
    const result = collectUpstream(expr, aliasToRef);
    upstream.push(...result.upstream);
    if (!result.isComplete) isComplete = false;
  }
  return { upstream: dedupeUpstream(upstream), isComplete };
}

/**
 * Preserves first-seen order while removing repeated upstream references.
 */
function dedupeUpstream(upstream: ColumnLineageUpstream[]): ColumnLineageUpstream[] {
  const seen = new Set<string>();
  const deduped: ColumnLineageUpstream[] = [];
  for (const ref of upstream) {
    const key = `${ref.alias ?? ''}\0${ref.source ?? ''}\0${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}
