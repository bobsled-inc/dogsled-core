import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDuckDbHarness,
  runMaterializationProject,
  type WarehouseTestHarness,
} from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

requireWarehouseEnv('duckdb');

describe.skipIf(!warehouseEnabled('duckdb'))('warehouse materializations — DuckDB', () => {
  let harness: WarehouseTestHarness | undefined;

  beforeAll(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
  });

  afterAll(async () => {
    // Skip teardown if `beforeAll` failed before / during `harness.setup()` so a
    // teardown error doesn't mask the underlying setup failure.
    if (!harness) return;
    await harness.teardown();
  });

  it('runs view, table, and incremental merge materializations', async () => {
    if (!harness) throw new Error('harness not initialized');
    await runMaterializationProject(harness);

    await expect(harness.getObjectType(`${harness.schema}.stg_orders`)).resolves.toBe('VIEW');
    await expect(harness.getObjectType(`${harness.schema}.order_summary`)).resolves.toBe('TABLE');
    await expect(harness.getObjectType(`${harness.schema}.fct_orders`)).resolves.toBe('TABLE');
    await expect(harness.getRowCount(`${harness.schema}.fct_orders`)).resolves.toBe(3);
  });
});
