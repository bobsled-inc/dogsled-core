import { describe, expect, it } from 'vitest';

import { emitExpr, parseExprField, tryParseExpr } from '../../../../src/compiler/expr/index.js';

import type { SupportedDialect } from '../../../../src/compiler/dialect.js';
import type { WindowExpr, WindowFrameSpec } from '../../../../src/compiler/expr/index.js';

describe('Window functions', () => {
  describe('parsing', () => {
    it('parses ROW_NUMBER() OVER (PARTITION BY col ORDER BY col2 DESC)', () => {
      const result = tryParseExpr(
        'ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY date_updated DESC)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.expr.kind).toBe('window');
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('row_number');
      expect(w.fn.args).toHaveLength(0);
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
      expect(w.orderBy![0]!.direction).toBe('DESC');
    });

    it('parses RANK() OVER (ORDER BY score ASC)', () => {
      const result = tryParseExpr('RANK() OVER (ORDER BY score ASC)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('rank');
      expect(w.partitionBy).toBeUndefined();
      expect(w.orderBy).toHaveLength(1);
      expect(w.orderBy![0]!.direction).toBe('ASC');
    });

    it('parses LAG(col, 1) OVER (PARTITION BY a ORDER BY b)', () => {
      const result = tryParseExpr('LAG(col, 1) OVER (PARTITION BY a ORDER BY b)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('lag');
      expect(w.fn.args).toHaveLength(2);
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
    });

    it('parses SUM(amount) OVER (PARTITION BY dept_id)', () => {
      const result = tryParseExpr('SUM(amount) OVER (PARTITION BY dept_id)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('sum');
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toBeUndefined();
    });

    it('parses DENSE_RANK() OVER (ORDER BY salary DESC)', () => {
      const result = tryParseExpr('DENSE_RANK() OVER (ORDER BY salary DESC)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('dense_rank');
      expect(w.orderBy).toHaveLength(1);
      expect(w.orderBy![0]!.direction).toBe('DESC');
    });

    it('parses window with multiple PARTITION BY columns', () => {
      const result = tryParseExpr('ROW_NUMBER() OVER (PARTITION BY a, b, c ORDER BY d)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.partitionBy).toHaveLength(3);
    });

    it('parses window with multiple ORDER BY columns', () => {
      const result = tryParseExpr('ROW_NUMBER() OVER (ORDER BY a DESC, b ASC, c)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.orderBy).toHaveLength(3);
      expect(w.orderBy![0]!.direction).toBe('DESC');
      expect(w.orderBy![1]!.direction).toBe('ASC');
      expect(w.orderBy![2]!.direction).toBeUndefined();
    });

    it('parses FIRST_VALUE with PARTITION BY and ORDER BY', () => {
      const result = tryParseExpr(
        'FIRST_VALUE(name) OVER (PARTITION BY department ORDER BY hire_date ASC)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('first_value');
      expect(w.fn.args).toHaveLength(1);
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
    });

    it('parses empty OVER clause: COUNT(*) OVER ()', () => {
      const result = tryParseExpr('COUNT(*) OVER ()');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('count');
      expect(w.partitionBy).toBeUndefined();
      expect(w.orderBy).toBeUndefined();
    });

    it('parses window with frame clause (ROWS BETWEEN)', () => {
      const result = tryParseExpr(
        'SUM(amount) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.frame).toBeDefined();
      const frame = w.frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toBe('UNBOUNDED PRECEDING');
      expect(frame.end).toBe('CURRENT ROW');
    });

    it('parses NTILE(4) OVER (ORDER BY revenue DESC)', () => {
      const result = tryParseExpr('NTILE(4) OVER (ORDER BY revenue DESC)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('ntile');
      expect(w.fn.args).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
    });

    it('parses LEAD(col, 2, 0) OVER (ORDER BY ts)', () => {
      const result = tryParseExpr('LEAD(col, 2, 0) OVER (ORDER BY ts)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('lead');
      expect(w.fn.args).toHaveLength(3);
    });

    it('parses AVG(salary) OVER (PARTITION BY dept ORDER BY hire_date ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)', () => {
      const result = tryParseExpr(
        'AVG(salary) OVER (PARTITION BY dept ORDER BY hire_date ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('avg');
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
      expect(w.frame).toBeDefined();
      const frame = w.frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toEqual({
        offset: { kind: 'literal_number', value: 1, raw: '1' },
        direction: 'PRECEDING',
      });
      expect(frame.end).toEqual({
        offset: { kind: 'literal_number', value: 1, raw: '1' },
        direction: 'FOLLOWING',
      });
    });

    it('parses LAST_VALUE(x) IGNORE NULLS OVER (...)', () => {
      const result = tryParseExpr('LAST_VALUE(x) IGNORE NULLS OVER (PARTITION BY grp ORDER BY ts)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('last_value');
      expect(w.fn.nullsHandling).toBe('ignore');
      expect(w.partitionBy).toHaveLength(1);
      expect(w.orderBy).toHaveLength(1);
    });

    it('parses FIRST_VALUE(x) RESPECT NULLS OVER (...)', () => {
      const result = tryParseExpr('FIRST_VALUE(x) RESPECT NULLS OVER (ORDER BY ts DESC)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.fn.name).toBe('first_value');
      expect(w.fn.nullsHandling).toBe('respect');
      expect(w.orderBy).toHaveLength(1);
      expect(w.orderBy![0]!.direction).toBe('DESC');
    });

    it('parses IGNORE NULLS without OVER (standalone function)', () => {
      const result = tryParseExpr('LAST_VALUE(col) IGNORE NULLS');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Without OVER, it should be a function_call (not window)
      expect(result.expr.kind).toBe('function_call');
      if (result.expr.kind === 'function_call') {
        expect(result.expr.name).toBe('last_value');
        expect(result.expr.nullsHandling).toBe('ignore');
      }
    });
  });

  describe('emitting', () => {
    const dialects: SupportedDialect[] = ['snowflake', 'bigquery', 'postgres', 'databricks'];

    it('emits ROW_NUMBER window function for all dialects', () => {
      const expr = parseExprField(
        'ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY date_updated DESC)'
      );
      for (const dialect of dialects) {
        const sql = emitExpr(expr, dialect);
        expect(sql).toContain('OVER');
        expect(sql).toContain('PARTITION BY');
        expect(sql).toContain('ORDER BY');
        expect(sql).toContain('DESC');
      }
    });

    it('emits window with only PARTITION BY', () => {
      const expr = parseExprField('SUM(x) OVER (PARTITION BY y)');
      // Snowflake uppercases identifiers
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('SUM(X) OVER (PARTITION BY Y)');
    });

    it('emits window with only ORDER BY', () => {
      const expr = parseExprField('RANK() OVER (ORDER BY score DESC)');
      // Snowflake uppercases identifiers
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('RANK() OVER (ORDER BY SCORE DESC)');
    });

    it('emits empty OVER clause', () => {
      const expr = parseExprField('COUNT(*) OVER ()');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('COUNT(*) OVER ()');
    });

    it('emits window with frame clause', () => {
      const expr = parseExprField(
        'SUM(amount) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
      );
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('OVER');
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('ROWS');
      expect(sql).toContain('UNBOUNDED');
    });

    it('emits multiple PARTITION BY columns', () => {
      const expr = parseExprField('ROW_NUMBER() OVER (PARTITION BY a, b ORDER BY c)');
      // Snowflake uppercases identifiers
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('PARTITION BY A, B');
      expect(sql).toContain('ORDER BY C');
    });

    it('emits multiple ORDER BY columns with directions', () => {
      const expr = parseExprField('ROW_NUMBER() OVER (ORDER BY a DESC, b ASC, c)');
      // Snowflake uppercases identifiers
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('ORDER BY A DESC, B ASC, C');
    });

    it('applies dialect casing to partition and order columns', () => {
      const expr = parseExprField('ROW_NUMBER() OVER (PARTITION BY col_a ORDER BY col_b DESC)');

      // Snowflake: uppercase
      const sfSql = emitExpr(expr, 'snowflake');
      expect(sfSql).toContain('PARTITION BY COL_A');
      expect(sfSql).toContain('ORDER BY COL_B DESC');

      // Postgres: lowercase
      const pgSql = emitExpr(expr, 'postgres');
      expect(pgSql).toContain('PARTITION BY col_a');
      expect(pgSql).toContain('ORDER BY col_b DESC');
    });

    it('emits IGNORE NULLS in function call', () => {
      const expr = parseExprField('LAST_VALUE(x) IGNORE NULLS');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('IGNORE NULLS');
      expect(sql).toContain('LAST_VALUE');
    });

    it('emits RESPECT NULLS in function call', () => {
      const expr = parseExprField('FIRST_VALUE(x) RESPECT NULLS');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('RESPECT NULLS');
      expect(sql).toContain('FIRST_VALUE');
    });

    it('emits IGNORE NULLS inside window expression', () => {
      const expr = parseExprField('LAST_VALUE(x) IGNORE NULLS OVER (PARTITION BY grp ORDER BY ts)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('IGNORE NULLS');
      expect(sql).toContain('OVER');
      expect(sql).toContain('PARTITION BY');
      expect(sql).toContain('ORDER BY');
    });
  });

  describe('named WINDOW clause', () => {
    it('parses OVER identifier as named window reference', () => {
      const result = tryParseExpr('ROW_NUMBER() OVER w');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.expr as WindowExpr;
      expect(w.kind).toBe('window');
      expect(w.fn.name).toBe('row_number');
      expect(w.windowName).toBe('w');
      expect(w.partitionBy).toBeUndefined();
      expect(w.orderBy).toBeUndefined();
    });

    it('emits OVER identifier as named window reference', () => {
      const expr = parseExprField('ROW_NUMBER() OVER w');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('ROW_NUMBER() OVER w');
    });

    it('emits OVER identifier with proper casing per dialect', () => {
      const expr = parseExprField('SUM(x) OVER my_window');
      // Postgres: lowercase
      expect(emitExpr(expr, 'postgres')).toBe('SUM(x) OVER my_window');
      // BigQuery: lowercase
      expect(emitExpr(expr, 'bigquery')).toBe('SUM(x) OVER my_window');
    });

    it('throws for named window reference on targets without a WINDOW clause', () => {
      const expr = parseExprField('ROW_NUMBER() OVER w');
      for (const dialect of ['snowflake', 'redshift'] as const) {
        expect(() => emitExpr(expr, dialect)).toThrow(/\[unsupported_feature:namedWindowClause\]/);
      }
    });
  });

  describe('RATIO_TO_REPORT', () => {
    it('emits RATIO_TO_REPORT for Snowflake', () => {
      const expr = parseExprField('RATIO_TO_REPORT(amount) OVER (PARTITION BY dept)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe('RATIO_TO_REPORT(AMOUNT) OVER (PARTITION BY DEPT)');
    });

    it('emits RATIO_TO_REPORT for BigQuery', () => {
      const expr = parseExprField('RATIO_TO_REPORT(amount) OVER (PARTITION BY dept)');
      const sql = emitExpr(expr, 'bigquery');
      expect(sql).toBe('RATIO_TO_REPORT(amount) OVER (PARTITION BY dept)');
    });

    it('emits ratio_to_report with CAST for postgres (avoids integer division)', () => {
      const expr = parseExprField('RATIO_TO_REPORT(amount) OVER (PARTITION BY dept)');
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('CAST(amount AS DOUBLE PRECISION) / SUM(amount) OVER (PARTITION BY dept)');
    });

    it.each(['databricks', 'duckdb', 'mysql', 'clickhouse'] as const)(
      'emits ratio_to_report with * 1.0 for %s (avoids integer division)',
      (dialect) => {
        const expr = parseExprField('RATIO_TO_REPORT(amount) OVER (PARTITION BY dept)');
        const sql = emitExpr(expr, dialect);
        expect(sql).toBe('(amount) * 1.0 / SUM(amount) OVER (PARTITION BY dept)');
      }
    );
  });
});
