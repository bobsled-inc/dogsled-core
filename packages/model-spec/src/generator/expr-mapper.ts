/**
 * SQL expression AST → BobsledExpr string.
 *
 * Walks `node-sql-parser`'s AST (Snowflake dialect) and emits expression
 * strings that Model Spec's BobsledExpr parser accepts. Strict by design: any node
 * shape we don't recognize throws `ModelSpecGenerationError(UNSUPPORTED_CONSTRUCT)`
 * rather than producing a `raw_sql()` fallback.
 */

import { isJsonPathPlaceholder, restoreJsonPath } from './preprocess.js';
import { emitQuotedIdentifier } from './quoted-identifier.js';
import { ModelSpecGenerationError } from './types.js';

export interface ExprContext {
  /** JSON path placeholders to restore when emitting column refs. */
  masks: readonly string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export function emitExpr(node: Node, ctx: ExprContext): string {
  if (node == null) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'Encountered null expression node');
  }

  switch (node.type) {
    case 'column_ref':
      return emitColumnRef(node, ctx);
    case 'double_quote_string': {
      if (typeof node.value !== 'string' || node.value.length === 0) {
        throw new ModelSpecGenerationError(
          'UNSUPPORTED_CONSTRUCT',
          'double_quote_string node must contain a non-empty string value'
        );
      }
      return emitQuotedIdentifier(node.value);
    }
    case 'number':
      return String(node.value);
    case 'single_quote_string':
      return `'${String(node.value).replace(/'/g, "''")}'`;
    case 'string':
      return `'${String(node.value).replace(/'/g, "''")}'`;
    case 'bool':
      return node.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'star':
      return '*';
    case 'expr_list':
      return `(${(node.value as Node[]).map((v) => emitExpr(v, ctx)).join(', ')})`;
    case 'binary_expr':
      return emitBinary(node, ctx);
    case 'unary_expr':
      return emitUnary(node, ctx);
    case 'function':
    case 'aggr_func':
      return emitFunction(node, ctx);
    case 'window_func':
      return emitWindowFunc(node, ctx);
    case 'cast':
      return emitCast(node, ctx);
    case 'case':
      return emitCase(node, ctx);
    case 'interval': {
      if (!node.unit) {
        throw new ModelSpecGenerationError(
          'UNSUPPORTED_CONSTRUCT',
          'INTERVAL expression is missing the unit (e.g. DAY, HOUR)'
        );
      }
      return `INTERVAL ${emitExpr(node.expr, ctx)} ${String(node.unit).toUpperCase()}`;
    }
    default:
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Expression node type \`${String(node.type)}\` is not supported by the Model Spec generator`
      );
  }
}

function emitColumnRef(node: Node, ctx: ExprContext): string {
  if (node.column === '*') {
    return node.table ? `${node.table}.*` : '*';
  }
  const colName = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
  if (typeof colName !== 'string') {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      'Unsupported column reference shape'
    );
  }

  // Restore Snowflake JSON-path access masked during preprocessing.
  if (isJsonPathPlaceholder(colName)) {
    const restored = restoreJsonPath(colName, ctx.masks);
    if (restored == null) {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Unrecognized JSON path placeholder ${colName}`
      );
    }
    return node.table ? `${node.table}.${restored}` : restored;
  }

  return node.table ? `${node.table}.${colName}` : colName;
}

const BINARY_OPS: Record<string, string> = {
  AND: 'AND',
  OR: 'OR',
  '=': '=',
  '!=': '!=',
  '<>': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '||': '||',
};

function emitBinary(node: Node, ctx: ExprContext): string {
  const op = String(node.operator).toUpperCase();

  if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
    const range = node.right;
    if (range?.type !== 'expr_list' || !Array.isArray(range.value) || range.value.length !== 2) {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `BETWEEN expects a two-element range; got ${JSON.stringify(range?.type)}`
      );
    }
    const lo = emitExpr(range.value[0]!, ctx);
    const hi = emitExpr(range.value[1]!, ctx);
    return `${emitExpr(node.left, ctx)} ${op} ${lo} AND ${hi}`;
  }

  if (op === 'IN' || op === 'NOT IN') {
    return `${emitExpr(node.left, ctx)} ${op} ${emitExpr(node.right, ctx)}`;
  }

  if (op === 'IS' || op === 'IS NOT') {
    return `${emitExpr(node.left, ctx)} ${op} ${emitExpr(node.right, ctx)}`;
  }

  if (op === 'LIKE' || op === 'NOT LIKE' || op === 'ILIKE' || op === 'NOT ILIKE') {
    return `${emitExpr(node.left, ctx)} ${op} ${emitExpr(node.right, ctx)}`;
  }

  const mapped = BINARY_OPS[op];
  if (!mapped) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      `Binary operator \`${node.operator}\` is not supported`
    );
  }
  return `(${emitExpr(node.left, ctx)} ${mapped} ${emitExpr(node.right, ctx)})`;
}

function emitUnary(node: Node, ctx: ExprContext): string {
  const op = String(node.operator).toUpperCase();
  if (op === 'NOT') return `NOT ${emitExpr(node.expr, ctx)}`;
  if (op === '-') return `-${emitExpr(node.expr, ctx)}`;
  if (op === '+') return `+${emitExpr(node.expr, ctx)}`;
  throw new ModelSpecGenerationError(
    'UNSUPPORTED_CONSTRUCT',
    `Unary operator \`${node.operator}\` is not supported`
  );
}

function functionName(node: Node): string {
  if (typeof node.name === 'string') return node.name;
  const parts = node.name?.name as Node[] | undefined;
  if (!parts) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'Unsupported function-name shape');
  }
  return parts.map((p) => String(p.value)).join('.');
}

function emitFunctionArgs(args: Node, ctx: ExprContext): string {
  if (!args) return '';

  // Aggregate-function shape: `{ expr: <node>, distinct?: 'DISTINCT' }`.
  if (args.expr && !args.type) {
    const distinctPrefix = args.distinct ? 'DISTINCT ' : '';
    const inner = args.expr.type === 'star' ? '*' : emitExpr(args.expr, ctx);
    const orderBy = args.orderby?.length
      ? ' ORDER BY ' +
        (args.orderby as Node[])
          .map((o) => `${emitExpr(o.expr, ctx)}${o.type ? ' ' + String(o.type).toUpperCase() : ''}`)
          .join(', ')
      : '';
    const sep = args.separator ? ` SEPARATOR ${emitExpr(args.separator, ctx)}` : '';
    return `${distinctPrefix}${inner}${orderBy}${sep}`;
  }

  if (args.type === 'expr_list') {
    const distinctPrefix = args.distinct ? 'DISTINCT ' : '';
    return distinctPrefix + (args.value as Node[]).map((v) => emitExpr(v, ctx)).join(', ');
  }
  if (args.type === 'star') return '*';
  return emitExpr(args, ctx);
}

function emitFunction(node: Node, ctx: ExprContext): string {
  const name = functionName(node).toUpperCase();
  const args = emitFunctionArgs(node.args, ctx);
  const base = `${name}(${args})`;
  if (node.over) {
    return `${base} OVER ${emitOver(node.over, ctx)}`;
  }
  return base;
}

function emitWindowFunc(node: Node, ctx: ExprContext): string {
  const name = String(node.name).toUpperCase();
  const args = node.args ? emitFunctionArgs(node.args, ctx) : '';
  const base = `${name}(${args})`;
  if (!node.over) {
    throw new ModelSpecGenerationError(
      'UNSUPPORTED_CONSTRUCT',
      `Window function ${name} missing OVER clause`
    );
  }
  return `${base} OVER ${emitOver(node.over, ctx)}`;
}

function emitOver(over: Node, ctx: ExprContext): string {
  const spec = over.as_window_specification?.window_specification ?? over.window_specification;
  if (!spec) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'Unsupported OVER clause shape');
  }
  const parts: string[] = [];
  if (spec.partitionby?.length) {
    const pb = (spec.partitionby as Node[]).map((p) => emitExpr(p.expr ?? p, ctx)).join(', ');
    parts.push(`PARTITION BY ${pb}`);
  }
  if (spec.orderby?.length) {
    const ob = (spec.orderby as Node[])
      .map((o) => {
        const expr = emitExpr(o.expr, ctx);
        const dir = o.type ? ` ${String(o.type).toUpperCase()}` : '';
        return `${expr}${dir}`;
      })
      .join(', ');
    parts.push(`ORDER BY ${ob}`);
  }
  if (spec.window_frame_clause) {
    parts.push(formatFrameClause(spec.window_frame_clause));
  }
  return `(${parts.join(' ')})`;
}

function formatFrameClause(clause: Node): string {
  // node-sql-parser sometimes emits frame as a string, sometimes as a structured node.
  if (typeof clause === 'string') return clause;
  if (clause.type && clause.start) {
    if (!clause.end) {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        'Window frame BETWEEN clause is missing the end bound'
      );
    }
    const unit = String(clause.type).toUpperCase();
    return `${unit} ${formatFrameBound(clause.start)} AND ${formatFrameBound(clause.end)}`;
  }
  throw new ModelSpecGenerationError(
    'UNSUPPORTED_CONSTRUCT',
    `Unsupported window frame shape: ${JSON.stringify(clause).slice(0, 80)}`
  );
}

function formatFrameBound(b: Node): string {
  if (typeof b === 'string') return b;
  if (b?.type === 'origin') return String(b.value).toUpperCase();
  if (b?.value && b?.unit) return `${b.value} ${String(b.unit).toUpperCase()}`;
  return String(b);
}

function emitCast(node: Node, ctx: ExprContext): string {
  const expr = emitExpr(node.expr, ctx);
  const target = node.target?.[0];
  if (!target?.dataType) {
    throw new ModelSpecGenerationError('UNSUPPORTED_CONSTRUCT', 'CAST missing target type');
  }
  const targetType = String(target.dataType).toUpperCase();
  if (node.keyword === 'try_cast') return `TRY_CAST(${expr} AS ${targetType})`;
  if (node.symbol === '::') return `${expr}::${targetType}`;
  return `CAST(${expr} AS ${targetType})`;
}

function emitCase(node: Node, ctx: ExprContext): string {
  const parts = ['CASE'];
  if (node.expr) parts.push(emitExpr(node.expr, ctx));
  for (const arm of node.args as Node[]) {
    if (arm.type === 'when') {
      parts.push(`WHEN ${emitExpr(arm.cond, ctx)} THEN ${emitExpr(arm.result, ctx)}`);
    } else if (arm.type === 'else') {
      parts.push(`ELSE ${emitExpr(arm.result, ctx)}`);
    } else {
      throw new ModelSpecGenerationError(
        'UNSUPPORTED_CONSTRUCT',
        `Unsupported CASE arm type \`${String(arm.type)}\``
      );
    }
  }
  parts.push('END');
  return parts.join(' ');
}
