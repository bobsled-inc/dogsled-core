/**
 * Bounded fixpoint compilation: the `recurse` operator and its `hierarchy` sugar.
 *
 * Recursion is expressed inside a single model rather than as a cycle between
 * models. The DAG stays acyclic, the model's declared `columns` remain the
 * output schema, and column lineage still resolves through the anchor and step
 * expressions. A hand-written SQL body gives up all three.
 *
 * The compiled shape is the same on every target:
 *
 *   WITH RECURSIVE r AS (
 *     SELECT anchor.*, 0 AS __bms_depth[, <seed path> AS __bms_path] FROM (<anchor>) anchor
 *     UNION ALL
 *     SELECT <step columns>, prior.__bms_depth + 1[, <extended path>]
 *     FROM <step source> source JOIN r prior ON <join_on>
 *     WHERE prior.__bms_depth < <max_depth>[ AND <cycle guard>][ AND <step where>]
 *   )
 *   SELECT <declared columns> FROM r
 *
 * `UNION ALL` is not a preference: Snowflake rejects `UNION` between the anchor
 * and recursive clauses, so termination comes from the depth bound and the
 * cycle guard rather than from row deduplication.
 *
 * The depth bound is required. Every target needs one for its own reasons —
 * BigQuery aborts at 500 iterations and its documentation asks for an explicit
 * guard — and a dataframe backend has no fixpoint primitive at all, so it can
 * only run the step as a bounded loop.
 *
 * Cycle detection carries the visited keys as delimited text rather than an
 * array, because array containment has no portable spelling across the
 * supported dialects while string containment does.
 */

import {
  caseName,
  formatTableRef,
  quoteColumnAlias,
  getCanonicalDialect,
  supportsDialectCapability,
  unsupportedDialectFeatureError,
} from './dialect.js';
import { emitExpr, mapExpr, parseExprField } from './expr/index.js';
import {
  RECURSE_ALIAS_PRIOR,
  RECURSE_ALIAS_SOURCE,
  RECURSE_INTERNAL_DEPTH,
  RECURSE_INTERNAL_PATH,
} from './schemas.js';

import type { SupportedDialect } from './dialect.js';
import type { DogsledExpr } from './expr/index.js';
import type { HierarchySpec, RecurseSpec, TransformSpec } from './schemas.js';

/** Internal column carrying the walked key, so the join never depends on how the author aliased it. */
export const RECURSE_INTERNAL_NODE = '__bms_node';

/**
 * Physical table aliases for the step's two relations.
 *
 * The authoring names are `prior` and `source`, which read well in YAML, but
 * neither is safe to emit: `PRIOR` is Oracle's hierarchical-query keyword and
 * parsers reject it in a qualified reference, and `SOURCE` is the MERGE
 * statement's relation name on several targets. Step expressions are therefore
 * rewritten onto these internal aliases before emit.
 */
const RECURSE_PHYSICAL_PRIOR = '__bms_prior';
const RECURSE_PHYSICAL_SOURCE = '__bms_source';

/**
 * Qualify unqualified column references with the step's source alias.
 *
 * A step expression is evaluated against two relations, `source` and `prior`.
 * References to the previous iteration must say `prior.`; everything else reads
 * the row being joined in, so a bare column resolves to `source`. That one rule
 * serves hand-written steps and desugared hierarchies identically, which is why
 * desugaring can copy an anchor expression into the step untouched.
 */
export function qualifyStepExpression(exprText: string, dialect: SupportedDialect): string {
  const ast = parseExprField(exprText);
  if (ast.kind === 'raw_sql') return ast.sql;
  const qualified = mapExpr(ast, (node: DogsledExpr): DogsledExpr => {
    if (node.kind !== 'column_ref') return node;
    const table = node.table?.toLocaleLowerCase();
    if (table === RECURSE_ALIAS_PRIOR) return { ...node, table: RECURSE_PHYSICAL_PRIOR };
    if (table === undefined || table === RECURSE_ALIAS_SOURCE) {
      return { ...node, table: RECURSE_PHYSICAL_SOURCE };
    }
    return node;
  });
  return emitExpr(qualified, dialect);
}

/**
 * Rewrite a `hierarchy` model into the equivalent `recurse` model.
 *
 * Kept as a pure spec-to-spec transform so both operators share one compiler
 * path: whatever `recurse` proves out, `hierarchy` inherits. It mirrors how
 * `dedupe` already compiles down to `QUALIFY ROW_NUMBER()`.
 */
export interface HierarchyMeta {
  /** Column holding the walked key, used by the step join and the cycle test. */
  childKey: string;
  depthColumn?: string;
  pathColumn?: string;
}

export interface DesugarResult {
  spec: TransformSpec;
  hierarchy?: HierarchyMeta;
}

export function desugarHierarchy(spec: TransformSpec): DesugarResult {
  const hierarchy: HierarchySpec | undefined = spec.hierarchy;
  if (!hierarchy) return { spec };

  const emit = hierarchy.emit ?? {};
  const anchorColumns = [...spec.columns];
  const stepColumns = spec.columns.map((c) => ({ name: c.name, expr: c.expr }));

  // The root of a walk is the row it started from, so the anchor seeds it with
  // the row's own key and every later iteration carries the seed forward.
  if (emit.root) {
    anchorColumns.push({ name: emit.root, expr: hierarchy.child_key });
    stepColumns.push({ name: emit.root, expr: `${RECURSE_ALIAS_PRIOR}.${emit.root}` });
  }

  const recurse: RecurseSpec = {
    max_depth: hierarchy.max_depth,
    step: {
      source: {
        join_on:
          `${RECURSE_ALIAS_SOURCE}.${hierarchy.parent_key} = ` +
          `${RECURSE_ALIAS_PRIOR}.${RECURSE_INTERNAL_NODE}`,
      },
      columns: stepColumns,
    },
    ...(emit.cycle
      ? {
          cycle: {
            on: RECURSE_INTERNAL_NODE,
            emit: emit.cycle,
            delimiter: hierarchy.path_delimiter,
          },
        }
      : {}),
  };

  const { hierarchy: _consumed, ...rest } = spec;
  return {
    spec: {
      ...rest,
      // `roots` walks down from parentless rows. `all_nodes` seeds a walk at
      // every row, which a cycle audit needs because a cycle has no parentless
      // row: root-seeded walks never reach an isolated cycle at all, and report
      // only the entry row of a reachable one.
      ...(hierarchy.seed === 'roots'
        ? { where: mergeWhere(spec.where, `${hierarchy.parent_key} IS NULL`) }
        : {}),
      columns: anchorColumns,
      recurse,
    },
    hierarchy: {
      childKey: hierarchy.child_key,
      ...(emit.depth ? { depthColumn: emit.depth } : {}),
      ...(emit.path ? { pathColumn: emit.path } : {}),
    },
  };
}

function mergeWhere(existing: string | undefined, added: string): string {
  return existing ? `(${existing}) AND (${added})` : added;
}

export interface RecursiveSelectInput {
  /** The model's own SELECT, which supplies the seed rows. */
  anchorSql: string;
  /**
   * Physical table or CTE the step joins in. Already resolved through the
   * ephemeral CTE map, so an upstream ephemeral model resolves to its CTE name.
   */
  stepSourceTable: string;
  /** True when `stepSourceTable` is a CTE name, which must not be case-folded as a table. */
  stepSourceIsCte?: boolean;
  recurse: RecurseSpec;
  /** Declared output columns, in the order the model lists them. */
  outputColumns: ReadonlyArray<{ name: string }>;
  /** Extra internal columns the hierarchy sugar surfaces under author-chosen names. */
  hierarchy?: { childKey: string; depthColumn?: string; pathColumn?: string };
  modelName: string;
  dialect: SupportedDialect;
  /** Appended to the outer SELECT, e.g. ORDER BY / LIMIT. */
  outerSuffix?: string;
}

/** Assemble the full `WITH RECURSIVE` statement for a model. */
export function buildRecursiveSelect(input: RecursiveSelectInput): string {
  const { dialect, recurse, modelName } = input;
  if (!supportsDialectCapability(dialect, 'recursiveCte')) {
    throw unsupportedDialectFeatureError(
      dialect,
      'recursiveCte',
      `Model "${modelName}" uses recursion, which compiler target "${dialect}" does not support`
    );
  }

  const q = (name: string): string => caseName(name, dialect);
  // The anchor is `SELECT __anchor.*` over the model's own SELECT, whose aliases
  // came from `quoteColumnAlias`. A UNION takes its column names from the first
  // branch, so the step and the outer projection have to spell the model's
  // columns the same way or a mixed-case name stops resolving.
  const col = (name: string): string => quoteColumnAlias(name, dialect);
  const cte = q(`__bms_recurse_${modelName}`);
  const prior = q(RECURSE_PHYSICAL_PRIOR);
  const source = q(RECURSE_PHYSICAL_SOURCE);
  const depth = q(RECURSE_INTERNAL_DEPTH);
  const path = q(RECURSE_INTERNAL_PATH);
  const node = q(RECURSE_INTERNAL_NODE);
  const cycle = recurse.cycle;

  // --- anchor -------------------------------------------------------------
  // The path is carried whenever something needs it: the cycle test, or a
  // hierarchy asking to surface it as a column.
  const wantsPath = cycle !== undefined || input.hierarchy?.pathColumn !== undefined;
  const pathKey = cycle?.on ?? RECURSE_INTERNAL_NODE;
  const pathDelimiter = cycle?.delimiter ?? '/';

  const anchorExtras = [`0 AS ${depth}`];
  if (input.hierarchy) {
    anchorExtras.unshift(`__anchor.${q(input.hierarchy.childKey)} AS ${node}`);
  }
  if (wantsPath) {
    anchorExtras.push(
      `${pathLiteral(pathDelimiter, cycleKeyExpr('__anchor', pathKey, q, input.hierarchy?.childKey), dialect)} AS ${path}`
    );
  }
  if (cycle?.emit) {
    anchorExtras.push(`FALSE AS ${col(cycle.emit)}`);
  }
  const anchor =
    `SELECT __anchor.*, ${anchorExtras.join(', ')}\n` +
    `FROM (\n${indent(input.anchorSql)}\n) AS __anchor`;

  // --- step ---------------------------------------------------------------
  const stepByName = new Map(
    recurse.step.columns.map((c) => [c.name.toLocaleLowerCase(), c.expr] as const)
  );
  // A set operation matches columns by position, so the step must project the
  // model's columns in the order the model declares them.
  const stepColumns = input.outputColumns.map((c) => {
    const expr = stepByName.get(c.name.toLocaleLowerCase());
    if (expr === undefined) {
      throw new Error(`Model "${modelName}" recurse step is missing column "${c.name}"`);
    }
    return `${qualifyStepExpression(expr, dialect)} AS ${col(c.name)}`;
  });
  const stepExtras = [`${prior}.${depth} + 1 AS ${depth}`];
  if (input.hierarchy) {
    stepExtras.unshift(`${source}.${q(input.hierarchy.childKey)} AS ${node}`);
  }
  if (wantsPath) {
    const key = cycleKeyExpr(source, pathKey, q, input.hierarchy?.childKey);
    stepExtras.push(
      `${concatText([`${prior}.${path}`, textCast(key, dialect), `'${pathDelimiter}'`], dialect)} AS ${path}`
    );
    if (cycle?.emit) {
      stepExtras.push(
        `${containsSegment(`${prior}.${path}`, key, pathDelimiter, dialect)} AS ${col(cycle.emit)}`
      );
    }
  }

  const stepConditions = [`${prior}.${depth} < ${recurse.max_depth}`];
  if (cycle?.emit) {
    // Stop extending a path once it closed a cycle, so the walk reports the
    // repetition once instead of looping until the depth bound.
    stepConditions.push(`${prior}.${col(cycle.emit)} = FALSE`);
  } else if (cycle) {
    const key = cycleKeyExpr(source, cycle.on, q, input.hierarchy?.childKey);
    stepConditions.push(`NOT ${containsSegment(`${prior}.${path}`, key, pathDelimiter, dialect)}`);
  }
  if (recurse.step.source.where) {
    stepConditions.push(`(${qualifyStepExpression(recurse.step.source.where, dialect)})`);
  }

  const step =
    `SELECT ${[...stepColumns, ...stepExtras].join(', ')}\n` +
    `FROM ${
      input.stepSourceIsCte
        ? `${input.stepSourceTable} AS ${source}`
        : formatTableRef(input.stepSourceTable, source, dialect)
    }\n` +
    `JOIN ${cte} AS ${prior} ON ${qualifyStepExpression(recurse.step.source.join_on, dialect)}\n` +
    `WHERE ${stepConditions.join(' AND ')}`;

  // --- outer projection ---------------------------------------------------
  const outer = input.outputColumns.map((c) => col(c.name));
  if (cycle?.emit) outer.push(col(cycle.emit));
  if (input.hierarchy?.depthColumn) outer.push(`${depth} AS ${col(input.hierarchy.depthColumn)}`);
  if (input.hierarchy?.pathColumn) outer.push(`${path} AS ${col(input.hierarchy.pathColumn)}`);

  return (
    `WITH RECURSIVE ${cte} AS (\n${indent(anchor)}\nUNION ALL\n${indent(step)}\n)\n` +
    `SELECT ${outer.join(', ')} FROM ${cte}${input.outerSuffix ?? ''}`
  );
}

/** Reference to the cycle key, resolving the hierarchy sugar's internal node column. */
function cycleKeyExpr(
  alias: string,
  on: string,
  q: (n: string) => string,
  hierarchyChildKey?: string
): string {
  if (on === RECURSE_INTERNAL_NODE && hierarchyChildKey) {
    return `${alias}.${q(hierarchyChildKey)}`;
  }
  return `${alias}.${q(on)}`;
}

/**
 * Cast to text.
 *
 * Written here rather than routed through the function catalog because the
 * catalog's `to_varchar` maps to a bare `TO_CHAR(x)` on Postgres and Redshift,
 * which those engines reject: their `TO_CHAR` requires a format argument.
 */
function textCast(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
    case 'databricks':
      return `CAST(${expr} AS STRING)`;
    case 'mysql':
      return `CAST(${expr} AS CHAR)`;
    default:
      return `CAST(${expr} AS VARCHAR)`;
  }
}

/**
 * Concatenate text.
 *
 * MySQL reads `||` as logical OR unless `PIPES_AS_CONCAT` is set, so it gets
 * `CONCAT`. Emitting `||` for every target, as the expression DSL does, would
 * silently produce a boolean there instead of a path.
 */
function concatText(parts: readonly string[], dialect: SupportedDialect): string {
  if (getCanonicalDialect(dialect) === 'mysql') return `CONCAT(${parts.join(', ')})`;
  return parts.join(' || ');
}

/** Seed path: `<delim><key><delim>`, so every key is a fully delimited segment. */
function pathLiteral(delimiter: string, keyExpr: string, dialect: SupportedDialect): string {
  return concatText([`'${delimiter}'`, textCast(keyExpr, dialect), `'${delimiter}'`], dialect);
}

/**
 * Test whether a key already appears in a path.
 *
 * Both sides are delimited so `/5/` cannot match inside `/51/`; without that the
 * walk reports a false cycle for any key that is a prefix of another. Each
 * target gets its own spelling: the catalog's `contains` emits MySQL and
 * Snowflake forms that do not both exist, so the mapping is explicit here.
 */
function containsSegment(
  pathExpr: string,
  keyExpr: string,
  delimiter: string,
  dialect: SupportedDialect
): string {
  const needle = pathLiteral(delimiter, keyExpr, dialect);
  switch (getCanonicalDialect(dialect)) {
    case 'postgres':
      return `(POSITION(${needle} IN ${pathExpr}) > 0)`;
    case 'bigquery':
      return `(STRPOS(${pathExpr}, ${needle}) > 0)`;
    case 'mysql':
      return `(LOCATE(${needle}, ${pathExpr}) > 0)`;
    default:
      return `CONTAINS(${pathExpr}, ${needle})`;
  }
}

function indent(sql: string): string {
  return sql
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
