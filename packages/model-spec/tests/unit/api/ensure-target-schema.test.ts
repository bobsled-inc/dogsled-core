/**
 * dbt-parity schema bootstrap on the direct (non-published) run path.
 *
 * Before materializing models, `runProject` issues `CREATE SCHEMA IF NOT EXISTS`
 * for every distinct destination schema the plan writes to — matching dbt's
 * `create_schema` hook and `@bobsled-inc/loader`'s `initialize()`/`ensureTable()`.
 *
 * The runner is mocked so we assert the exact SQL Bobsled Core emits (and its order),
 * not real warehouse behavior.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * DuckDB project (schema `main`) with:
 *   - stg_orders (view, default schema)
 *   - fct_orders (table, default schema)
 *   - mart_orders (table, `target_schema: analytics` override)
 */
async function writeProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'ensure-schema-'));
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
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_orders.yml'),
    `spec_version: '0.2'
name: stg_orders
type: model
description: Staging orders.
grain: order_id
source:
  ref: duckdb.raw_orders
columns:
  - { name: order_id, expr: duckdb.raw_orders.order_id, type: integer, primary_key: true }
  - { name: amount, expr: duckdb.raw_orders.amount, type: number }
materialization:
  type: view
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'fct_orders.yml'),
    `spec_version: '0.2'
name: fct_orders
type: model
description: Orders fact.
grain: order_id
source:
  ref: stg_orders
columns:
  - { name: order_id, expr: stg_orders.order_id, type: integer, primary_key: true }
  - { name: amount, expr: stg_orders.amount, type: number }
materialization:
  type: table
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'mart_orders.yml'),
    `spec_version: '0.2'
name: mart_orders
type: model
description: Orders mart in a dedicated schema.
grain: order_id
source:
  ref: fct_orders
target_schema: analytics
columns:
  - { name: order_id, expr: fct_orders.order_id, type: integer, primary_key: true }
  - { name: amount, expr: fct_orders.amount, type: number }
materialization:
  type: table
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

function sqlCalls(run: ReturnType<typeof vi.fn>): string[] {
  return run.mock.calls.map((call) => String(call[0]));
}

describe('runProject — ensures target schemas exist (dbt parity)', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-target-schema-'));
  });
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('issues CREATE SCHEMA IF NOT EXISTS for the default schema before any model DDL', async () => {
    const projectDir = await writeProject();
    const { customRunners, run } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders'], // a single table model in the default `main` schema
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    const calls = sqlCalls(run);
    expect(calls[0]).toBe('CREATE SCHEMA IF NOT EXISTS "main"');
    // Schema creation precedes the model's CREATE TABLE.
    const schemaIdx = calls.findIndex((s) => s.startsWith('CREATE SCHEMA'));
    const tableIdx = calls.findIndex((s) => /CREATE OR REPLACE TABLE/i.test(s));
    expect(schemaIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(schemaIdx);
  });

  it('de-duplicates the schema across multiple models in the same schema', async () => {
    const projectDir = await writeProject();
    const { customRunners, run } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['stg_orders', 'fct_orders'], // both land in `main`
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    const schemaCreates = sqlCalls(run).filter((s) => s.startsWith('CREATE SCHEMA'));
    expect(schemaCreates).toEqual(['CREATE SCHEMA IF NOT EXISTS "main"']);
  });

  it('creates a distinct schema for a per-model target_schema override', async () => {
    const projectDir = await writeProject();
    const { customRunners, run } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders', 'mart_orders'], // main + analytics
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    const schemaCreates = sqlCalls(run)
      .filter((s) => s.startsWith('CREATE SCHEMA'))
      .sort();
    expect(schemaCreates).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "analytics"',
      'CREATE SCHEMA IF NOT EXISTS "main"',
    ]);
  });

  it('tolerates a schema-creation failure (best-effort) and still runs the model', async () => {
    // A role with USAGE-but-not-CREATE on an already-existing schema must not be
    // regressed: the failed CREATE SCHEMA is swallowed and the model DDL — the
    // source of truth — still executes (and would surface a real error if the
    // schema were genuinely missing).
    const projectDir = await writeProject();
    const warnings: string[] = [];
    const run = vi.fn(async (sql: string) => {
      if (sql.startsWith('CREATE SCHEMA')) {
        throw new Error('permission denied for database');
      }
      return { rowCount: 0 };
    });
    const close = vi.fn(async () => {});
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, close }));

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders'],
      state: { models: {} },
      customRunners,
      onWarn: (m) => warnings.push(m),
    });

    // The CREATE SCHEMA failure does not fail the run; the model DDL still runs.
    expect(result.ok).toBe(true);
    expect(sqlCalls(run).some((s) => /CREATE OR REPLACE TABLE/i.test(s))).toBe(true);
    // The best-effort failure surfaces as a warning (live callback + result).
    expect(warnings.some((w) => w.includes('Could not ensure schema exists'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Could not ensure schema exists'))).toBe(true);
    // The runner was still closed cleanly.
    expect(close).toHaveBeenCalledTimes(1);
  });
});
