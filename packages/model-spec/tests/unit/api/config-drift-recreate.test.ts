/**
 * End-to-end coverage for the seven scenarios in the programmatic-state
 * requirements doc. Uses a mock runner so we can inspect the DDL plan
 * (`result.byIntegration[].statements`) without spinning up a real warehouse.
 *
 * Scenarios from the spec:
 *   1. First run — appropriate first-run DDL, snapshot captured.
 *   2. Second run, no changes — `MERGE INTO` honoring `incremental_filter`.
 *   3. Second run, strategy changed — DROP + recreate, new strategy SQL.
 *   4. Second run, target_schema changed — DROP against PRIOR destination.
 *   5. on_schema_change: fail, columns added — existing fail message intact.
 *   6. Stale .bobsled/model-spec/run-state.json present — Dogsled ignores the file.
 *   7. Partial failure + state-write throws — covered in programmatic-state.test.ts.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';
import type { RunState } from '../../../src/compiler/state.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

interface ProjectOptions {
  strategy?: 'merge' | 'delete_insert' | 'append';
  uniqueKey?: string;
  incrementalFilter?: string;
  onSchemaChange?: 'fail' | 'full_refresh';
  targetSchema?: string;
  extraColumns?: Array<{ name: string; expr: string; type: string }>;
}

async function writeIncrementalProject(opts: ProjectOptions = {}): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'drift-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'duckdb.yml'),
    `spec_version: '1'
type: integration
name: duckdb
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'db.duckdb'))}
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_orders.yml'),
    `spec_version: '0.2'
name: raw_orders
type: source
source_type: warehouse_table
connection: duckdb
table: main.raw_orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: amount, type: number }
    - { name: updated_at, type: timestamp }
`
  );

  const strategy = opts.strategy ?? 'merge';
  const uniqueKey = opts.uniqueKey ?? 'order_id';
  const incrementalFilter =
    opts.incrementalFilter ?? 'updated_at > (SELECT MAX(updated_at) FROM self)';
  const onSchemaChange = opts.onSchemaChange ?? 'fail';
  const extras = (opts.extraColumns ?? [])
    .map((c) => `  - { name: ${c.name}, expr: ${c.expr}, type: ${c.type} }`)
    .join('\n');

  const targetSchemaLine = opts.targetSchema ? `target_schema: ${opts.targetSchema}\n` : '';

  await writeFile(
    path.join(projectDir, 'models', 'fct_orders.yml'),
    `spec_version: '0.2'
name: fct_orders
type: model
description: Incremental orders.
grain: order_id
source:
  ref: duckdb.raw_orders
columns:
  - { name: order_id, expr: duckdb.raw_orders.order_id, type: integer, primary_key: true }
  - { name: amount, expr: duckdb.raw_orders.amount, type: number }
  - { name: updated_at, expr: duckdb.raw_orders.updated_at, type: timestamp }
${extras}
${targetSchemaLine}materialization:
  type: incremental
  strategy: ${strategy}
  unique_key: ${uniqueKey}
  incremental_filter: '${incrementalFilter}'
  on_schema_change: ${onSchemaChange}
`
  );
  return projectDir;
}

function makeMockRunner() {
  const run = vi.fn(async () => ({ rowCount: 0 }));
  const close = vi.fn(async () => {});
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('duckdb', 'file', async () => ({ run, close }));
  return { customRunners, run, close };
}

describe('runProject — materialization config drift detection', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drift-recreate-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('scenario 1: first run emits CREATE OR REPLACE TABLE and persists a config snapshot', async () => {
    const projectDir = await writeIncrementalProject();
    const { customRunners } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    const sql = result.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    expect(sql).toContain('CREATE OR REPLACE TABLE');
    expect(sql).not.toContain('MERGE INTO');

    const entry = result.state.models['duckdb.fct_orders'];
    expect(entry?.strategy).toBe('merge');
    expect(entry?.uniqueKey).toEqual(['order_id']);
    expect(entry?.incrementalFilter).toBe('updated_at > (SELECT MAX(updated_at) FROM self)');
    expect(entry?.onSchemaChange).toBe('fail');
    expect(entry?.targetSchema).toBe('main');
    expect(entry?.priorFqName).toBeDefined();
  });

  it('scenario 2: second run with no changes emits MERGE INTO and updates lastRunAt', async () => {
    const projectDir = await writeIncrementalProject();

    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });

    const { customRunners: r2 } = makeMockRunner();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
    });

    expect(second.ok).toBe(true);
    const sql = second.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    expect(sql).toContain('MERGE INTO');
    // incremental_filter passes through to the SELECT WHERE clause.
    expect(sql.toLowerCase()).toContain('updated_at >');
    // Use >= rather than strict inequality — both runs can land in the same
    // millisecond on a fast machine, and the contract we care about is
    // monotonicity, not "the string changed."
    const firstAt = Date.parse(first.state.models['duckdb.fct_orders']?.lastRunAt ?? '');
    const secondAt = Date.parse(second.state.models['duckdb.fct_orders']?.lastRunAt ?? '');
    expect(Number.isNaN(firstAt)).toBe(false);
    expect(Number.isNaN(secondAt)).toBe(false);
    expect(secondAt).toBeGreaterThanOrEqual(firstAt);
  });

  it('scenario 3: strategy change (merge → delete_insert) emits DROP + delete_insert DDL', async () => {
    const projectDir = await writeIncrementalProject({ strategy: 'merge' });
    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });

    // Rewrite the model YAML with the new strategy.
    await fs.rm(path.join(projectDir, 'models', 'fct_orders.yml'));
    const projectDir2 = await writeIncrementalProject({ strategy: 'delete_insert' });
    // Replace fct_orders.yml in the original projectDir
    await fs.copyFile(
      path.join(projectDir2, 'models', 'fct_orders.yml'),
      path.join(projectDir, 'models', 'fct_orders.yml')
    );

    const { customRunners: r2 } = makeMockRunner();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
    });

    expect(second.ok).toBe(true);
    const sql = second.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    // DROP precedes the recreate.
    expect(sql).toContain('DROP TABLE IF EXISTS');
    // First-run DDL emitted (delete_insert uses table create on first run too).
    expect(sql).toContain('CREATE OR REPLACE TABLE');
    expect(sql).not.toContain('MERGE INTO');

    // The recreate comment includes the diff.
    expect(sql).toContain('strategy merge -> delete_insert');
  });

  it('scenario 4: target_schema change drops the PRIOR destination, not the new one', async () => {
    const projectDir = await writeIncrementalProject({ targetSchema: 'old_schema' });
    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });
    const priorFqName = first.state.models['duckdb.fct_orders']?.priorFqName;
    expect(priorFqName).toContain('old_schema');

    // Move to a new schema.
    await fs.rm(path.join(projectDir, 'models', 'fct_orders.yml'));
    const tmpForNewSchema = await writeIncrementalProject({ targetSchema: 'new_schema' });
    await fs.copyFile(
      path.join(tmpForNewSchema, 'models', 'fct_orders.yml'),
      path.join(projectDir, 'models', 'fct_orders.yml')
    );

    const { customRunners: r2 } = makeMockRunner();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
    });

    expect(second.ok).toBe(true);
    const sql = second.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    // Critical: DROP must target the OLD schema, not the new one.
    expect(sql).toContain('DROP TABLE IF EXISTS');
    expect(sql).toContain('old_schema');
    // Post-run state now points at the new destination.
    expect(second.state.models['duckdb.fct_orders']?.targetSchema).toBe('new_schema');
    expect(second.state.models['duckdb.fct_orders']?.priorFqName).toContain('new_schema');
  });

  it('scenario 5: on_schema_change: fail with new columns surfaces the existing fail message', async () => {
    const projectDir = await writeIncrementalProject({ onSchemaChange: 'fail' });
    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });

    // Add an extra column to the model.
    await fs.rm(path.join(projectDir, 'models', 'fct_orders.yml'));
    const tmpWithExtra = await writeIncrementalProject({
      onSchemaChange: 'fail',
      extraColumns: [{ name: 'new_col', expr: 'duckdb.raw_orders.amount', type: 'number' }],
    });
    await fs.copyFile(
      path.join(tmpWithExtra, 'models', 'fct_orders.yml'),
      path.join(projectDir, 'models', 'fct_orders.yml')
    );

    const { customRunners: r2 } = makeMockRunner();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
    });

    expect(second.ok).toBe(false);
    const failures = second.byIntegration[0]?.executionResults?.filter(
      (r) => r.status === 'failed'
    );
    expect(failures && failures.length).toBeGreaterThan(0);
    // Spec §"How we'll verify": surface should be the existing `fail` message,
    // including the rebuild remediation.
    expect(failures?.[0]?.error).toMatch(/Schema drift detected/);
    expect(failures?.[0]?.error).toMatch(/--full-refresh/);
  });

  it('does not spuriously recreate when prior state lacks the new config fields (upgrade path)', async () => {
    // Spec §3: "A model that has prior state from a previous Dogsled version
    // (i.e. lacks the newly-tracked config fields) must NOT trigger a
    // spurious recreate on its first run under the new Dogsled version."
    const projectDir = await writeIncrementalProject();

    // Hand-build an "old format" prior state — schemaVersion lacking the new
    // fields. The reader's zod schema accepts this (all new fields optional).
    const olderPriorState: RunState = {
      models: {
        'duckdb.fct_orders': {
          lastRunAt: '2026-01-01T00:00:00.000Z',
          materialization: 'incremental',
          specChecksum: 'old-checksum-from-prior-version',
          // No strategy / uniqueKey / incrementalFilter / onSchemaChange /
          // targetSchema / priorFqName — older Dogsled didn't write them.
        },
      },
    };

    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: olderPriorState,
      customRunners,
    });

    expect(result.ok).toBe(true);
    const sql = result.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    // No DROP — Dogsled must proceed as an incremental MERGE against the
    // existing table even though it can't verify all config matched, because
    // "don't know" must not equal "rebuild and lose data."
    expect(sql).not.toContain('DROP TABLE IF EXISTS');
    expect(sql).toContain('MERGE INTO');
  });

  it('fires onWarn and pushes result.warnings when a drift recreate is planned', async () => {
    // Observability: the host application's dev pipeline streams `onWarn` into its
    // LangSmith run log, and post-hoc callers read `result.warnings`. Both
    // need to see *which* field drifted so we can debug an unexpected
    // recreate without grepping warehouse logs. Mirrors the existing
    // schema-drift full-refresh warning idiom.
    const projectDir = await writeIncrementalProject({ strategy: 'merge' });
    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });

    // Flip strategy in the spec — guarantees a drift recreate on the
    // second invocation.
    await fs.rm(path.join(projectDir, 'models', 'fct_orders.yml'));
    const tmpWithDeleteInsert = await writeIncrementalProject({ strategy: 'delete_insert' });
    await fs.copyFile(
      path.join(tmpWithDeleteInsert, 'models', 'fct_orders.yml'),
      path.join(projectDir, 'models', 'fct_orders.yml')
    );

    const { customRunners: r2 } = makeMockRunner();
    const warnSpy = vi.fn();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
      onWarn: warnSpy,
    });

    expect(second.ok).toBe(true);

    // Streaming signal — `onWarn` callback receives the formatted message.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[duckdb] fct_orders: config drift —')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('strategy merge -> delete_insert')
    );

    // Structured signal — `result.warnings` carries the same message for
    // non-streaming consumers (e.g. JSON output mode).
    const warningStr = second.warnings.join('\n');
    expect(warningStr).toContain('config drift —');
    expect(warningStr).toContain('strategy merge -> delete_insert');
  });

  it('does not fire false-positive drift on a <ref>.<col> incremental_filter across runs', async () => {
    // Regression for Bug C (AI-app dev pipeline, 2026-05-27):
    // persisting the alias-substituted form of `incremental_filter`
    // made any second run of a model whose filter referenced a join
    // alias (e.g. `stg_customers.signup_date`) fire `incremental_filter
    // changed` and take the first-run / full-refresh path on every
    // invocation. Filter referenced the source ref directly here — same
    // pattern as `customer_summary` in the host application — so the state writer
    // would have previously persisted `t0.signup_date > self` while the
    // parser on re-run produced the same string. The bug only manifested
    // when comparing across canary versions, but the fix is to persist
    // the authored form so the invariant holds even on the same version
    // across structural changes.
    const projectDir = await writeIncrementalProject({
      incrementalFilter: 'duckdb.raw_orders.updated_at > (SELECT MAX(updated_at) FROM self)',
    });
    const { customRunners: r1 } = makeMockRunner();
    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });
    expect(first.ok).toBe(true);

    // The persisted authored form is the unrewritten YAML, *not* the
    // alias-resolved `t0.updated_at` that codegen emits.
    const persistedFilter = first.state.models['duckdb.fct_orders']?.incrementalFilter ?? '';
    expect(persistedFilter).toContain('duckdb.raw_orders.updated_at');
    expect(persistedFilter).not.toMatch(/\bt0\./);

    // Re-run with the same YAML + persisted state. No drift, no
    // recreate, no warning.
    const { customRunners: r2 } = makeMockRunner();
    const warnSpy = vi.fn();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: JSON.parse(JSON.stringify(first.state)),
      customRunners: r2,
      onWarn: warnSpy,
    });
    expect(second.ok).toBe(true);

    // No config-drift warning on the callback or in result.warnings.
    const seenWarn = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(seenWarn).not.toMatch(/config drift —/);
    expect(second.warnings.join('\n')).not.toMatch(/config drift —/);

    // And the SQL plan reflects the incremental path, not a recreate.
    const sql = second.byIntegration[0]?.statements.map((s) => s.sql).join('\n') ?? '';
    expect(sql).toContain('MERGE INTO');
    expect(sql).not.toContain('DROP TABLE IF EXISTS');
  });
});
