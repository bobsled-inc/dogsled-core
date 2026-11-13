import { describe, expect, it } from 'vitest';

import { generateSelectSql } from '../../../src/compiler/codegen.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type { ResolvedTransformSpec } from '../../../src/compiler/parser.js';

const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec =>
  ({
    name: 'company_windows',
    description: 'Named window coverage.',
    grain: 'company_id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_companies',
    source: { fqTableName: 'RAW.RAW_COMPANIES', alias: 't0' },
    joins: [],
    columns: [{ name: 'company_id', expr: 'company_id' }],
    materialization: 'view',
    ...overrides,
  }) as ResolvedTransformSpec;

const WITH_NAMED_WINDOW = makeSpec({
  windows: [
    {
      name: 'by_parent',
      partitionBy: ['parent_id'],
      orderBy: [{ column: 'founded_at', direction: 'asc', nulls: 'last' }],
      frame: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
    },
  ],
  columns: [
    { name: 'company_id', expr: 'company_id' },
    { name: 'running_revenue', expr: 'SUM(revenue) OVER by_parent' },
    { name: 'is_first', expr: 'CASE WHEN ROW_NUMBER() OVER by_parent = 1 THEN 1 ELSE 0 END' },
  ],
});

describe('named windows', () => {
  it('declares a WINDOW clause on targets that have one', () => {
    for (const dialect of ['postgres', 'duckdb', 'bigquery'] as const) {
      const sql = generateSelectSql(WITH_NAMED_WINDOW, dialect);
      expect(sql, dialect).toMatch(/WINDOW by_parent AS \(/i);
      expect(sql, dialect).toContain('OVER by_parent');
    }
  });

  it('inlines the window at every use site on targets with no WINDOW clause', () => {
    for (const dialect of ['snowflake', 'redshift'] as const) {
      const sql = generateSelectSql(WITH_NAMED_WINDOW, dialect);
      expect(sql, dialect).not.toMatch(/\bWINDOW\b/i);
      expect(sql, dialect).not.toMatch(/OVER by_parent/i);
      // Both use sites expand, including the reference nested inside CASE.
      const inlined = sql.match(/OVER \(PARTITION BY/gi) ?? [];
      expect(inlined.length, dialect).toBe(2);
    }
  });

  it('carries the named window frame and null placement into the inlined form', () => {
    const sql = generateSelectSql(WITH_NAMED_WINDOW, 'snowflake');
    expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
    expect(sql).toContain('NULLS LAST');
  });

  it('validates the named window frame instead of passing the text through', () => {
    const spec = makeSpec({
      windows: [{ name: 'w', partitionBy: ['a'], frame: 'ROWS SOMEWHERE NEAR THE MIDDLE' }],
      columns: [{ name: 'c', expr: 'SUM(x) OVER w' }],
    });
    expect(() => generateSelectSql(spec, 'postgres')).toThrow(/invalid frame clause/i);
  });

  it('rejects a reference to a window that was never declared', () => {
    const spec = makeSpec({
      windows: [{ name: 'declared', partitionBy: ['a'] }],
      columns: [{ name: 'c', expr: 'SUM(x) OVER missing' }],
    });
    expect(() => generateSelectSql(spec, 'snowflake')).toThrow(/not declared in "windows"/);
  });

  it('gates an unsupported named window frame per dialect', () => {
    const spec = makeSpec({
      windows: [
        { name: 'w', partitionBy: ['a'], frame: 'GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW' },
      ],
      columns: [{ name: 'c', expr: 'SUM(x) OVER w' }],
    });
    expect(generateSelectSql(spec, 'duckdb')).toContain('GROUPS BETWEEN');
    expect(() => generateSelectSql(spec, 'bigquery')).toThrow(
      /\[unsupported_feature:windowGroupsFrame\]/
    );
  });
});

describe('null placement outside window expressions', () => {
  it('applies to model-level ORDER BY', () => {
    const spec = makeSpec({ orderBy: [{ column: 'parent_id', direction: 'asc', nulls: 'first' }] });
    expect(generateSelectSql(spec, 'postgres')).toMatch(/ORDER BY parent_id ASC NULLS FIRST/i);
    expect(generateSelectSql(spec, 'mysql')).toMatch(
      /ORDER BY \(parent_id IS NULL\) DESC, parent_id ASC/i
    );
  });

  it('applies to dedupe ordering, which decides the surviving row', () => {
    const spec = makeSpec({
      dedupe: {
        keys: ['company_id'],
        strategy: 'keep_first',
        order_by: [{ column: 'updated_at', direction: 'desc', nulls: 'last' }],
      },
    } as Partial<ResolvedTransformSpec>);
    expect(generateSelectSql(spec, 'snowflake')).toContain('NULLS LAST');
  });
});

describe('SQL normalisation', () => {
  it('does not let the same-dialect normalisation pass drop null placement', () => {
    // transpile(sql, d, d) discards NULLS LAST on several targets; the emitted
    // SQL has to win, or dedupe and qualify silently pick a different row.
    const spec = makeSpec({
      columns: [
        {
          name: 'r',
          expr: 'RANK() OVER (PARTITION BY parent_id ORDER BY revenue DESC NULLS LAST)',
        },
      ],
    });
    const dialects: readonly SupportedDialect[] = [
      'snowflake',
      'bigquery',
      'postgres',
      'duckdb',
      'redshift',
      'databricks',
    ];
    for (const dialect of dialects) {
      expect(generateSelectSql(spec, dialect), dialect).toMatch(/NULLS LAST/i);
    }
  });

  it('warns when it keeps the emitted SQL over the normalised SQL', () => {
    const warnings: string[] = [];
    generateSelectSql(
      makeSpec({
        columns: [{ name: 'r', expr: 'RANK() OVER (ORDER BY revenue DESC NULLS LAST)' }],
      }),
      'duckdb',
      undefined,
      { warnings }
    );
    expect(warnings.some((w) => /normalisation dropped NULLS/i.test(w))).toBe(true);
  });
});
