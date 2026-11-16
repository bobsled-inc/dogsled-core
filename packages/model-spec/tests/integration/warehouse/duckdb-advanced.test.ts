/**
 * Advanced materialization tests against the DuckDB harness.
 *
 * Each test spins up its own harness (fresh project + fresh `.duckdb` file) so
 * state never leaks between scenarios. Covers snapshot SCD-2, view↔table
 * transitions, schema drift policies, hooks, append/delete_insert strategies,
 * and ephemeral CTE inlining.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runProject, type RunProjectResult } from '../../../src/api/run-project.js';
import { loadState } from '../../../src/compiler/state.js';

import { createDuckDbHarness, type WarehouseTestHarness } from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

requireWarehouseEnv('duckdb');

// ---------------------------------------------------------------------------
// Inline test helpers
// ---------------------------------------------------------------------------

async function writeModel(
  harness: WarehouseTestHarness,
  name: string,
  yaml: string
): Promise<void> {
  await writeFile(join(harness.projectDir, 'models', `${name}.yml`), yaml, 'utf8');
}

async function deleteModel(harness: WarehouseTestHarness, name: string): Promise<void> {
  await rm(join(harness.projectDir, 'models', `${name}.yml`), { force: true });
}

interface RunOnceOptions {
  fullRefresh?: boolean;
}

async function runOnce(
  harness: WarehouseTestHarness,
  opts: RunOnceOptions = {}
): Promise<RunProjectResult> {
  const customRunners = new CustomRunnerRegistry();
  const query = harness.runner.query;
  customRunners.register(harness.handle, 'file', async () => ({
    run: (sql) => harness.runner.run(sql),
    query: query ? (sql) => query(sql) : undefined,
  }));
  return runProject(harness.projectDir, {
    integration: harness.handle,
    fullRefresh: opts.fullRefresh ?? false,
    customRunners,
  });
}

/**
 * Remove the auto-created models so each scenario can write its own minimal
 * model graph without collateral DDL from `stg_orders`/`order_summary`/`fct_orders`.
 */
async function clearAutoModels(harness: WarehouseTestHarness): Promise<void> {
  for (const name of ['stg_orders', 'order_summary', 'fct_orders']) {
    await deleteModel(harness, name);
  }
}

async function writeCustomersSource(harness: WarehouseTestHarness): Promise<void> {
  await harness.runner.run(
    `CREATE TABLE "${harness.schema}"."raw_customers" (
       customer_id INTEGER,
       status VARCHAR,
       email VARCHAR
     )`
  );
  await harness.runner.run(
    `INSERT INTO "${harness.schema}"."raw_customers" VALUES
      (1, 'active', 'a@example.com'),
      (2, 'active', 'b@example.com')`
  );
  await writeFile(
    join(harness.projectDir, 'sources', 'customers.yml'),
    `spec_version: '0.2'
name: customers
type: source
source_type: warehouse_table
connection: ${harness.handle}
table: ${harness.schema}.raw_customers
description: Customers source for snapshot test.
schema:
  columns:
    - { name: customer_id, type: INTEGER }
    - { name: status, type: STRING }
    - { name: email, type: STRING }
`,
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!warehouseEnabled('duckdb'))('warehouse advanced materializations — DuckDB', () => {
  let harness: WarehouseTestHarness | undefined;

  beforeEach(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
  });

  afterEach(async () => {
    if (!harness) return;
    await harness.teardown();
    harness = undefined;
  });

  // -----------------------------------------------------------------------
  // C1. Snapshot SCD-2 second run — verifies the MERGE-then-INSERT path
  // closes the prior current row and inserts the new version end-to-end.
  // -----------------------------------------------------------------------
  it('C1: snapshot SCD-2 captures change history on second run', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);
    await writeCustomersSource(harness);

    const snapshotYaml = `spec_version: '0.2'
name: dim_customers
type: model
description: SCD-2 snapshot of customers.
grain:
  - customer_id
source:
  ref: ${harness.handle}.customers
columns:
  - { name: customer_id, expr: customer_id }
  - { name: status, expr: status }
  - { name: email, expr: email }
target_schema: ${harness.schema}
materialization:
  type: snapshot
  unique_key: customer_id
  tracked_columns: [status, email]
`;
    await writeModel(harness, 'dim_customers', snapshotYaml);

    // First run — create the snapshot table.
    const first = await runOnce(harness, { fullRefresh: true });
    expect(first.ok, JSON.stringify(first.byIntegration, null, 2)).toBe(true);

    const fqName = `${harness.schema}.dim_customers`;
    await expect(harness.getObjectType(fqName)).resolves.toBe('TABLE');

    // Verify SCD-2 columns exist by querying the table.
    const query = harness.runner.query;
    if (!query) throw new Error('DuckDB runner missing query()');
    const firstRows = await query(`SELECT * FROM "${harness.schema}"."dim_customers"`);
    expect(firstRows).toHaveLength(2);
    const firstRow = firstRows[0];
    expect(firstRow).toBeDefined();
    const firstKeys = Object.keys(firstRow ?? {}).map((k) => k.toLowerCase());
    expect(firstKeys).toContain('valid_from');
    expect(firstKeys).toContain('valid_to');
    expect(firstKeys).toContain('is_current');

    // Mutate one customer's status in the source.
    await harness.runner.run(
      `UPDATE "${harness.schema}"."raw_customers" SET status = 'churned' WHERE customer_id = 1`
    );

    // Second run — incremental snapshot pass.
    const second = await runOnce(harness);
    expect(second.ok, JSON.stringify(second.byIntegration, null, 2)).toBe(true);

    const totalRows = await harness.getRowCount(fqName);
    expect(totalRows).toBe(3); // 2 original + 1 new version for customer 1.

    const customerOneRows = await query(
      `SELECT customer_id, status, is_current
         FROM "${harness.schema}"."dim_customers"
         WHERE customer_id = 1
         ORDER BY is_current`
    );
    expect(customerOneRows).toHaveLength(2);
    const closedRow = customerOneRows[0];
    const currentRow = customerOneRows[1];
    expect(closedRow).toBeDefined();
    expect(currentRow).toBeDefined();
    expect(closedRow?.is_current ?? closedRow?.IS_CURRENT).toBe(false);
    expect(closedRow?.status ?? closedRow?.STATUS).toBe('active');
    expect(currentRow?.is_current ?? currentRow?.IS_CURRENT).toBe(true);
    expect(currentRow?.status ?? currentRow?.STATUS).toBe('churned');

    // Third run with no source changes — NOT EXISTS pattern must be idempotent.
    const third = await runOnce(harness);
    expect(third.ok, JSON.stringify(third.byIntegration, null, 2)).toBe(true);
    await expect(harness.getRowCount(fqName)).resolves.toBe(3);
  });

  // -----------------------------------------------------------------------
  // C2. View ↔ table transitions (bidirectional)
  // -----------------------------------------------------------------------
  it('C2: view↔table transitions emit DROP + CREATE in both directions', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const { handle, schema } = harness;
    const yamlFor = (materialization: 'view' | 'table'): string => `spec_version: '0.2'
name: stg_orders
type: model
description: View↔table transition target.
grain:
  - order_id
source:
  ref: ${handle}.orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }
  - { name: updated_at, expr: updated_at }
target_schema: ${schema}
materialization:
  type: ${materialization}
`;

    // Initial: VIEW.
    await writeModel(harness, 'stg_orders', yamlFor('view'));
    const r1 = await runOnce(harness, { fullRefresh: true });
    expect(r1.ok, JSON.stringify(r1.byIntegration, null, 2)).toBe(true);
    await expect(harness.getObjectType(`${harness.schema}.stg_orders`)).resolves.toBe('VIEW');

    // Switch to TABLE — `planTransition` emits `DROP VIEW IF EXISTS` + CREATE TABLE.
    await writeModel(harness, 'stg_orders', yamlFor('table'));
    const r2 = await runOnce(harness);
    expect(r2.ok, JSON.stringify(r2.byIntegration, null, 2)).toBe(true);
    await expect(harness.getObjectType(`${harness.schema}.stg_orders`)).resolves.toBe('TABLE');

    // Switch back to VIEW — `planTransition` emits `DROP TABLE IF EXISTS` + CREATE VIEW.
    await writeModel(harness, 'stg_orders', yamlFor('view'));
    const r3 = await runOnce(harness);
    expect(r3.ok, JSON.stringify(r3.byIntegration, null, 2)).toBe(true);
    await expect(harness.getObjectType(`${harness.schema}.stg_orders`)).resolves.toBe('VIEW');
  });

  // -----------------------------------------------------------------------
  // C3. Schema drift `fail`
  // -----------------------------------------------------------------------
  it('C3: schema drift with on_schema_change=fail aborts and preserves state', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const { handle, schema } = harness;
    const baseYaml = (columns: string): string => `spec_version: '0.2'
name: fct_orders
type: model
description: Incremental fact table for schema-drift test.
grain:
  - order_id
source:
  ref: ${handle}.orders
columns:
${columns}
target_schema: ${schema}
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  on_schema_change: fail
`;
    const fullColumns = `  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }`;
    const droppedColumns = `  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_total, expr: order_total }`;

    await writeModel(harness, 'fct_orders', baseYaml(fullColumns));
    const first = await runOnce(harness, { fullRefresh: true });
    expect(first.ok, JSON.stringify(first.byIntegration, null, 2)).toBe(true);

    const stateBefore = loadState(harness.projectDir);

    // Drop `order_status` — incremental + `on_schema_change: fail` should reject.
    await writeModel(harness, 'fct_orders', baseYaml(droppedColumns));

    // Schema drift `fail` is now surfaced as a per-model failure inside
    // `result.byIntegration[i].executionResults` — `runProject` returns with
    // `ok: false` instead of throwing. This makes the failure visible in
    // `bobsled model run --json` output.
    const result = await runOnce(harness);
    expect(result.ok).toBe(false);
    const integration = result.byIntegration[0];
    expect(integration?.executionResults).toBeDefined();
    const failed = integration?.executionResults?.find((r) => r.modelName === 'fct_orders');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Schema drift detected');

    const stateAfter = loadState(harness.projectDir);
    expect(stateAfter).toEqual(stateBefore);
  });

  // -----------------------------------------------------------------------
  // C4. Schema drift `full_refresh`
  // -----------------------------------------------------------------------
  it('C4: schema drift with on_schema_change=full_refresh rebuilds the table and warns', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const { handle, schema } = harness;
    const baseYaml = (columns: string): string => `spec_version: '0.2'
name: fct_orders
type: model
description: Incremental fact table — rebuilds on drift.
grain:
  - order_id
source:
  ref: ${handle}.orders
columns:
${columns}
target_schema: ${schema}
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  on_schema_change: full_refresh
`;
    const fullColumns = `  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }`;
    const droppedColumns = `  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_total, expr: order_total }`;

    await writeModel(harness, 'fct_orders', baseYaml(fullColumns));
    const first = await runOnce(harness, { fullRefresh: true });
    expect(first.ok, JSON.stringify(first.byIntegration, null, 2)).toBe(true);

    // Mutate to drop a column — should auto-rebuild on drift.
    await writeModel(harness, 'fct_orders', baseYaml(droppedColumns));
    const second = await runOnce(harness);
    expect(second.ok, JSON.stringify(second.byIntegration, null, 2)).toBe(true);

    const fqName = `${harness.schema}.fct_orders`;
    await expect(harness.getObjectType(fqName)).resolves.toBe('TABLE');
    await expect(harness.getRowCount(fqName)).resolves.toBe(2);

    // Drift warning surfaces at the project level (`result.warnings`).
    const hasDriftWarning = second.warnings.some((w) => w.toLowerCase().includes('schema drift'));
    expect(hasDriftWarning, `expected drift warning, got: ${JSON.stringify(second.warnings)}`).toBe(
      true
    );
  });

  // -----------------------------------------------------------------------
  // C5. Hooks pre/post
  // -----------------------------------------------------------------------
  it('C5: pre_hook executes before materialization with {schema}/{name} expansion', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const yaml = `spec_version: '0.2'
name: stg_orders
type: model
description: Hook test target.
grain:
  - order_id
source:
  ref: ${harness.handle}.orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }
  - { name: updated_at, expr: updated_at }
target_schema: ${harness.schema}
materialization:
  type: table
pre_hook:
  - "CREATE TABLE IF NOT EXISTS {schema}.bms_sentinel_{name} AS SELECT 1 AS marker"
`;
    await writeModel(harness, 'stg_orders', yaml);

    const result = await runOnce(harness, { fullRefresh: true });
    expect(result.ok, JSON.stringify(result.byIntegration, null, 2)).toBe(true);

    const sentinelFqName = `${harness.schema}.bms_sentinel_stg_orders`;
    await expect(harness.getObjectType(sentinelFqName)).resolves.toBe('TABLE');
    await expect(harness.getRowCount(sentinelFqName)).resolves.toBe(1);

    // Materialized model itself should also be created.
    await expect(harness.getObjectType(`${harness.schema}.stg_orders`)).resolves.toBe('TABLE');
  });

  // -----------------------------------------------------------------------
  // C6. Incremental `append` strategy second run — verifies `self` substitution
  // resolves to the target table and `incremental_filter` is suppressed on
  // first runs while applied on subsequent ones.
  // -----------------------------------------------------------------------
  it('C6: incremental append strategy adds new rows without duplicating existing', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const yaml = `spec_version: '0.2'
name: fct_orders
type: model
description: Append-strategy incremental fact.
grain:
  - order_id
source:
  ref: ${harness.handle}.orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }
  - { name: updated_at, expr: updated_at }
target_schema: ${harness.schema}
materialization:
  type: incremental
  strategy: append
  incremental_filter: "order_id > COALESCE((SELECT MAX(order_id) FROM self), 0)"
`;
    await writeModel(harness, 'fct_orders', yaml);

    const first = await runOnce(harness, { fullRefresh: true });
    expect(first.ok, JSON.stringify(first.byIntegration, null, 2)).toBe(true);

    const fqName = `${harness.schema}.fct_orders`;
    await expect(harness.getRowCount(fqName)).resolves.toBe(2);

    // Insert a new row in the source (id=3).
    await harness.runner.run(
      `INSERT INTO "${harness.schema}"."raw_orders" VALUES
          (3, 30, 'paid', 125.00, TIMESTAMP '2026-01-03 00:00:00')`
    );

    const second = await runOnce(harness);
    expect(second.ok, JSON.stringify(second.byIntegration, null, 2)).toBe(true);

    // Append run inserted exactly one row (the new id=3), not duplicating the
    // existing two via the `incremental_filter` guard.
    await expect(harness.getRowCount(fqName)).resolves.toBe(3);
  });

  // -----------------------------------------------------------------------
  // C7. Incremental `delete_insert` strategy second run
  // -----------------------------------------------------------------------
  it('C7: incremental delete_insert strategy upserts changed rows in place', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const yaml = `spec_version: '0.2'
name: fct_orders
type: model
description: Delete+insert incremental fact.
grain:
  - order_id
source:
  ref: ${harness.handle}.orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }
  - { name: updated_at, expr: updated_at }
target_schema: ${harness.schema}
materialization:
  type: incremental
  strategy: delete_insert
  unique_key: order_id
`;
    await writeModel(harness, 'fct_orders', yaml);

    const first = await runOnce(harness, { fullRefresh: true });
    expect(first.ok, JSON.stringify(first.byIntegration, null, 2)).toBe(true);

    const fqName = `${harness.schema}.fct_orders`;
    await expect(harness.getRowCount(fqName)).resolves.toBe(2);

    // Update an existing row's status in the source.
    await harness.runner.run(
      `UPDATE "${harness.schema}"."raw_orders" SET order_status = 'refunded' WHERE order_id = 1`
    );

    const second = await runOnce(harness);
    expect(second.ok, JSON.stringify(second.byIntegration, null, 2)).toBe(true);

    // Total row count unchanged (no duplication via delete-then-insert).
    await expect(harness.getRowCount(fqName)).resolves.toBe(2);

    const query = harness.runner.query;
    if (!query) throw new Error('DuckDB runner missing query()');
    const rows = await query(
      `SELECT order_id, order_status FROM "${harness.schema}"."fct_orders" WHERE order_id = 1`
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.order_status ?? row?.ORDER_STATUS).toBe('refunded');
  });

  // -----------------------------------------------------------------------
  // C8. Ephemeral CTE inlining
  // -----------------------------------------------------------------------
  it('C8: ephemeral models inline as CTEs with no DB object', async () => {
    if (!harness) throw new Error('harness not initialized');
    await clearAutoModels(harness);

    const intYaml = `spec_version: '0.2'
name: int_orders
type: model
description: Ephemeral intermediate model.
grain:
  - order_id
source:
  ref: ${harness.handle}.orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_total, expr: order_total }
target_schema: ${harness.schema}
materialization:
  type: ephemeral
`;
    const fctYaml = `spec_version: '0.2'
name: fct_orders
type: model
description: Downstream model that consumes int_orders.
grain:
  - order_id
source:
  ref: int_orders
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_total, expr: order_total }
target_schema: ${harness.schema}
materialization:
  type: table
`;
    await writeModel(harness, 'int_orders', intYaml);
    await writeModel(harness, 'fct_orders', fctYaml);

    const result = await runOnce(harness, { fullRefresh: true });
    expect(result.ok, JSON.stringify(result.byIntegration, null, 2)).toBe(true);

    // `int_orders` should NOT exist as a database object — it inlined into
    // `fct_orders`'s SELECT as a CTE.
    await expect(harness.getObjectType(`${harness.schema}.int_orders`)).resolves.toBeNull();

    // `fct_orders` should exist with all source rows visible (proves inlining).
    await expect(harness.getObjectType(`${harness.schema}.fct_orders`)).resolves.toBe('TABLE');
    await expect(harness.getRowCount(`${harness.schema}.fct_orders`)).resolves.toBe(2);
  });
});
