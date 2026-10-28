import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dryRunInMemory } from '../../../src/api/dry-run-project.js';
import {
  TransformSpecSchema,
  type SourceRegistry,
  type TransformSpec,
} from '../../../src/compiler/index.js';
import type { InMemoryModel } from '../../../src/api/compile-in-memory.js';

import { createDuckDbHarness, type WarehouseTestHarness } from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

requireWarehouseEnv('duckdb');

function model(
  name: string,
  sourceRef: string,
  columns: { name: string; expr: string }[]
): InMemoryModel {
  const spec = TransformSpecSchema.parse({
    spec_version: '0.2',
    name,
    type: 'model',
    description: `${name} dry-run test model`,
    grain: 'order_id',
    source: { ref: sourceRef },
    columns,
    materialization: { type: 'view' },
  });
  return { name, spec: spec as TransformSpec };
}

describe.skipIf(!warehouseEnabled('duckdb'))('dryRunInMemory — DuckDB', () => {
  let harness: WarehouseTestHarness | undefined;

  beforeAll(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.teardown();
  });

  it('validates a chain of three undeployed drafts against the warehouse without persisting', async () => {
    if (!harness) throw new Error('harness not initialized');

    const sources: SourceRegistry = new Map();
    // The harness ingests the source table at `<schema>.raw_orders`.
    sources.set('warehouse.raw_orders', `${harness.schema}.raw_orders`);

    const stg = model('stg_orders_draft', 'warehouse.raw_orders', [
      { name: 'order_id', expr: 'order_id' },
      { name: 'order_total', expr: 'order_total' },
    ]);
    const fct = model('fct_orders_draft', 'stg_orders_draft', [
      { name: 'order_id', expr: 'order_id' },
      { name: 'order_total', expr: 'order_total' },
    ]);
    const mart = model('mart_orders_draft', 'fct_orders_draft', [
      { name: 'order_id', expr: 'order_id' },
      { name: 'order_total', expr: 'order_total' },
    ]);

    const result = await dryRunInMemory({
      models: [stg, fct, mart],
      sources,
      dialect: 'duckdb',
      targetSchema: harness.schema,
      runner: harness.runner,
      mode: 'limit0',
    });

    if (!result.ok) {
      throw new Error(`dry-run failed: ${JSON.stringify(result.results, null, 2)}`);
    }
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.modelName).sort()).toEqual([
      'fct_orders_draft',
      'mart_orders_draft',
      'stg_orders_draft',
    ]);

    // None of the drafts should exist as real warehouse objects.
    await expect(harness.getObjectType(`${harness.schema}.stg_orders_draft`)).resolves.toBe(null);
    await expect(harness.getObjectType(`${harness.schema}.fct_orders_draft`)).resolves.toBe(null);
    await expect(harness.getObjectType(`${harness.schema}.mart_orders_draft`)).resolves.toBe(null);
  });

  it('surfaces warehouse errors when a draft references a column that does not exist', async () => {
    if (!harness) throw new Error('harness not initialized');

    const sources: SourceRegistry = new Map();
    sources.set('warehouse.raw_orders', `${harness.schema}.raw_orders`);

    const bad = model('broken_draft', 'warehouse.raw_orders', [
      { name: 'order_id', expr: 'order_id' },
      { name: 'unknown', expr: 'this_column_does_not_exist' },
    ]);

    const result = await dryRunInMemory({
      models: [bad],
      sources,
      dialect: 'duckdb',
      targetSchema: harness.schema,
      runner: harness.runner,
      mode: 'limit0',
    });

    expect(result.ok).toBe(false);
    const broken = result.results.find((r) => r.modelName === 'broken_draft');
    expect(broken?.status).toBe('failed');
    expect(broken?.error?.toLowerCase()).toMatch(/this_column_does_not_exist|column|binder/);
  });
});
