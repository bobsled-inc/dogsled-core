/**
 * QUALIFY emulation for targets that do not have the clause.
 *
 * `QUALIFY` filters on window results, evaluated after WHERE, GROUP BY and
 * HAVING but before ORDER BY and LIMIT. Postgres and MySQL have no such clause,
 * which made `qualify` unusable there and took `dedupe` with it, since dedupe
 * compiles to `QUALIFY ROW_NUMBER() ... = 1`.
 *
 * The rewrite is the standard one: hoist each window expression out of the
 * predicate into the inner SELECT under a generated alias, then wrap the query
 * once and filter on those aliases.
 *
 *   SELECT <declared columns>
 *   FROM (
 *     SELECT <declared columns>, ROW_NUMBER() OVER (...) AS __bms_qualify_0
 *     FROM ... WHERE ... GROUP BY ...
 *   ) AS __bms_qualified
 *   WHERE __bms_qualify_0 = 1
 *
 * The window expression stays in the *original* SELECT list, so it still reads
 * every source column. Computing it one level out instead would restrict it to
 * whatever the model happens to project, and silently change which row a
 * `ROW_NUMBER() = 1` keeps.
 */

import { caseName, quoteColumnAlias } from './dialect.js';
import { mapExpr, parseExprField } from './expr/index.js';

import type { SupportedDialect } from './dialect.js';
import type { DogsledExpr } from './expr/index.js';

const QUALIFY_ALIAS_PREFIX = '__bms_qualify_';
const QUALIFY_SUBQUERY_ALIAS = '__bms_qualified';

export interface QualifyEmulationPlan {
  /** Extra items appended to the inner SELECT list, already emitted. */
  selectItems: string[];
  /** Outer WHERE predicate, referencing the hoisted aliases. */
  predicate: string;
  /** Alias given to the wrapped subquery. */
  subqueryAlias: string;
}

export interface PlanQualifyOptions {
  /** Emits an expression through codegen's own pipeline (flatten, named windows). */
  emit: (expr: DogsledExpr) => string;
  dialect: SupportedDialect;
  modelName: string;
}

/**
 * Hoist the window expressions out of a qualify predicate.
 *
 * Throws when the predicate did not parse: an opaque `raw_sql` predicate cannot
 * be split into "the window part" and "the comparison part", and emitting it
 * into a WHERE clause would be rejected by the target anyway, since a window
 * function is not allowed there.
 */
export function planQualifyEmulation(
  predicateExpr: string,
  options: PlanQualifyOptions
): QualifyEmulationPlan {
  const ast = parseExprField(predicateExpr);
  if (ast.kind === 'raw_sql') {
    // Either an explicit `raw_sql()` call or a parse failure that fell back to
    // one. Both leave the predicate opaque, so there is no window sub-expression
    // to hoist, and a window function is not legal in a WHERE clause.
    throw new Error(
      `Model "${options.modelName}" cannot emulate QUALIFY on target "${options.dialect}": ` +
        `the predicate ${JSON.stringify(predicateExpr)} is opaque to the expression parser, so ` +
        `its window functions cannot be hoisted into the SELECT list. Express it in the DSL ` +
        `without raw_sql(), or move the filter to a downstream model.`
    );
  }

  const selectItems: string[] = [];
  const rewritten = mapExpr(ast, (node): DogsledExpr => {
    if (node.kind !== 'window') return node;
    const alias = `${QUALIFY_ALIAS_PREFIX}${selectItems.length}`;
    selectItems.push(`${options.emit(node)} AS ${caseName(alias, options.dialect)}`);
    return { kind: 'column_ref', column: alias };
  });

  // A predicate with no window node of its own is still valid and still needs
  // the wrapper: `qualify: rn = 1` referring to a windowed column declared in
  // the same SELECT is a normal Snowflake pattern, and a select alias is not
  // visible to WHERE. Nothing is hoisted; the wrap alone does the work.
  return {
    selectItems,
    predicate: options.emit(rewritten),
    subqueryAlias: caseName(QUALIFY_SUBQUERY_ALIAS, options.dialect),
  };
}

/** Wrap an inner SELECT so the hoisted aliases can be filtered. */
export function wrapForQualify(
  innerSql: string,
  outputColumns: ReadonlyArray<{ name: string }>,
  plan: QualifyEmulationPlan,
  dialect: SupportedDialect,
  options?: { distinct?: boolean }
): string {
  // The inner SELECT aliased these with `quoteColumnAlias`, which quotes a
  // mixed-case or reserved name instead of case-folding it. Referencing them
  // with `caseName` here would fold `"userId"` to `userid` and fail to resolve.
  const projection = outputColumns.map((c) => quoteColumnAlias(c.name, dialect)).join(', ');
  // DISTINCT belongs on the wrap: SQL applies it after QUALIFY, and leaving it
  // inside would deduplicate on the hoisted predicate column as well.
  const keyword = options?.distinct ? 'SELECT DISTINCT' : 'SELECT';
  return `${keyword} ${projection} FROM (${innerSql}) AS ${plan.subqueryAlias} WHERE ${plan.predicate}`;
}

/**
 * Emulation plan for `dedupe`.
 *
 * The window expression is compiler-generated, so it is hoisted directly rather
 * than parsed back out of a predicate.
 */
export function dedupeEmulationPlan(
  rowNumberSql: string,
  dialect: SupportedDialect
): QualifyEmulationPlan {
  const alias = caseName(`${QUALIFY_ALIAS_PREFIX}0`, dialect);
  return {
    selectItems: [`${rowNumberSql} AS ${alias}`],
    predicate: `${alias} = 1`,
    subqueryAlias: caseName(QUALIFY_SUBQUERY_ALIAS, dialect),
  };
}
