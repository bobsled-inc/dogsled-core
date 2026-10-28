/**
 * AST walker utilities for DogsledExpr trees.
 *
 * - `walkExpr` — depth-first visitor (pre-order).
 * - `mapExpr` — bottom-up transform that rebuilds the tree with transformed children.
 */

import type { DogsledExpr, FrameBound, WindowFrameSpec } from './types.js';

/** Walk offset expressions inside a frame bound. */
function walkFrameBound(bound: FrameBound, visitor: (node: DogsledExpr) => void): void {
  if (typeof bound !== 'string') {
    walkExpr(bound.offset, visitor);
  }
}

/** Map offset expressions inside a frame bound. */
function mapFrameBound(
  bound: FrameBound,
  transform: (node: DogsledExpr) => DogsledExpr
): FrameBound {
  if (typeof bound === 'string') return bound;
  return { offset: mapExpr(bound.offset, transform), direction: bound.direction };
}

/** Map offset expressions inside a structured window frame. */
function mapWindowFrame(
  frame: WindowFrameSpec,
  transform: (node: DogsledExpr) => DogsledExpr
): WindowFrameSpec {
  const start = mapFrameBound(frame.start, transform);
  const end = frame.end !== undefined ? mapFrameBound(frame.end, transform) : undefined;
  // Spread the source frame so non-expression fields (exclude) survive the
  // rebuild; only the offset expressions are transformed.
  return { ...frame, start, end };
}

/** Visit every node in the AST depth-first, calling `visitor` on each. */
export function walkExpr(expr: DogsledExpr, visitor: (node: DogsledExpr) => void): void {
  visitor(expr);

  switch (expr.kind) {
    // Leaf nodes — no children to visit
    case 'column_ref':
    case 'literal_string':
    case 'literal_number':
    case 'literal_boolean':
    case 'literal_null':
    case 'interval':
    case 'literal_star':
    case 'raw_sql':
    case 'subquery':
    case 'exists':
      break;

    case 'in_subquery':
      walkExpr(expr.expr, visitor);
      break;

    case 'binary_op':
      walkExpr(expr.left, visitor);
      walkExpr(expr.right, visitor);
      break;

    case 'unary_op':
      walkExpr(expr.operand, visitor);
      break;

    case 'function_call':
      for (const arg of expr.args) walkExpr(arg, visitor);
      break;

    case 'cast':
      walkExpr(expr.expr, visitor);
      break;

    case 'json_path_access':
      walkExpr(expr.base, visitor);
      break;

    case 'case':
      if (expr.operand) walkExpr(expr.operand, visitor);
      for (const w of expr.whens) {
        walkExpr(w.condition, visitor);
        walkExpr(w.result, visitor);
      }
      if (expr.elseExpr) walkExpr(expr.elseExpr, visitor);
      break;

    case 'between':
      walkExpr(expr.expr, visitor);
      walkExpr(expr.low, visitor);
      walkExpr(expr.high, visitor);
      break;

    case 'in_list':
      walkExpr(expr.expr, visitor);
      for (const v of expr.list) walkExpr(v, visitor);
      break;

    case 'is_null':
      walkExpr(expr.expr, visitor);
      break;

    case 'parenthesized':
      walkExpr(expr.expr, visitor);
      break;

    case 'window':
      walkExpr(expr.fn, visitor);
      if (expr.partitionBy) for (const e of expr.partitionBy) walkExpr(e, visitor);
      if (expr.orderBy) for (const o of expr.orderBy) walkExpr(o.expr, visitor);
      if (expr.frame) {
        if (expr.frame.kind === 'raw_sql') {
          walkExpr(expr.frame, visitor);
        } else if (expr.frame.kind === 'window_frame') {
          // Structured frame — walk offset expressions
          walkFrameBound(expr.frame.start, visitor);
          if (expr.frame.end !== undefined) walkFrameBound(expr.frame.end, visitor);
        }
      }
      break;

    default: {
      // Exhaustive check — TypeScript will error if a variant is unhandled
      const _exhaustive: never = expr;
      throw new Error(`Unknown expr kind: ${(_exhaustive as DogsledExpr).kind}`);
    }
  }
}

/** Transform nodes bottom-up, rebuilding the tree with transformed children. */
export function mapExpr(
  expr: DogsledExpr,
  transform: (node: DogsledExpr) => DogsledExpr
): DogsledExpr {
  switch (expr.kind) {
    // Leaf nodes — transform directly
    case 'column_ref':
    case 'literal_string':
    case 'literal_number':
    case 'literal_boolean':
    case 'literal_null':
    case 'interval':
    case 'literal_star':
    case 'raw_sql':
    case 'subquery':
    case 'exists':
      return transform(expr);

    case 'in_subquery': {
      const inner = mapExpr(expr.expr, transform);
      return transform({ ...expr, expr: inner });
    }

    case 'binary_op': {
      const left = mapExpr(expr.left, transform);
      const right = mapExpr(expr.right, transform);
      return transform({ ...expr, left, right });
    }

    case 'unary_op': {
      const operand = mapExpr(expr.operand, transform);
      return transform({ ...expr, operand });
    }

    case 'function_call': {
      const args = expr.args.map((a) => mapExpr(a, transform));
      return transform({ ...expr, args });
    }

    case 'cast': {
      const inner = mapExpr(expr.expr, transform);
      return transform({ ...expr, expr: inner });
    }

    case 'json_path_access': {
      const base = mapExpr(expr.base, transform);
      return transform({ ...expr, base });
    }

    case 'case': {
      const operand = expr.operand ? mapExpr(expr.operand, transform) : undefined;
      const whens = expr.whens.map((w) => ({
        condition: mapExpr(w.condition, transform),
        result: mapExpr(w.result, transform),
      }));
      const elseExpr = expr.elseExpr ? mapExpr(expr.elseExpr, transform) : undefined;
      return transform({ ...expr, operand, whens, elseExpr });
    }

    case 'between': {
      const inner = mapExpr(expr.expr, transform);
      const low = mapExpr(expr.low, transform);
      const high = mapExpr(expr.high, transform);
      return transform({ ...expr, expr: inner, low, high });
    }

    case 'in_list': {
      const inner = mapExpr(expr.expr, transform);
      const list = expr.list.map((v) => mapExpr(v, transform));
      return transform({ ...expr, expr: inner, list });
    }

    case 'is_null': {
      const inner = mapExpr(expr.expr, transform);
      return transform({ ...expr, expr: inner });
    }

    case 'parenthesized': {
      const inner = mapExpr(expr.expr, transform);
      return transform({ ...expr, expr: inner });
    }

    case 'window': {
      const fn = mapExpr(expr.fn, transform);
      if (fn.kind !== 'function_call') {
        throw new Error(`mapExpr transform changed window fn from 'function_call' to '${fn.kind}'`);
      }
      const partitionBy = expr.partitionBy?.map((e) => mapExpr(e, transform));
      const orderBy = expr.orderBy?.map((o) => ({
        ...o,
        expr: mapExpr(o.expr, transform),
      }));
      let frame = expr.frame;
      if (frame) {
        if (frame.kind === 'raw_sql') {
          const mappedFrame = mapExpr(frame, transform);
          if (mappedFrame.kind !== 'raw_sql') {
            throw new Error(
              `mapExpr transform changed window frame from 'raw_sql' to '${mappedFrame.kind}'`
            );
          }
          frame = mappedFrame;
        } else if (frame.kind === 'window_frame') {
          // Structured frame — map offset expressions
          frame = mapWindowFrame(frame, transform);
        }
      }
      return transform({ ...expr, fn, partitionBy, orderBy, frame });
    }

    default: {
      const _exhaustive: never = expr;
      throw new Error(`Unknown expr kind: ${(_exhaustive as DogsledExpr).kind}`);
    }
  }
}
