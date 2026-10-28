import { describe, expect, it } from 'vitest';

import { emitExpr, parseExprField, tryParseExpr } from '../../../../src/compiler/expr/index.js';

import type {
  ExistsExpr,
  InSubqueryExpr,
  SubqueryExpr,
} from '../../../../src/compiler/expr/index.js';

describe('Subquery expressions', () => {
  describe('IN (SELECT ...)', () => {
    it('parses x IN (SELECT id FROM other_table)', () => {
      const result = tryParseExpr('x IN (SELECT id FROM other_table)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('in_subquery');
      const expr = result.expr as InSubqueryExpr;
      expect(expr.expr).toEqual({ kind: 'column_ref', column: 'x' });
      expect(expr.subquerySql).toBe('SELECT id FROM other_table');
      expect(expr.negated).toBeFalsy();
    });

    it('parses x NOT IN (SELECT id FROM other_table)', () => {
      const result = tryParseExpr('x NOT IN (SELECT id FROM other_table)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('in_subquery');
      const expr = result.expr as InSubqueryExpr;
      expect(expr.expr).toEqual({ kind: 'column_ref', column: 'x' });
      expect(expr.subquerySql).toBe('SELECT id FROM other_table');
      expect(expr.negated).toBe(true);
    });

    it('preserves subquery SQL with WHERE clause', () => {
      const result = tryParseExpr('status IN (SELECT code FROM status_codes WHERE active = TRUE)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expr = result.expr as InSubqueryExpr;
      expect(expr.subquerySql).toContain('WHERE');
      expect(expr.subquerySql).toContain('active');
    });

    it('handles nested parens in subquery', () => {
      const result = tryParseExpr(
        'x IN (SELECT id FROM (SELECT * FROM nested_table) sub WHERE sub.active = TRUE)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expr = result.expr as InSubqueryExpr;
      expect(expr.subquerySql).toContain('SELECT * FROM nested_table');
      expect(expr.subquerySql).toContain('sub');
    });

    it('still parses regular IN (value_list) correctly', () => {
      const result = tryParseExpr('x IN (1, 2, 3)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('in_list');
    });

    it('still parses regular NOT IN (value_list) correctly', () => {
      const result = tryParseExpr("x NOT IN ('a', 'b')");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('in_list');
    });
  });

  describe('EXISTS (SELECT ...)', () => {
    it('parses EXISTS (SELECT 1 FROM other_table)', () => {
      const result = tryParseExpr('EXISTS (SELECT 1 FROM other_table)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('exists');
      const expr = result.expr as ExistsExpr;
      expect(expr.subquerySql).toBe('SELECT 1 FROM other_table');
      expect(expr.negated).toBeFalsy();
    });

    it('parses NOT EXISTS (SELECT 1 FROM other_table WHERE ...)', () => {
      const result = tryParseExpr(
        'NOT EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = c.id)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('exists');
      const expr = result.expr as ExistsExpr;
      expect(expr.subquerySql).toContain('SELECT 1 FROM orders');
      expect(expr.subquerySql).toContain('orders . customer_id');
      expect(expr.negated).toBe(true);
    });

    it('handles nested parens in EXISTS subquery', () => {
      const result = tryParseExpr('EXISTS (SELECT 1 FROM (SELECT id FROM base) t)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expr = result.expr as ExistsExpr;
      expect(expr.subquerySql).toContain('SELECT id FROM base');
    });
  });

  describe('scalar subquery', () => {
    it('parses (SELECT MAX(price) FROM products)', () => {
      const result = tryParseExpr('(SELECT MAX(price) FROM products)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('subquery');
      const expr = result.expr as SubqueryExpr;
      expect(expr.sql).toContain('SELECT');
      // Raw SQL captures tokens as-is; MAX is tokenized as an identifier
      expect(expr.sql).toContain('MAX');
      expect(expr.sql).toContain('price');
      expect(expr.sql).toContain('products');
    });

    it('parses scalar subquery with nested parens', () => {
      const result = tryParseExpr('(SELECT COUNT(*) FROM (SELECT id FROM nested))');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('subquery');
      const expr = result.expr as SubqueryExpr;
      expect(expr.sql).toContain('COUNT');
      expect(expr.sql).toContain('SELECT id FROM nested');
    });

    it('scalar subquery in comparison', () => {
      const result = tryParseExpr('price > (SELECT AVG(price) FROM products)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('binary_op');
      if (result.expr.kind === 'binary_op') {
        expect(result.expr.op).toBe('>');
        expect(result.expr.left).toEqual({ kind: 'column_ref', column: 'price' });
        expect(result.expr.right.kind).toBe('subquery');
      }
    });

    it('regular parenthesized expression still works', () => {
      const result = tryParseExpr('(a + b)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('parenthesized');
    });
  });

  describe('emission', () => {
    it('emits IN subquery', () => {
      const expr = parseExprField('x IN (SELECT id FROM other_table)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('X IN (SELECT id FROM other_table)');
    });

    it('emits NOT IN subquery', () => {
      const expr = parseExprField('x NOT IN (SELECT id FROM other_table)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('X NOT IN (SELECT id FROM other_table)');
    });

    it('emits EXISTS', () => {
      const expr = parseExprField('EXISTS (SELECT 1 FROM other_table)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('EXISTS (SELECT 1 FROM other_table)');
    });

    it('emits NOT EXISTS', () => {
      const expr = parseExprField('NOT EXISTS (SELECT 1 FROM other_table)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('NOT EXISTS (SELECT 1 FROM other_table)');
    });

    it('emits scalar subquery', () => {
      const expr = parseExprField('(SELECT MAX(price) FROM products)');
      const sql = emitExpr(expr, 'snowflake');
      // Raw SQL tokens are preserved as-is; parens in function calls become separate tokens
      expect(sql).toBe('(SELECT MAX ( price ) FROM products)');
    });

    it('emits IN subquery with postgres dialect', () => {
      const expr = parseExprField('x IN (SELECT id FROM other_table)');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('x IN (SELECT id FROM other_table)');
    });
  });

  describe('roundtrip', () => {
    it('roundtrips IN subquery through parse-emit', () => {
      const input = 'x IN (SELECT id FROM other_table)';
      const expr = parseExprField(input);
      expect(expr.kind).toBe('in_subquery');
      // Emit with postgres (preserves case)
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('x IN (SELECT id FROM other_table)');
    });

    it('roundtrips NOT IN subquery through parse-emit', () => {
      const input = 'x NOT IN (SELECT id FROM other_table)';
      const expr = parseExprField(input);
      expect(expr.kind).toBe('in_subquery');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('x NOT IN (SELECT id FROM other_table)');
    });

    it('roundtrips EXISTS through parse-emit', () => {
      const input = 'EXISTS (SELECT 1 FROM other_table)';
      const expr = parseExprField(input);
      expect(expr.kind).toBe('exists');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('EXISTS (SELECT 1 FROM other_table)');
    });

    it('roundtrips NOT EXISTS through parse-emit', () => {
      const input = 'NOT EXISTS (SELECT 1 FROM other_table)';
      const expr = parseExprField(input);
      expect(expr.kind).toBe('exists');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('NOT EXISTS (SELECT 1 FROM other_table)');
    });
  });
});
