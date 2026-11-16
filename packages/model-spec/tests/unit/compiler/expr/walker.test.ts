import { describe, expect, it } from 'vitest';
import { mapExpr, parseExprField } from '../../../../src/compiler/expr/index.js';
import type { BobsledExpr } from '../../../../src/compiler/expr/types.js';

describe('mapExpr runtime kind-checks', () => {
  it('throws when transform changes window fn kind from function_call', () => {
    // Parse a window expression: count(*) OVER (PARTITION BY x)
    const ast = parseExprField('count(*) OVER (PARTITION BY x)');
    expect(ast.kind).toBe('window');

    // Transform that replaces function_call nodes with a literal
    const badTransform = (node: BobsledExpr): BobsledExpr => {
      if (node.kind === 'function_call') {
        return { kind: 'literal_number', value: 1, raw: '1' };
      }
      return node;
    };

    expect(() => mapExpr(ast, badTransform)).toThrow(
      /mapExpr transform changed window fn from 'function_call' to 'literal_number'/
    );
  });

  it('throws when transform changes window frame kind from raw_sql', () => {
    // Build a window AST with a raw_sql frame manually
    const ast: BobsledExpr = {
      kind: 'window',
      fn: { kind: 'function_call', name: 'row_number', args: [] },
      orderBy: [{ expr: { kind: 'column_ref', column: 'x' } }],
      frame: { kind: 'raw_sql', sql: 'ROWS UNBOUNDED PRECEDING' },
    };

    // Transform that replaces raw_sql nodes with a literal
    const badTransform = (node: BobsledExpr): BobsledExpr => {
      if (node.kind === 'raw_sql') {
        return { kind: 'literal_null' };
      }
      return node;
    };

    expect(() => mapExpr(ast, badTransform)).toThrow(
      /mapExpr transform changed window frame from 'raw_sql' to 'literal_null'/
    );
  });

  it('allows identity transform on window expressions', () => {
    const ast = parseExprField('count(*) OVER (PARTITION BY x)');
    // Identity transform should not throw
    const result = mapExpr(ast, (node) => node);
    expect(result.kind).toBe('window');
  });
});
