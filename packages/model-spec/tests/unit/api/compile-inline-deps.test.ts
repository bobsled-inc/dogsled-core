import { describe, expect, it } from 'vitest';

import { compileInMemory, type InMemoryModel } from '../../../src/api/compile-in-memory.js';
import {
  buildSourceRegistry,
  parseTransformSpec,
  type SourceRegistry,
  type TransformSpec,
} from '../../../src/compiler/index.js';
import { SourceSpecSchema, TransformSpecSchema } from '../../../src/compiler/index.js';

/**
 * Coverage matrix for `inlineDeps`:
 *   - boolean true  →  every upstream model inlined
 *   - Set form       →  only named drafts inlined; non-draft refs stay physical
 *   - chained drafts →  CTEs hoisted to a single top-level WITH (no nested WITH)
 *
 * Each test runs the file-less `compileInMemory` path with `selectOnly: true`,
 * which is the surface the host application uses to produce dry-run-ready SELECTs.
 */

function model(
  name: string,
  sourceRef: string,
  columns: { name: string; expr: string }[]
): InMemoryModel {
  const spec = TransformSpecSchema.parse({
    spec_version: '0.2',
    name,
    type: 'model',
    description: `${name} model`,
    grain: 'id',
    source: { ref: sourceRef },
    columns,
    materialization: { type: 'view' },
  } satisfies Record<string, unknown>);
  return { name, spec: spec as TransformSpec };
}

function makeSources(): SourceRegistry {
  // `SourceRegistry` maps refKey → fully-qualified table name (string).
  const map: SourceRegistry = new Map();
  map.set('ecom.raw_orders', 'analytics.raw_orders');
  return map;
}

describe('compileInMemory — inlineDeps', () => {
  const sources = makeSources();
  const stg = model('stg_orders', 'ecom.raw_orders', [
    { name: 'order_id', expr: 'ID' },
    { name: 'order_total', expr: 'TOTAL' },
  ]);
  const fct = model('fct_orders', 'stg_orders', [
    { name: 'order_id', expr: 'order_id' },
    { name: 'order_total', expr: 'order_total' },
  ]);
  const mart = model('mart_orders', 'fct_orders', [
    { name: 'order_id', expr: 'order_id' },
    { name: 'order_total', expr: 'order_total' },
  ]);

  it('default behavior keeps physical refs to upstream models', () => {
    const result = compileInMemory({
      models: [stg, fct],
      sources,
      dialect: 'duckdb',
      targetSchema: 'analytics',
      selectOnly: true,
    });
    expect(result.ok).toBe(true);
    const fctSql = result.results.find((r) => r.ok && r.modelName === 'fct_orders');
    expect(fctSql?.ok).toBe(true);
    if (!fctSql?.ok) throw new Error('expected fct_orders to compile');
    expect(fctSql.sql).not.toMatch(/WITH\s+__cte_/i);
    // Physical reference to the upstream stg_orders view.
    expect(fctSql.sql.toLowerCase()).toContain('analytics.stg_orders');
  });

  it('inlineDeps=true inlines every upstream model as a CTE', () => {
    const result = compileInMemory({
      models: [stg, fct],
      sources,
      dialect: 'duckdb',
      targetSchema: 'analytics',
      selectOnly: true,
      inlineDeps: true,
    });
    expect(result.ok).toBe(true);
    const fctSql = result.results.find((r) => r.ok && r.modelName === 'fct_orders');
    if (!fctSql?.ok) throw new Error('expected fct_orders to compile');
    expect(fctSql.sql).toMatch(/^\s*WITH\s+__cte_stg_orders/i);
    expect(fctSql.sql).toContain('__cte_stg_orders');
  });

  it('inlineDeps as Set only inlines named drafts; non-draft refs stay physical', () => {
    const result = compileInMemory({
      models: [stg, fct, mart],
      sources,
      dialect: 'duckdb',
      targetSchema: 'analytics',
      selectOnly: true,
      // Only fct_orders is a draft. stg_orders is deployed.
      inlineDeps: new Set(['fct_orders']),
    });
    expect(result.ok).toBe(true);
    const martSql = result.results.find((r) => r.ok && r.modelName === 'mart_orders');
    if (!martSql?.ok) throw new Error('expected mart_orders to compile');
    // fct_orders should be inlined.
    expect(martSql.sql).toContain('__cte_fct_orders');
    // stg_orders is NOT in the inline set: must appear as a physical ref
    // *inside* the inlined fct_orders CTE, not as a CTE itself.
    expect(martSql.sql).not.toContain('__cte_stg_orders');
    expect(martSql.sql.toLowerCase()).toContain('analytics.stg_orders');
  });

  it('chained drafts hoist nested CTEs into a single top-level WITH', () => {
    const result = compileInMemory({
      models: [stg, fct, mart],
      sources,
      dialect: 'duckdb',
      targetSchema: 'analytics',
      selectOnly: true,
      inlineDeps: true,
    });
    expect(result.ok).toBe(true);
    const martSql = result.results.find((r) => r.ok && r.modelName === 'mart_orders');
    if (!martSql?.ok) throw new Error('expected mart_orders to compile');
    // Single top-level WITH; the fct CTE used to wrap a nested WITH but that
    // should be hoisted out by `buildCteDefinitions`.
    expect(martSql.sql.match(/\bWITH\b/gi)?.length ?? 0).toBe(1);
    expect(martSql.sql).toContain('__cte_stg_orders');
    expect(martSql.sql).toContain('__cte_fct_orders');
  });

  it('case-insensitive membership in the inline set', () => {
    const result = compileInMemory({
      models: [stg, fct],
      sources,
      dialect: 'duckdb',
      targetSchema: 'analytics',
      selectOnly: true,
      inlineDeps: new Set(['STG_ORDERS']),
    });
    expect(result.ok).toBe(true);
    const fctSql = result.results.find((r) => r.ok && r.modelName === 'fct_orders');
    if (!fctSql?.ok) throw new Error('expected fct_orders to compile');
    expect(fctSql.sql).toContain('__cte_stg_orders');
  });

  // Suppress unused-import warning for fixtures used in setup but not asserted.
  void buildSourceRegistry;
  void parseTransformSpec;
  void SourceSpecSchema;
});
