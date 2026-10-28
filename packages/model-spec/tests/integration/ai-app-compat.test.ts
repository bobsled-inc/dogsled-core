/**
 * Host-application compatibility guardrail.
 *
 * a downstream host application's data-model compilation service
 * pins the Layer 1 primitives and types exported from `@bobsled-inc/model-spec`
 * root. This test re-imports the exact same symbols through the root entry and
 * drives them through a representative compile to lock the contract:
 *
 *   - `buildModelRegistry`, `compileAll`, `quoteIdentifier`, `TransformSpecSchema`
 *   - `CompileResult`, `DagNode`, `MaterializationType`, `SourceRegistry`,
 *     `SupportedDialect`, `TransformSpec`
 *
 * If this test ever needs to be rewritten, the host application needs the matching
 * migration before the breaking change ships.
 *
 * Also exercises the new `compileInMemory` entry to prove that new hosts can
 * replace the host application's hand-rolled orchestration loop with a single call.
 */

import { describe, expect, it } from 'vitest';

import {
  buildModelRegistry,
  compileAll,
  quoteIdentifier,
  TransformSpecSchema,
  type CompileResult,
  type DagNode,
  type MaterializationType,
  type SourceRegistry,
  type SupportedDialect,
  type TransformSpec,
} from '../../src/compiler/index.js';
import { compileInMemory } from '../../src/api/index.js';

// ---------------------------------------------------------------------------
// Fixture — staging model that SELECTs from a single source
// ---------------------------------------------------------------------------

const DIALECT: SupportedDialect = 'snowflake';
const TARGET_SCHEMA = 'ANALYTICS';

const STG_ORDERS_SPEC = {
  spec_version: '0.2',
  name: 'stg_orders',
  type: 'model',
  description: 'Staging layer for orders',
  grain: 'order_id',
  source: { ref: 'raw_orders' },
  columns: [
    { name: 'ORDER_ID', expr: 'ID' },
    { name: 'CUSTOMER_ID', expr: 'CUSTOMER_ID' },
    { name: 'AMOUNT', expr: 'AMOUNT' },
  ],
  materialization: { type: 'view' as const },
} as const;

function buildSourceRegistry(): SourceRegistry {
  const registry: SourceRegistry = new Map();
  const fqn = `${quoteIdentifier('RAW', DIALECT)}.${quoteIdentifier('RAW_ORDERS', DIALECT)}`;
  registry.set('raw_orders', fqn);
  registry.set('RAW_ORDERS', fqn);
  return registry;
}

// ---------------------------------------------------------------------------
// Layer 1 — mirror the host application's hand-rolled orchestration
// ---------------------------------------------------------------------------

describe('Host-application Layer 1 contract', () => {
  it('compiles a staging model with the same symbols the host application imports', () => {
    const parsed = TransformSpecSchema.safeParse(STG_ORDERS_SPEC);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const spec: TransformSpec = parsed.data;
    const materialization: MaterializationType = spec.materialization.type;

    const node: DagNode = {
      name: spec.name,
      filePath: `<db:${spec.name}>`,
      refs: [],
      sourceRefs: [spec.source.ref],
      parsedSpec: spec,
      materialization,
    };

    const sources = buildSourceRegistry();
    const modelReg = buildModelRegistry([node.name], TARGET_SCHEMA, DIALECT);
    const results: CompileResult[] = compileAll([node], sources, modelReg, {
      dialect: DIALECT,
      targetSchema: TARGET_SCHEMA,
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    if (!result!.ok) return;

    expect(result!.sql).toContain('CREATE OR REPLACE VIEW');
    expect(result!.sql).toContain(quoteIdentifier(TARGET_SCHEMA, DIALECT));
    expect(result!.sql).toContain(quoteIdentifier('STG_ORDERS', DIALECT));
    expect(result!.sql).toContain(quoteIdentifier('RAW_ORDERS', DIALECT));
  });
});

// ---------------------------------------------------------------------------
// compileInMemory — drop-in replacement for the hand-rolled orchestration
// ---------------------------------------------------------------------------

describe('compileInMemory', () => {
  it('produces the same SQL as the hand-rolled Layer 1 orchestration', () => {
    const parsed = TransformSpecSchema.parse(STG_ORDERS_SPEC);
    const sources = buildSourceRegistry();

    const result = compileInMemory({
      models: [{ name: parsed.name, spec: parsed }],
      sources,
      dialect: DIALECT,
      targetSchema: TARGET_SCHEMA,
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    const [r] = result.results;
    expect(r).toBeDefined();
    expect(r!.ok).toBe(true);
    if (!r!.ok) return;

    expect(r!.sql).toContain('CREATE OR REPLACE VIEW');
    expect(r!.sql).toContain(quoteIdentifier('STG_ORDERS', DIALECT));
    expect(r!.sql).toContain(quoteIdentifier('RAW_ORDERS', DIALECT));
    expect(result.modelRegistry.get('stg_orders')).toBeDefined();
  });

  it('sorts dependent models topologically', () => {
    const stgSpec = TransformSpecSchema.parse(STG_ORDERS_SPEC);
    const fctSpec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'fct_orders',
      type: 'model',
      description: 'Fact table for orders',
      grain: 'order_id',
      source: { ref: 'stg_orders' },
      columns: [
        { name: 'ORDER_ID', expr: 'ORDER_ID' },
        { name: 'AMOUNT', expr: 'AMOUNT' },
      ],
      materialization: { type: 'table' },
    });

    const result = compileInMemory({
      models: [
        { name: fctSpec.name, spec: fctSpec },
        { name: stgSpec.name, spec: stgSpec },
      ],
      sources: buildSourceRegistry(),
      dialect: DIALECT,
      targetSchema: TARGET_SCHEMA,
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => (r.ok ? r.modelName : ''))).toEqual([
      'stg_orders',
      'fct_orders',
    ]);
  });

  it('reports a cycle error without throwing', () => {
    const aSpec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'a',
      type: 'model',
      description: 'a',
      grain: 'x',
      source: { ref: 'b' },
      columns: [{ name: 'X', expr: 'X' }],
      materialization: { type: 'view' },
    });
    const bSpec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'b',
      type: 'model',
      description: 'b',
      grain: 'x',
      source: { ref: 'a' },
      columns: [{ name: 'X', expr: 'X' }],
      materialization: { type: 'view' },
    });

    const result = compileInMemory({
      models: [
        { name: aSpec.name, spec: aSpec },
        { name: bSpec.name, spec: bSpec },
      ],
      sources: new Map(),
      dialect: DIALECT,
      targetSchema: TARGET_SCHEMA,
    });

    expect(result.ok).toBe(false);
    expect(result.results[0]?.ok).toBe(false);
    if (!result.results[0]!.ok) {
      expect(result.results[0]!.error).toMatch(/Circular dependency/);
    }
  });
});
