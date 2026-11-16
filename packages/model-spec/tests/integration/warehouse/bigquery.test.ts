import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBigQueryHarness,
  runMaterializationProject,
  type WarehouseTestHarness,
} from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

describe.skipIf(!warehouseEnabled('bigquery'))('warehouse materializations — BigQuery', () => {
  let harness: WarehouseTestHarness | undefined;

  beforeAll(async () => {
    requireWarehouseEnv('bigquery');
    harness = createBigQueryHarness();
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
    const projectId = process.env.BOBSLED_CORE_MODEL_SPEC_BIGQUERY_PROJECT;
    if (!projectId) throw new Error('Missing BOBSLED_CORE_MODEL_SPEC_BIGQUERY_PROJECT');

    await runMaterializationProject(harness);

    await expect(harness.getObjectType(`${projectId}.${harness.schema}.stg_orders`)).resolves.toBe(
      'VIEW'
    );
    await expect(
      harness.getObjectType(`${projectId}.${harness.schema}.order_summary`)
    ).resolves.toBe('TABLE');
    await expect(harness.getObjectType(`${projectId}.${harness.schema}.fct_orders`)).resolves.toBe(
      'TABLE'
    );
    await expect(harness.getRowCount(`${projectId}.${harness.schema}.fct_orders`)).resolves.toBe(3);
  });
});
