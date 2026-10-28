/**
 * Expression AST emitter — walks a DogsledExpr tree and produces
 * dialect-specific SQL text.
 *
 * For function_call nodes the emitter consults the FUNCTION_CATALOG to
 * handle renames, argument reordering, and custom per-dialect emitters.
 * Nodes not in the catalog pass through verbatim with dialect-appropriate
 * casing.
 */

import {
  caseName,
  escapeSqlString,
  getCanonicalDialect,
  safeIdentifier,
  supportsDialectCapability,
  unsupportedDialectFeatureError,
} from '../dialect.js';
import type { SupportedDialect } from '../dialect.js';
import { MODEL_SPEC_ERROR_CODES, modelSpecHint } from '../error-hints.js';
import { isDangerousRawSql } from '../schemas.js';
import { FUNCTION_CATALOG } from './functions.js';
import type {
  DogsledExpr,
  FrameBound,
  JsonPathAccessExpr,
  JsonPathStep,
  TypeRef,
  WindowFrameSpec,
  WindowOrderByItem,
} from './types.js';

// ---------------------------------------------------------------------------
// Operator precedence (matches parser.ts levels)
// ---------------------------------------------------------------------------

const OP_PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 4,
  '!=': 4,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  LIKE: 4,
  ILIKE: 4,
  'NOT LIKE': 4,
  'NOT ILIKE': 4,
  '+': 5,
  '-': 5,
  '||': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/**
 * Determine whether a child expression needs wrapping in parentheses
 * when it appears as an operand of `parentOp`.
 *
 * `isRight` is true when the child is the right operand — this matters for
 * non-commutative operators at the same precedence level (e.g. `a - (b - c)`).
 */
function needsParens(parentOp: string, child: DogsledExpr, isRight: boolean): boolean {
  if (child.kind !== 'binary_op') return false;
  const parentPrec = OP_PRECEDENCE[parentOp] ?? 0;
  const childPrec = OP_PRECEDENCE[child.op] ?? 0;
  if (childPrec < parentPrec) return true;
  if (childPrec === parentPrec && isRight) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively emit a DogsledExpr as dialect-specific SQL text.
 *
 * The returned string is *not* wrapped in parentheses unless the node is
 * explicitly a `parenthesized` expression.
 */
export function emitExpr(expr: DogsledExpr, dialect: SupportedDialect): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  switch (expr.kind) {
    // ----- Leaf nodes -------------------------------------------------------

    case 'column_ref': {
      const col = expr.table
        ? caseName(expr.column, dialect)
        : safeIdentifier(expr.column, dialect);
      return expr.table ? `${caseName(expr.table, dialect)}.${col}` : col;
    }

    case 'literal_string':
      return `'${escapeSqlString(expr.value, dialect)}'`;

    case 'literal_number':
      return expr.raw ?? String(expr.value);

    case 'literal_boolean':
      return expr.value ? 'TRUE' : 'FALSE';

    case 'literal_null':
      return 'NULL';

    case 'literal_star':
      return expr.table ? `${caseName(expr.table, dialect)}.*` : '*';

    case 'interval': {
      // Postgres, Redshift and Snowflake take the amount and unit inside one
      // string literal; the rest take them bare.
      switch (canonicalDialect) {
        case 'postgres':
        case 'snowflake':
          return `INTERVAL '${expr.amount} ${expr.unit}'`;
        default:
          return `INTERVAL ${expr.amount} ${expr.unit}`;
      }
    }

    case 'raw_sql':
      if (isDangerousRawSql(expr.sql)) {
        throw new Error(`raw_sql contains dangerous SQL: ${expr.sql.slice(0, 80)}`);
      }
      return expr.sql;

    // ----- Operators --------------------------------------------------------

    case 'binary_op': {
      const leftSql = emitExpr(expr.left, dialect);
      const rightSql = emitExpr(expr.right, dialect);
      const wrapLeft = needsParens(expr.op, expr.left, false);
      const wrapRight = needsParens(expr.op, expr.right, true);
      const l = wrapLeft ? `(${leftSql})` : leftSql;
      const r = wrapRight ? `(${rightSql})` : rightSql;
      return `${l} ${expr.op} ${r}`;
    }

    case 'unary_op': {
      const operand = emitExpr(expr.operand, dialect);
      if (expr.op === '-') return `-${operand}`;
      // NOT: wrap binary operands for clarity
      const wrap = expr.operand.kind === 'binary_op';
      return wrap ? `NOT (${operand})` : `NOT ${operand}`;
    }

    // ----- Function call ----------------------------------------------------

    case 'function_call': {
      let result = emitFunctionCall(expr.name, expr.args, expr.distinct ?? false, dialect);
      if (expr.nullsHandling) {
        result += expr.nullsHandling === 'ignore' ? ' IGNORE NULLS' : ' RESPECT NULLS';
      }
      return result;
    }

    case 'json_path_access':
      return emitJsonPathAccess(expr, dialect, false);

    // ----- Cast -------------------------------------------------------------

    case 'cast': {
      const exprSql =
        expr.expr.kind === 'json_path_access'
          ? emitJsonPathAccess(expr.expr, dialect, true)
          : emitExpr(expr.expr, dialect);
      const typeSql = emitTypeRef(expr.targetType, dialect);
      if (
        expr.shorthand &&
        (canonicalDialect === 'snowflake' ||
          canonicalDialect === 'postgres' ||
          canonicalDialect === 'duckdb')
      ) {
        let left = exprSql;
        if (expr.expr.kind === 'json_path_access') {
          if (canonicalDialect === 'postgres' || canonicalDialect === 'duckdb') {
            left = `(${exprSql})`;
          }
        } else if (needsShorthandCastParens(expr.expr)) {
          left = `(${exprSql})`;
        }
        return `${left}::${typeSql}`;
      }
      return `CAST(${exprSql} AS ${typeSql})`;
    }

    // ----- Case -------------------------------------------------------------

    case 'case': {
      const parts: string[] = ['CASE'];

      if (expr.operand) {
        parts.push(emitExpr(expr.operand, dialect));
      }

      for (const w of expr.whens) {
        parts.push(`WHEN ${emitExpr(w.condition, dialect)} THEN ${emitExpr(w.result, dialect)}`);
      }

      if (expr.elseExpr) {
        parts.push(`ELSE ${emitExpr(expr.elseExpr, dialect)}`);
      }

      parts.push('END');
      return parts.join(' ');
    }

    // ----- Between ----------------------------------------------------------

    case 'between': {
      const neg = expr.negated ? ' NOT' : '';
      return `${emitExpr(expr.expr, dialect)}${neg} BETWEEN ${emitExpr(expr.low, dialect)} AND ${emitExpr(expr.high, dialect)}`;
    }

    // ----- In list ----------------------------------------------------------

    case 'in_list': {
      const neg = expr.negated ? ' NOT' : '';
      const items = expr.list.map((item) => emitExpr(item, dialect)).join(', ');
      return `${emitExpr(expr.expr, dialect)}${neg} IN (${items})`;
    }

    // ----- Is null ----------------------------------------------------------

    case 'is_null': {
      const not = expr.negated ? ' NOT' : '';
      return `${emitExpr(expr.expr, dialect)} IS${not} NULL`;
    }

    // ----- Parenthesized ----------------------------------------------------

    case 'parenthesized':
      return `(${emitExpr(expr.expr, dialect)})`;

    // ----- Subquery ---------------------------------------------------------

    case 'subquery':
      if (isDangerousRawSql(expr.sql)) {
        throw new Error(`subquery contains dangerous SQL: ${expr.sql.slice(0, 80)}`);
      }
      return `(${expr.sql})`;

    // ----- IN subquery ------------------------------------------------------

    case 'in_subquery': {
      if (isDangerousRawSql(expr.subquerySql)) {
        throw new Error(`IN subquery contains dangerous SQL: ${expr.subquerySql.slice(0, 80)}`);
      }
      const neg = expr.negated ? ' NOT' : '';
      return `${emitExpr(expr.expr, dialect)}${neg} IN (${expr.subquerySql})`;
    }

    // ----- EXISTS -----------------------------------------------------------

    case 'exists': {
      if (isDangerousRawSql(expr.subquerySql)) {
        throw new Error(`EXISTS subquery contains dangerous SQL: ${expr.subquerySql.slice(0, 80)}`);
      }
      const prefix = expr.negated ? 'NOT EXISTS' : 'EXISTS';
      return `${prefix} (${expr.subquerySql})`;
    }

    // ----- Window expression ------------------------------------------------

    case 'window': {
      const fnSql = emitExpr(expr.fn, dialect);
      if (expr.windowName) {
        if (!supportsDialectCapability(dialect, 'namedWindowClause')) {
          throw unsupportedDialectFeatureError(
            dialect,
            'namedWindowClause',
            `Target "${dialect}" has no WINDOW clause, so named window ` +
              `"${expr.windowName}" must be inlined before emit — this is done by ` +
              `codegen from the model's "windows" declarations`
          );
        }
        return `${fnSql} OVER ${caseName(expr.windowName, dialect)}`;
      }
      const overParts: string[] = [];
      if (expr.partitionBy && expr.partitionBy.length > 0) {
        overParts.push(
          `PARTITION BY ${expr.partitionBy.map((e) => emitExpr(e, dialect)).join(', ')}`
        );
      }
      if (expr.orderBy && expr.orderBy.length > 0) {
        const framed =
          expr.frame?.kind === 'window_frame' &&
          (expr.frame.type === 'RANGE' || expr.frame.type === 'GROUPS');
        overParts.push(
          `ORDER BY ${emitOrderByItems(expr.orderBy, dialect, { logicalFrame: framed })}`
        );
      }
      if (expr.frame) {
        if (expr.frame.kind === 'raw_sql') {
          if (isDangerousRawSql(expr.frame.sql)) {
            throw new Error(
              `raw_sql window frame contains dangerous SQL: ${expr.frame.sql.slice(0, 80)}`
            );
          }
          overParts.push(expr.frame.sql);
        } else if (expr.frame.kind === 'window_frame') {
          overParts.push(emitWindowFrame(expr.frame, dialect));
        }
      }

      const hasWindowSpecs = overParts.length > 0;
      // Strip trailing OVER() if the function emitter already appended it
      const trailingOver = /\s*OVER\s*\(\s*\)$/;
      const baseFnSql = fnSql.replace(trailingOver, '');
      const hadTrailingOver = baseFnSql !== fnSql;
      if (hasWindowSpecs) {
        return `${baseFnSql} OVER (${overParts.join(' ')})`;
      }
      if (hadTrailingOver) {
        return fnSql;
      }
      return `${fnSql} OVER ()`;
    }
  }

  // Exhaustive check — if TypeScript is happy this is unreachable.
  const _exhaustive: never = expr;
  throw new Error(`Unknown expression kind: ${(_exhaustive as DogsledExpr).kind}`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit a SQL type reference, e.g. `VARCHAR(255)` or `NUMERIC(10, 2)`.
 * Type name casing matches dialect conventions: UPPER for Snowflake,
 * lower for all other supported dialects.
 */
function emitTypeRef(ref: TypeRef, dialect: SupportedDialect): string {
  const name =
    getCanonicalDialect(dialect) === 'snowflake' ? ref.name.toUpperCase() : ref.name.toLowerCase();
  if (ref.params && ref.params.length > 0) {
    return `${name}(${ref.params.join(', ')})`;
  }
  return name;
}

/**
 * Emit a function call, consulting the FUNCTION_CATALOG for dialect-specific
 * overrides.
 *
 * Resolution order:
 * 1. Look up canonical (lowercase) name in the catalog.
 * 2. If found and the dialect has a custom emitter, use it.
 * 3. If found but no dialect-specific emitter, use the canonical name
 *    (uppercased for consistency).
 * 4. If not in the catalog, use `caseName(name, dialect)`.
 */
function emitFunctionCall(
  name: string,
  args: readonly DogsledExpr[],
  distinct: boolean,
  dialect: SupportedDialect
): string {
  const emittedArgs = args.map((a) => emitExpr(a, dialect));
  const canonicalKey = name.toLowerCase();
  const def = FUNCTION_CATALOG.get(canonicalKey);

  if (def) {
    // Validate arity to prevent `undefined` leaking into SQL output
    if (
      emittedArgs.length < def.minArgs ||
      (def.maxArgs !== -1 && emittedArgs.length > def.maxArgs)
    ) {
      // Fall through to verbatim rendering rather than calling a custom emitter
      // that would index out-of-bounds
      return formatFunctionCall(caseName(name, dialect), emittedArgs, distinct);
    }

    const dialectEmitter = def.emit[dialect] ?? def.emit[getCanonicalDialect(dialect)];

    if (dialectEmitter !== undefined) {
      // String emitter — use as the function name with same args
      if (typeof dialectEmitter === 'string') {
        return formatFunctionCall(dialectEmitter, emittedArgs, distinct);
      }
      // Function emitter — full control over output
      return dialectEmitter(emittedArgs, dialect);
    }

    // In catalog but no dialect-specific emitter — use canonical name uppercased
    return formatFunctionCall(name.toUpperCase(), emittedArgs, distinct);
  }

  // Not in catalog — pass through with dialect casing
  return formatFunctionCall(caseName(name, dialect), emittedArgs, distinct);
}

/**
 * Format `NAME([DISTINCT] arg1, arg2, ...)`.
 */
function formatFunctionCall(name: string, args: string[], distinct: boolean): string {
  const distinctPrefix = distinct ? 'DISTINCT ' : '';
  return `${name}(${distinctPrefix}${args.join(', ')})`;
}

function emitJsonPathAccess(
  expr: JsonPathAccessExpr,
  dialect: SupportedDialect,
  asText: boolean
): string {
  const baseSql = emitExpr(expr.base, dialect);
  return emitJsonPathSteps(baseSql, expr.steps, dialect, asText);
}

/** Matches identifiers that can appear unquoted in Snowflake/Databricks JSON paths. */
const JSON_PATH_IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Defense-in-depth: reject key names that could break SQL syntax even after
 * conventional escaping (newlines, null bytes, control chars), and reject the
 * literal `$` root marker reaching here as a key name — that's a sign a caller
 * passed an absolute JSONPath like `'$.foo'` instead of a relative one.
 * See JSON_PATH_DOUBLE_ROOT.
 */
export function validateJsonPathStepName(name: string): void {
  if (/[\0\r\n]/.test(name)) {
    throw new Error(`JSON path key contains unsafe character: ${JSON.stringify(name)}`);
  }
  if (name === '$') {
    throw new Error(
      modelSpecHint(
        MODEL_SPEC_ERROR_CODES.JSON_PATH_DOUBLE_ROOT,
        'Got "$" as a JSON path step — paths are relative, drop the leading "$." (Model Spec auto-roots from $).'
      )
    );
  }
}

/**
 * Emit a chain of JSON path steps against `baseSql` for the given dialect.
 *
 * Shared by both `JsonPathAccessExpr` (Model Spec expression AST) and the
 * `json_value(col, 'dotted.path')` catalog function. Keys are validated and
 * escaped per-dialect to prevent SQL injection from user-supplied path
 * literals.
 */
export function emitJsonPathSteps(
  baseSql: string,
  steps: readonly JsonPathStep[],
  dialect: SupportedDialect,
  asText: boolean
): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  switch (canonicalDialect) {
    case 'snowflake': {
      let sql = baseSql;
      for (const step of steps) {
        sql += emitSnowflakeJsonStep(step);
      }
      return sql;
    }

    case 'bigquery': {
      const path = buildJsonPath(steps);
      const escapedPath = escapeSqlString(path, dialect);
      return asText
        ? `JSON_VALUE(${baseSql}, '${escapedPath}')`
        : `JSON_QUERY(${baseSql}, '${escapedPath}')`;
    }

    case 'postgres':
    case 'duckdb': {
      let sql = baseSql;
      steps.forEach((step, index) => {
        const isLast = index === steps.length - 1;
        const op = isLast && asText ? '->>' : '->';
        if (step.kind === 'key') {
          validateJsonPathStepName(step.name);
          sql += `${op}'${escapeSqlString(step.name, dialect)}'`;
        } else {
          sql += `${op}${step.n}`;
        }
      });
      return sql;
    }

    case 'databricks': {
      let sql = baseSql;
      for (const step of steps) {
        sql += emitDatabricksJsonStep(step);
      }
      return sql;
    }

    case 'mysql': {
      const path = buildJsonPath(steps);
      const escapedPath = escapeSqlString(path, dialect);
      const extracted = `JSON_EXTRACT(${baseSql}, '${escapedPath}')`;
      return asText ? `JSON_UNQUOTE(${extracted})` : extracted;
    }

    case 'clickhouse': {
      const args = steps.map((step) => {
        if (step.kind === 'key') {
          validateJsonPathStepName(step.name);
          return `'${escapeSqlString(step.name, dialect)}'`;
        }
        // ClickHouse indexes JSON arrays from 1, while every other dialect
        // here (and therefore the Model Spec step) counts from 0.
        return String(step.n + 1);
      });
      const call = args.length > 0 ? `${baseSql}, ${args.join(', ')}` : baseSql;
      return asText ? `JSONExtractString(${call})` : `JSONExtractRaw(${call})`;
    }
  }

  const _exhaustive: never = canonicalDialect;
  throw new Error(`Unhandled dialect in emitJsonPathSteps: ${_exhaustive as string}`);
}

function emitSnowflakeJsonStep(step: JsonPathStep): string {
  if (step.kind === 'index') return `[${step.n}]`;
  validateJsonPathStepName(step.name);
  if (JSON_PATH_IDENT_REGEX.test(step.name)) {
    return `:${step.name}`;
  }
  return `:"${step.name.replace(/"/g, '""')}"`;
}

function emitDatabricksJsonStep(step: JsonPathStep): string {
  if (step.kind === 'index') return `[${step.n}]`;
  validateJsonPathStepName(step.name);
  if (JSON_PATH_IDENT_REGEX.test(step.name)) {
    return `.${step.name}`;
  }
  return `.\`${step.name.replace(/`/g, '``')}\``;
}

function buildJsonPath(steps: readonly JsonPathStep[]): string {
  let path = '$';
  for (const step of steps) {
    if (step.kind === 'key') {
      validateJsonPathStepName(step.name);
      path += `.${step.name}`;
    } else {
      path += `[${step.n}]`;
    }
  }
  return path;
}

/**
 * Returns true when the given expression needs parentheses when used as the LHS
 * of a shorthand cast (`expr::TYPE`). Binary and unary operators, and certain
 * predicates must be wrapped to avoid ambiguity.
 */
function needsShorthandCastParens(expr: DogsledExpr): boolean {
  return (
    expr.kind === 'binary_op' ||
    expr.kind === 'unary_op' ||
    expr.kind === 'between' ||
    expr.kind === 'in_list' ||
    expr.kind === 'in_subquery' ||
    expr.kind === 'is_null' ||
    expr.kind === 'case'
  );
}

/**
 * Emit a structured window frame specification.
 */
export function emitWindowFrame(frame: WindowFrameSpec, dialect: SupportedDialect): string {
  if (frame.type === 'GROUPS' && !supportsDialectCapability(dialect, 'windowGroupsFrame')) {
    throw unsupportedDialectFeatureError(
      dialect,
      'windowGroupsFrame',
      `GROUPS window frames are not supported by compiler target "${dialect}" — ` +
        `use a ROWS or RANGE frame, or pre-aggregate peer groups in an upstream model`
    );
  }
  if (frame.exclude !== undefined && !supportsDialectCapability(dialect, 'windowFrameExclude')) {
    throw unsupportedDialectFeatureError(
      dialect,
      'windowFrameExclude',
      `Window frame EXCLUDE is not supported by compiler target "${dialect}" — ` +
        `subtract the excluded rows explicitly, for example ` +
        `SUM(x) OVER (...) - x for EXCLUDE CURRENT ROW`
    );
  }
  const startSql = emitFrameBound(frame.start, dialect);
  const excludeSql = frame.exclude !== undefined ? ` EXCLUDE ${frame.exclude}` : '';
  if (frame.end !== undefined) {
    const endSql = emitFrameBound(frame.end, dialect);
    return `${frame.type} BETWEEN ${startSql} AND ${endSql}${excludeSql}`;
  }
  return `${frame.type} ${startSql}${excludeSql}`;
}

/**
 * Emit an ORDER BY item list, honouring explicit `NULLS FIRST` / `NULLS LAST`.
 *
 * Targets without native null-ordering syntax (MySQL) get a leading
 * `(<expr> IS NULL)` sort key, which is the standard rewrite. That extra key
 * changes which rows count as peers, so it is refused inside a RANGE or GROUPS
 * frame, where peer membership decides the frame contents; ROWS frames and
 * plain ORDER BY are unaffected.
 */
export function emitOrderByItems(
  items: readonly WindowOrderByItem[],
  dialect: SupportedDialect,
  options?: { logicalFrame?: boolean }
): string {
  return items
    .map((item) =>
      renderOrderByTerm(emitExpr(item.expr, dialect), item.direction, item.nulls, dialect, options)
    )
    .join(', ');
}

/**
 * Render one ORDER BY term from already-emitted column SQL.
 *
 * Codegen renders model-level `order_by`, named-window `order_by` and `dedupe`
 * through its own qualified-reference normalizer rather than the expression
 * emitter, so both paths share this function: null placement is decided in one
 * place instead of being reimplemented per call site.
 */
export function renderOrderByTerm(
  columnSql: string,
  direction: 'ASC' | 'DESC' | undefined,
  nulls: 'FIRST' | 'LAST' | undefined,
  dialect: SupportedDialect,
  options?: { logicalFrame?: boolean }
): string {
  const suffix = direction ? ` ${direction}` : '';
  if (nulls === undefined) return `${columnSql}${suffix}`;
  if (supportsDialectCapability(dialect, 'windowNullsOrdering')) {
    return `${columnSql}${suffix} NULLS ${nulls}`;
  }
  if (options?.logicalFrame) {
    throw unsupportedDialectFeatureError(
      dialect,
      'windowNullsOrdering',
      `Target "${dialect}" has no NULLS ${nulls} syntax, and the rewrite ` +
        `changes peer groups inside a RANGE or GROUPS frame — use a ROWS frame, ` +
        `or filter nulls upstream`
    );
  }
  return `(${columnSql} IS NULL) ${nulls === 'FIRST' ? 'DESC' : 'ASC'}, ${columnSql}${suffix}`;
}

/**
 * Emit a single frame bound.
 */
function emitFrameBound(bound: FrameBound, dialect: SupportedDialect): string {
  if (typeof bound === 'string') return bound;
  return `${emitExpr(bound.offset, dialect)} ${bound.direction}`;
}
