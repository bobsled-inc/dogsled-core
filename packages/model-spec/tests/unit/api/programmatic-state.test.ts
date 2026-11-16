/**
 * Programmatic run-state I/O on `runProject`.
 *
 * When the caller supplies `opts.state`, Dogsled must:
 *   - skip reading `.bobsled/model-spec/run-state.json` entirely (even when present);
 *   - skip writing `.bobsled/model-spec/run-state.json` entirely;
 *   - return the post-run state on `result.state` for the orchestrator to persist.
 *
 * Stateless orchestrators (host application) extract a bundle into a tempdir on
 * every invocation, so any filesystem coupling makes every run look like a
 * first run. These tests pin the contract that `opts.state` is the single
 * source of truth in programmatic mode.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
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

/**
 * Minimal single-integration DuckDB project with one view model. The runner is
 * mocked so tests don't depend on a real DuckDB native binding being loaded
 * inside Vitest — we only care about state read/write side-effects.
 */
async function writeMinimalProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'prog-state-'));
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
  return projectDir;
}

function makeMockRunner() {
  const run = vi.fn(async () => ({ rowCount: 0 }));
  const close = vi.fn(async () => {});
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('duckdb', 'file', async () => ({ run, close }));
  return { customRunners, run, close };
}

describe('runProject — programmatic state I/O', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-prog-state-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it.each(['programmatic', 'disk'])(
    'rejects unscoped legacy state keys from %s without SQL or migration',
    async (mode) => {
      const projectDir = await writeMinimalProject();
      const { customRunners, run } = makeMockRunner();
      const state: RunState = {
        models: {
          stg_orders: {
            lastRunAt: '2026-01-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'legacy',
          },
        },
      };
      if (mode === 'disk') {
        await writeFile(
          path.join(projectDir, '.bobsled/model-spec/run-state.json'),
          JSON.stringify(state)
        );
      }
      await expect(
        runProject(projectDir, {
          integration: 'duckdb',
          customRunners,
          ...(mode === 'programmatic' ? { state } : {}),
        })
      ).rejects.toThrow('Run state keys must be scoped to an integration');
      expect(run).not.toHaveBeenCalled();
      expect(state.models.stg_orders).toBeDefined();
      expect(state.models['duckdb.stg_orders']).toBeUndefined();
    }
  );

  it('returns the new state on result.state and skips writing .bobsled/model-spec/run-state.json when state is supplied', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, run } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalled();
    expect(result.state.models['duckdb.stg_orders']).toBeDefined();
    expect(result.state.models['duckdb.stg_orders']?.materialization).toBe('view');

    // Critical: the orchestrator owns persistence. Dogsled must not have written
    // the file behind the caller's back.
    expect(fsSync.existsSync(path.join(projectDir, '.bobsled/model-spec', 'run-state.json'))).toBe(
      false
    );
  });

  it('ignores a stale on-disk run-state.json when state is supplied programmatically', async () => {
    // Spec scenario 6: the tempdir may contain a stale .bobsled/model-spec/run-state.json
    // from a different project. Dogsled must not read it.
    const projectDir = await writeMinimalProject();
    await writeFile(
      path.join(projectDir, '.bobsled/model-spec', 'run-state.json'),
      JSON.stringify({
        models: {
          'duckdb.some_unrelated_model': {
            lastRunAt: '2020-01-01T00:00:00.000Z',
            materialization: 'table',
            specChecksum: 'STALE',
          },
        },
      })
    );

    const { customRunners } = makeMockRunner();
    const priorState: RunState = { models: {} };
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: priorState,
      customRunners,
    });

    expect(result.ok).toBe(true);
    // The stale entry must not appear in the post-run state — Dogsled read from
    // `priorState`, not from disk.
    expect(result.state.models['duckdb.some_unrelated_model']).toBeUndefined();
    expect(result.state.models['duckdb.stg_orders']).toBeDefined();
  });

  it('uses supplied prior state on the second run (no first-run rebuild)', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners: r1, run: run1 } = makeMockRunner();

    const first = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners: r1,
    });
    expect(first.ok).toBe(true);

    // Hand the post-run state back into a second invocation, simulating the
    // orchestrator's persist-and-reload cycle through its own database.
    const roundTripped: RunState = JSON.parse(JSON.stringify(first.state));

    const { customRunners: r2, run: run2 } = makeMockRunner();
    const second = await runProject(projectDir, {
      integration: 'duckdb',
      state: roundTripped,
      customRunners: r2,
    });

    expect(second.ok).toBe(true);
    expect(second.state.models['duckdb.stg_orders']?.lastRunAt).toBeDefined();
    expect(run2).toHaveBeenCalled();
    // Still no disk write.
    expect(fsSync.existsSync(path.join(projectDir, '.bobsled/model-spec', 'run-state.json'))).toBe(
      false
    );
    void run1;
  });

  it('fullRefresh + programmatic state still skips disk and returns post-run state', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      fullRefresh: true,
      state: {
        models: {
          'duckdb.stg_orders': {
            lastRunAt: '2020-01-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'ignored-on-full-refresh',
          },
        },
      },
      customRunners,
    });

    expect(result.ok).toBe(true);
    // fullRefresh wins on the read side — but writes still bypass disk.
    expect(fsSync.existsSync(path.join(projectDir, '.bobsled/model-spec', 'run-state.json'))).toBe(
      false
    );
    expect(result.state.models['duckdb.stg_orders']?.lastRunAt).not.toBe(
      '2020-01-01T00:00:00.000Z'
    );
  });

  it('preserves prior-state entries for models not in the current run filter', async () => {
    // Spec §"Edge cases", item 3: "A model in the prior state that isn't in
    // the current run's `models:` filter. Dogsled should preserve the prior
    // entry untouched in the post-run state."
    const projectDir = await writeMinimalProject();
    const { customRunners } = makeMockRunner();

    const untouched = {
      lastRunAt: '2026-01-01T00:00:00.000Z',
      materialization: 'incremental',
      specChecksum: 'untouched-checksum',
      strategy: 'merge',
      uniqueKey: ['order_id'],
      onSchemaChange: 'fail',
      targetSchema: 'analytics',
      priorFqName: '"analytics"."some_other_model"',
    };

    const priorState: RunState = {
      models: {
        // Not part of this project — emulates the orchestrator persisting a
        // union of state across multiple projects/runs. Dogsled must round-
        // trip this entry through to `result.state` even though it's never
        // touched by the current invocation.
        'duckdb.some_other_model': { ...untouched },
        // Also: a model in the same project but excluded from this run via
        // the `models` filter.
        'duckdb.unrelated_in_project': { ...untouched, materialization: 'view' },
      },
    };

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['stg_orders'],
      state: priorState,
      customRunners,
    });

    expect(result.ok).toBe(true);
    // The untouched entries survive verbatim. Deep equality — no field
    // dropped, none added.
    expect(result.state.models['duckdb.some_other_model']).toEqual(untouched);
    expect(result.state.models['duckdb.unrelated_in_project']).toEqual({
      ...untouched,
      materialization: 'view',
    });
    // The model that actually ran has a fresh entry.
    expect(result.state.models['duckdb.stg_orders']).toBeDefined();
    expect(result.state.models['duckdb.stg_orders']?.lastRunAt).not.toBe(untouched.lastRunAt);
  });

  it('falls back to on-disk state when opts.state is absent (no regression)', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners } = makeMockRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      customRunners,
    });

    expect(result.ok).toBe(true);
    // Default behavior: state is persisted to disk.
    expect(fsSync.existsSync(path.join(projectDir, '.bobsled/model-spec', 'run-state.json'))).toBe(
      true
    );
  });
});
