import { describe, expect, it } from 'vitest';

import { emitExpr, parseExprField, tryParseExpr } from '../../../../src/compiler/expr/index.js';

import type { SupportedDialect } from '../../../../src/compiler/dialect.js';
import type { WindowExpr, WindowFrameSpec } from '../../../../src/compiler/expr/index.js';

describe('Window frame structural validation', () => {
  describe('ROWS frame parsing', () => {
    it('parses ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
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

    it('parses ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toBe('CURRENT ROW');
      expect(frame.end).toBe('UNBOUNDED FOLLOWING');
    });

    it('parses ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING', () => {
      const result = tryParseExpr(
        'AVG(x) OVER (ORDER BY y ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toEqual({
        offset: { kind: 'literal_number', value: 3, raw: '3' },
        direction: 'PRECEDING',
      });
      expect(frame.end).toEqual({
        offset: { kind: 'literal_number', value: 1, raw: '1' },
        direction: 'FOLLOWING',
      });
    });

    it('parses ROWS UNBOUNDED PRECEDING (shorthand without BETWEEN)', () => {
      const result = tryParseExpr('SUM(x) OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toBe('UNBOUNDED PRECEDING');
      expect(frame.end).toBeUndefined();
    });

    it('parses ROWS 5 PRECEDING (shorthand numeric offset)', () => {
      const result = tryParseExpr('SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toEqual({
        offset: { kind: 'literal_number', value: 5, raw: '5' },
        direction: 'PRECEDING',
      });
      expect(frame.end).toBeUndefined();
    });

    it('parses ROWS CURRENT ROW (shorthand)', () => {
      const result = tryParseExpr('COUNT(*) OVER (ORDER BY y ROWS CURRENT ROW)');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('ROWS');
      expect(frame.start).toBe('CURRENT ROW');
      expect(frame.end).toBeUndefined();
    });
  });

  describe('RANGE frame parsing', () => {
    it('parses RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('RANGE');
      expect(frame.start).toBe('CURRENT ROW');
      expect(frame.end).toBe('UNBOUNDED FOLLOWING');
    });

    it('parses RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('RANGE');
      expect(frame.start).toBe('UNBOUNDED PRECEDING');
      expect(frame.end).toBe('CURRENT ROW');
    });
  });

  describe('GROUPS frame parsing', () => {
    it('parses GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('GROUPS');
      expect(frame.start).toBe('UNBOUNDED PRECEDING');
      expect(frame.end).toBe('CURRENT ROW');
    });

    it('parses GROUPS BETWEEN 2 PRECEDING AND 2 FOLLOWING', () => {
      const result = tryParseExpr(
        'SUM(x) OVER (ORDER BY y GROUPS BETWEEN 2 PRECEDING AND 2 FOLLOWING)'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frame = (result.expr as WindowExpr).frame as WindowFrameSpec;
      expect(frame.type).toBe('GROUPS');
      expect(frame.start).toEqual({
        offset: { kind: 'literal_number', value: 2, raw: '2' },
        direction: 'PRECEDING',
      });
      expect(frame.end).toEqual({
        offset: { kind: 'literal_number', value: 2, raw: '2' },
        direction: 'FOLLOWING',
      });
    });
  });

  describe('frame emission', () => {
    const dialects: SupportedDialect[] = ['snowflake', 'bigquery', 'postgres', 'databricks'];

    it('emits ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
      const expr = parseExprField(
        'SUM(x) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
      );
      for (const dialect of dialects) {
        const sql = emitExpr(expr, dialect);
        expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
      }
    });

    it('emits ROWS BETWEEN N PRECEDING AND N FOLLOWING', () => {
      const expr = parseExprField(
        'AVG(x) OVER (ORDER BY y ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING)'
      );
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING');
    });

    it('emits ROWS shorthand (no BETWEEN)', () => {
      const expr = parseExprField('SUM(x) OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)');
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('ROWS UNBOUNDED PRECEDING');
      expect(sql).not.toContain('BETWEEN');
    });

    it('emits RANGE frame', () => {
      const expr = parseExprField(
        'SUM(x) OVER (ORDER BY y RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)'
      );
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING');
    });

    it('emits GROUPS frame for targets that support it', () => {
      const expr = parseExprField(
        'SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING)'
      );
      for (const dialect of ['postgres', 'duckdb'] as const) {
        expect(emitExpr(expr, dialect)).toContain('GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING');
      }
    });

    it('rejects GROUPS frame for targets without it rather than emitting invalid SQL', () => {
      const expr = parseExprField(
        'SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING)'
      );
      for (const dialect of ['snowflake', 'bigquery', 'redshift', 'databricks', 'mysql'] as const) {
        expect(() => emitExpr(expr, dialect)).toThrow(/\[unsupported_feature:windowGroupsFrame\]/);
      }
    });
  });

  describe('frame roundtrip', () => {
    it('roundtrips ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
      const input = 'SUM(x) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)';
      const expr = parseExprField(input);
      // SUM is in function catalog — always uppercase; postgres lowercases identifiers
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('SUM(x) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
    });

    it('roundtrips ROWS BETWEEN numeric offsets', () => {
      const input = 'AVG(x) OVER (ORDER BY y ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING)';
      const expr = parseExprField(input);
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('AVG(x) OVER (ORDER BY y ROWS BETWEEN 3 PRECEDING AND 1 FOLLOWING)');
    });

    it('roundtrips RANGE frame', () => {
      const input = 'SUM(x) OVER (ORDER BY y RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)';
      const expr = parseExprField(input);
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe(
        'SUM(x) OVER (ORDER BY y RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)'
      );
    });

    it('roundtrips shorthand frame', () => {
      const input = 'SUM(x) OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)';
      const expr = parseExprField(input);
      const sql = emitExpr(expr, 'postgres');
      expect(sql).toBe('SUM(x) OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)');
    });
  });
});
