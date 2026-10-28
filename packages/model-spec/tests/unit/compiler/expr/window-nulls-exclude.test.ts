import { describe, expect, it } from 'vitest';

import {
  emitExpr,
  parseExprField,
  parseWindowFrameClause,
} from '../../../../src/compiler/expr/index.js';
import { mapExpr } from '../../../../src/compiler/expr/walker.js';

import type { SupportedDialect } from '../../../../src/compiler/dialect.js';

const NATIVE_NULLS: readonly SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'postgres',
  'pgvector',
  'duckdb',
  'redshift',
  'databricks',
];
const NO_FRAME_EXTRAS: readonly SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'redshift',
  'databricks',
  'mysql',
];

describe('window null ordering', () => {
  it('parses NULLS FIRST/LAST natively instead of falling back to raw_sql', () => {
    for (const input of [
      'ROW_NUMBER() OVER (ORDER BY b NULLS FIRST)',
      'ROW_NUMBER() OVER (ORDER BY b DESC NULLS LAST)',
      'ROW_NUMBER() OVER (ORDER BY a NULLS LAST, b DESC NULLS FIRST)',
    ]) {
      expect(parseExprField(input).kind, input).toBe('window');
    }
  });

  it('emits native null placement on every target that has the syntax', () => {
    const expr = parseExprField('ROW_NUMBER() OVER (ORDER BY b DESC NULLS LAST)');
    for (const dialect of NATIVE_NULLS) {
      expect(emitExpr(expr, dialect), dialect).toMatch(/ORDER BY \w+ DESC NULLS LAST/i);
    }
  });

  it('rewrites null placement into a leading sort key for MySQL', () => {
    expect(
      emitExpr(parseExprField('ROW_NUMBER() OVER (ORDER BY b DESC NULLS LAST)'), 'mysql')
    ).toBe('ROW_NUMBER() OVER (ORDER BY (b IS NULL) ASC, b DESC)');
    expect(emitExpr(parseExprField('ROW_NUMBER() OVER (ORDER BY b NULLS FIRST)'), 'mysql')).toBe(
      'ROW_NUMBER() OVER (ORDER BY (b IS NULL) DESC, b)'
    );
  });

  it('refuses the MySQL rewrite inside a RANGE frame, where it would change peer groups', () => {
    const expr = parseExprField(
      'SUM(x) OVER (ORDER BY b NULLS LAST RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
    );
    expect(() => emitExpr(expr, 'mysql')).toThrow(/\[unsupported_feature:windowNullsOrdering\]/);
    expect(emitExpr(expr, 'postgres')).toContain('NULLS LAST');
  });

  it('rejects NULLS without FIRST or LAST', () => {
    expect(parseExprField('ROW_NUMBER() OVER (ORDER BY b NULLS)').kind).toBe('raw_sql');
  });

  it('keeps columns named like grammar words usable', () => {
    for (const input of [
      'LAG(first) OVER (ORDER BY last)',
      'SUM(ties) OVER (PARTITION BY exclude)',
    ]) {
      expect(parseExprField(input).kind, input).toBe('window');
    }
  });
});

describe('window frame EXCLUDE', () => {
  const CASES = ['CURRENT ROW', 'GROUP', 'TIES', 'NO OTHERS'] as const;

  it('parses every EXCLUDE variant natively', () => {
    for (const variant of CASES) {
      const expr = parseExprField(
        `SUM(x) OVER (ORDER BY b ROWS UNBOUNDED PRECEDING EXCLUDE ${variant})`
      );
      expect(expr.kind, variant).toBe('window');
      expect(emitExpr(expr, 'postgres')).toContain(`EXCLUDE ${variant}`);
    }
  });

  it('emits EXCLUDE with a BETWEEN frame', () => {
    const expr = parseExprField(
      'SUM(x) OVER (ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)'
    );
    expect(emitExpr(expr, 'duckdb')).toContain(
      'ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES'
    );
  });

  it('rejects EXCLUDE for targets without it rather than emitting invalid SQL', () => {
    const expr = parseExprField('SUM(x) OVER (ORDER BY b ROWS UNBOUNDED PRECEDING EXCLUDE TIES)');
    for (const dialect of NO_FRAME_EXTRAS) {
      expect(() => emitExpr(expr, dialect), dialect).toThrow(
        /\[unsupported_feature:windowFrameExclude\]/
      );
    }
  });

  it('rejects an unknown EXCLUDE target', () => {
    expect(
      parseExprField('SUM(x) OVER (ORDER BY b ROWS UNBOUNDED PRECEDING EXCLUDE EVERYTHING)').kind
    ).toBe('raw_sql');
  });

  it('survives an AST transform', () => {
    const expr = parseExprField(
      'SUM(x) OVER (ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP)'
    );
    const mapped = mapExpr(expr, (node) => node);
    expect(emitExpr(mapped, 'postgres')).toContain('EXCLUDE GROUP');
  });
});

describe('parseWindowFrameClause', () => {
  it('parses a standalone frame clause', () => {
    expect(parseWindowFrameClause('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')).toEqual({
      kind: 'window_frame',
      type: 'ROWS',
      start: 'UNBOUNDED PRECEDING',
      end: 'CURRENT ROW',
    });
  });

  it('parses a shorthand frame with EXCLUDE', () => {
    expect(parseWindowFrameClause('ROWS UNBOUNDED PRECEDING EXCLUDE TIES')).toMatchObject({
      type: 'ROWS',
      start: 'UNBOUNDED PRECEDING',
      exclude: 'TIES',
    });
  });

  it('throws instead of passing unparsed text through', () => {
    expect(() => parseWindowFrameClause('ORDER BY b')).toThrow(/must start with ROWS/);
    expect(() => parseWindowFrameClause('ROWS UNBOUNDED PRECEDING AND THEN SOME')).toThrow();
  });
});

describe('INTERVAL literals', () => {
  it('parses both the quoted and bare amount forms to the same node', () => {
    for (const input of ["INTERVAL '7' DAY", 'INTERVAL 7 DAY']) {
      expect(parseExprField(input), input).toEqual({ kind: 'interval', amount: 7, unit: 'DAY' });
    }
  });

  it('normalises a plural unit', () => {
    expect(parseExprField('INTERVAL 3 HOURS')).toMatchObject({ unit: 'HOUR' });
  });

  it('spells the literal the way each target expects', () => {
    const expr = parseExprField("INTERVAL '7' DAY");
    // Postgres, Redshift and Snowflake want the amount and unit inside one
    // string literal; the rest want them bare.
    for (const dialect of ['postgres', 'pgvector', 'redshift', 'snowflake'] as const) {
      expect(emitExpr(expr, dialect), dialect).toBe("INTERVAL '7 DAY'");
    }
    for (const dialect of ['bigquery', 'duckdb', 'mysql', 'databricks'] as const) {
      expect(emitExpr(expr, dialect), dialect).toBe('INTERVAL 7 DAY');
    }
  });

  it('makes a RANGE frame with an interval offset native', () => {
    const expr = parseExprField(
      "SUM(x) OVER (ORDER BY b RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW)"
    );
    expect(expr.kind).toBe('window');
    // Previously the whole frame fell back to raw text and was passed through
    // unmapped; now each target gets its own interval spelling.
    expect(emitExpr(expr, 'bigquery')).toContain('INTERVAL 7 DAY PRECEDING');
    expect(emitExpr(expr, 'postgres')).toContain("INTERVAL '7 DAY' PRECEDING");
  });

  it('works in ordinary date arithmetic too', () => {
    expect(emitExpr(parseExprField('created_at - INTERVAL 1 MONTH'), 'duckdb')).toBe(
      'created_at - INTERVAL 1 MONTH'
    );
  });

  it('leaves a column named interval alone', () => {
    // Recognised by shape rather than by reserving the word.
    expect(parseExprField('interval')).toEqual({ kind: 'column_ref', column: 'interval' });
    expect(parseExprField('interval + 1').kind).toBe('binary_op');
  });

  it('rejects a unit that is not portable', () => {
    expect(parseExprField('INTERVAL 5 FORTNIGHT').kind).toBe('raw_sql');
    // QUARTER is valid on BigQuery and Snowflake but not on Postgres, so it is
    // not in the portable set and falls back rather than diverging silently.
    expect(parseExprField('INTERVAL 3 QUARTER').kind).toBe('raw_sql');
  });

  it('accepts a negative amount', () => {
    expect(parseExprField('INTERVAL -7 DAY')).toEqual({
      kind: 'interval',
      amount: -7,
      unit: 'DAY',
    });
  });

  it('rejects a fractional amount rather than emitting SQL four targets refuse', () => {
    // BigQuery, MySQL, DuckDB and Databricks all require a whole number.
    expect(parseExprField('INTERVAL 0.5 DAY').kind).toBe('raw_sql');
  });
});
