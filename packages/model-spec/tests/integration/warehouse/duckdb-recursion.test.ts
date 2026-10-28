/**
 * Recursion executed against the DuckDB harness.
 *
 * The compiler emitting plausible `WITH RECURSIVE` text proves nothing on its
 * own: a walk can terminate and still return the wrong rows. These tests run the
 * compiler's own output over a fixture graph that contains a clean tree, a cycle
 * with no root above it, and an orphan, then assert the rows.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runProject } from '../../../src/api/run-project.js';

import { createDuckDbHarness, type WarehouseTestHarness } from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

requireWarehouseEnv('duckdb');

const RUN = warehouseEnabled('duckdb');

async function runProjectOnce(harness: WarehouseTestHarness): Promise<void> {
  const customRunners = new CustomRunnerRegistry();
  const query = harness.runner.query;
  customRunners.register(harness.handle, 'file', async () => ({
    run: (sql) => harness.runner.run(sql),
    query: query ? (sql) => query(sql) : undefined,
  }));
  const result = await runProject(harness.projectDir, {
    integration: harness.handle,
    fullRefresh: false,
    customRunners,
  });
  if (!result.ok) {
    const failures = result.byIntegration.flatMap((integration) =>
      integration.executionResults.filter((r) => r.status !== 'success')
    );
    throw new Error(
      failures.map((f) => `${f.modelName}: ${f.status} ${f.error ?? ''}`).join('\n') ||
        'run failed with no per-model detail'
    );
  }
}

describe.skipIf(!RUN)('duckdb: recursion', () => {
  let harness: WarehouseTestHarness;

  beforeEach(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
    // Drop the harness's own models so each scenario compiles only its own.
    for (const name of ['stg_orders', 'order_summary', 'fct_orders']) {
      await rm(join(harness.projectDir, 'models', `${name}.yml`), { force: true });
    }
    await harness.runner.run(
      `CREATE TABLE "${harness.schema}"."raw_companies" (
         company_id INTEGER, parent_id INTEGER, name VARCHAR)`
    );
    // 1 roots a three-level tree; 50/51/52 form a cycle with no parent above it;
    // 99 points at a parent row that does not exist.
    await harness.runner.run(
      `INSERT INTO "${harness.schema}"."raw_companies" VALUES
        (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'a1'), (5, 4, 'a1x'),
        (50, 52, 'c1'), (51, 50, 'c2'), (52, 51, 'c3'), (99, 98, 'orphan')`
    );
    await writeFile(
      join(harness.projectDir, 'sources', 'companies.yml'),
      `spec_version: '0.2'
name: companies
type: source
source_type: warehouse_table
connection: ${harness.handle}
table: ${harness.schema}.raw_companies
description: Company hierarchy fixture.
schema:
  columns:
    - { name: company_id, type: INTEGER }
    - { name: parent_id, type: INTEGER }
    - { name: name, type: VARCHAR }
`,
      'utf8'
    );
  });

  afterEach(async () => {
    await harness.teardown();
  });

  const writeModel = async (name: string, body: string): Promise<void> => {
    await writeFile(join(harness.projectDir, 'models', `${name}.yml`), body, 'utf8');
  };

  const rows = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    const query = harness.runner.query;
    if (!query) throw new Error('DuckDB harness runner has no query support');
    return (await query(sql)) as Array<Record<string, unknown>>;
  };

  it('walks a tree from its roots with depth and path', async () => {
    await writeModel(
      'company_tree',
      `spec_version: '0.2'
name: company_tree
type: model
description: Hierarchy walked from ultimate parents.
grain: company_id
source:
  ref: ${harness.handle}.companies
columns:
  - { name: company_id, expr: company_id }
  - { name: company_name, expr: name }
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 20
  seed: roots
  emit: { root: root_id, depth: depth, path: id_path }
materialization:
  type: table
`
    );
    await runProjectOnce(harness);

    const result = await rows(
      `SELECT company_id, root_id, depth, id_path FROM "${harness.schema}"."company_tree" ORDER BY company_id`
    );
    expect(result.map((r) => Number(r.company_id))).toEqual([1, 2, 3, 4, 5]);
    expect(result.map((r) => Number(r.depth))).toEqual([0, 1, 1, 2, 3]);
    expect(result.every((r) => Number(r.root_id) === 1)).toBe(true);
    expect(result.at(-1)?.id_path).toBe('/1/2/4/5/');
    // The cycle members are unreachable from any root, and the orphan's parent
    // does not exist, so neither appears in a root-seeded walk.
    expect(result.some((r) => Number(r.company_id) === 50)).toBe(false);
    expect(result.some((r) => Number(r.company_id) === 99)).toBe(false);
  });

  it('finds every member of a rootless cycle when every row seeds a walk', async () => {
    await writeModel(
      'company_cycles',
      `spec_version: '0.2'
name: company_cycles
type: model
description: Cycle audit over the company hierarchy.
grain: company_id
source:
  ref: ${harness.handle}.companies
columns:
  - { name: company_id, expr: company_id }
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 20
  seed: all_nodes
  emit: { path: id_path, cycle: is_cycle }
materialization:
  type: table
`
    );
    await runProjectOnce(harness);

    const flagged = await rows(
      `SELECT DISTINCT company_id FROM "${harness.schema}"."company_cycles" WHERE is_cycle ORDER BY company_id`
    );
    expect(flagged.map((r) => Number(r.company_id))).toEqual([50, 51, 52]);
  });

  it('executes when materialized as a view, where the CTE sits inside the DDL', async () => {
    await writeModel(
      'company_tree_view',
      `spec_version: '0.2'
name: company_tree_view
type: model
description: Hierarchy as a view.
grain: company_id
source:
  ref: ${harness.handle}.companies
columns:
  - { name: company_id, expr: company_id }
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 20
  seed: roots
  emit: { depth: depth }
materialization:
  type: view
`
    );
    await runProjectOnce(harness);

    const result = await rows(
      `SELECT company_id FROM "${harness.schema}"."company_tree_view" ORDER BY company_id`
    );
    expect(result.map((r) => Number(r.company_id))).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops at the declared depth instead of running away', async () => {
    await writeModel(
      'company_shallow',
      `spec_version: '0.2'
name: company_shallow
type: model
description: Hierarchy truncated at two levels.
grain: company_id
source:
  ref: ${harness.handle}.companies
columns:
  - { name: company_id, expr: company_id }
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 2
  seed: roots
  emit: { depth: depth }
materialization:
  type: table
`
    );
    await runProjectOnce(harness);

    const depths = await rows(
      `SELECT DISTINCT depth FROM "${harness.schema}"."company_shallow" ORDER BY depth`
    );
    expect(depths.map((r) => Number(r.depth))).toEqual([0, 1, 2]);
  });
});
