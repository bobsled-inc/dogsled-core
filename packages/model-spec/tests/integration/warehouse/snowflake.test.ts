import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSnowflakeHarness,
  runMaterializationProject,
  type WarehouseTestHarness,
} from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

requireWarehouseEnv('snowflake');

describe.skipIf(!warehouseEnabled('snowflake'))('warehouse materializations — Snowflake', () => {
  let harness: WarehouseTestHarness | undefined;

  beforeAll(async () => {
    harness = createSnowflakeHarness();
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
    const database = process.env.BOBSLED_CORE_MODEL_SPEC_SNOWFLAKE_DATABASE;
    if (!database) throw new Error('Missing BOBSLED_CORE_MODEL_SPEC_SNOWFLAKE_DATABASE');

    await runMaterializationProject(harness);

    await expect(harness.getObjectType(`${database}.${harness.schema}.STG_ORDERS`)).resolves.toBe(
      'VIEW'
    );
    await expect(
      harness.getObjectType(`${database}.${harness.schema}.ORDER_SUMMARY`)
    ).resolves.toBe('TABLE');
    await expect(harness.getObjectType(`${database}.${harness.schema}.FCT_ORDERS`)).resolves.toBe(
      'TABLE'
    );
    await expect(harness.getRowCount(`${database}.${harness.schema}.FCT_ORDERS`)).resolves.toBe(3);
  });
});
