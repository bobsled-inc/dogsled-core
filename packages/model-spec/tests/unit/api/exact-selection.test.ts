/**
 * End-to-end exact-selection + selection-scoped full-refresh.
 *
 * `runProject` resolves its `models` through the shared dbt-style selector:
 *   - a bare name runs EXACTLY that model (the intentional dbt-parity breaking
 *     change — was: the model + its whole upstream closure);
 *   - `+X` opts back into the upstream closure.
 *
 * `--full-refresh` is scoped to the resolved selection, so a selected run no
 * longer wipes the run-state of models outside the selection.
 *
 * The runner is mocked so we assert which models the plan executed (and which
 * state entries survive), not real warehouse behavior.
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

/** Project with a model-on-model edge: fct_orders (table) ← stg_orders (view). */
async function writeProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'exact-'));
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
tags:
  - gold
source:
  ref: stg_orders
columns:
  - { name: order_id, expr: stg_orders.order_id, type: integer, primary_key: true }
  - { name: amount, expr: stg_orders.amount, type: number }
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

function executedModels(result: Awaited<ReturnType<typeof runProject>>): string[] {
  return result.byIntegration
    .flatMap((group) => group.executionResults ?? [])
    .map((entry) => entry.modelName)
    .sort();
}

describe('runProject — exact selection', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exact-selection-'));
  });
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('runs EXACTLY the named model — not its upstream closure', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders'],
      state: { models: {} },
      customRunners,
    });
    expect(result.ok).toBe(true);
    expect(executedModels(result)).toEqual(['fct_orders']);
  });

  it('runs the model + upstream when the selector opts in with `+X`', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['+fct_orders'],
      state: { models: {} },
      customRunners,
    });
    expect(result.ok).toBe(true);
    expect(executedModels(result)).toEqual(['fct_orders', 'stg_orders']);
  });

  it('runs all models when no selection is given', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });
    expect(executedModels(result)).toEqual(['fct_orders', 'stg_orders']);
  });

  // Proves the loader-built SelectableNode (node.parsedSpec.tags / node.refs)
  // flows through runProject -> selectIntegrationContexts -> resolveSelection,
  // which the pure selection.test.ts cannot catch.
  it('resolves a tag: selector through the runProject seam', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['tag:gold'], // only fct_orders carries tag `gold`
      state: { models: {} },
      customRunners,
    });
    expect(executedModels(result)).toEqual(['fct_orders']);
  });

  it('resolves an X+ descendants selector through the runProject seam', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['stg_orders+'], // stg_orders + its descendant fct_orders
      state: { models: {} },
      customRunners,
    });
    expect(executedModels(result)).toEqual(['fct_orders', 'stg_orders']);
  });

  it('unions multiple selectors and de-duplicates', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();
    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['+fct_orders', 'stg_orders'], // {stg,fct} ∪ {stg} = {stg,fct}
      state: { models: {} },
      customRunners,
    });
    expect(executedModels(result)).toEqual(['fct_orders', 'stg_orders']);
  });
});

describe('runProject — selection-scoped --full-refresh', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-fr-'));
  });
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('preserves run-state for models outside the selection', async () => {
    const projectDir = await writeProject();
    const { customRunners } = makeMockRunner();

    // Prior state: stg_orders (NOT selected below) plus a stale, project-absent
    // entry. Under the old wholesale wipe both would vanish.
    const priorStg = {
      lastRunAt: '2020-01-01T00:00:00.000Z',
      materialization: 'view',
      specChecksum: 'stg-checksum',
      selectSignature: 'stg-sig',
      columns: [],
    };
    const priorArchived = {
      lastRunAt: '2019-06-01T00:00:00.000Z',
      materialization: 'table',
      specChecksum: 'archived-checksum',
      selectSignature: 'archived-sig',
      columns: [],
    };
    const priorState: RunState = {
      models: {
        'duckdb.stg_orders': priorStg,
        'duckdb.archived_model': priorArchived,
      },
    };

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders'],
      fullRefresh: true,
      state: priorState,
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(executedModels(result)).toEqual(['fct_orders']);
    // The selected model is (re)built and gets a fresh state entry...
    expect(result.state.models['duckdb.fct_orders']).toBeDefined();
    // ...while every NON-selected entry survives the full-refresh untouched.
    expect(result.state.models['duckdb.stg_orders']).toEqual(priorStg);
    expect(result.state.models['duckdb.archived_model']).toEqual(priorArchived);
  });

  // Regression: dropping the wholesale state-wipe must NOT make --full-refresh
  // hard-fail on a materialization-type change. The prior object is dropped and
  // recreated rather than returning exit 3 (a dead end, since the fail message's
  // own remediation is --full-refresh).
  it('rebuilds (drop + recreate) a model whose prior materialization type differs, instead of failing', async () => {
    const projectDir = await writeProject();
    const { customRunners, run } = makeMockRunner();

    // fct_orders is authored `table`; its prior run-state says `snapshot` — an
    // incompatible (non view/table) transition that hard-fails without
    // --full-refresh.
    const priorState: RunState = {
      models: {
        'duckdb.fct_orders': {
          lastRunAt: '2020-01-01T00:00:00.000Z',
          materialization: 'snapshot',
          specChecksum: 'old',
          selectSignature: 'old-sig',
          columns: [],
        },
      },
    };

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      models: ['fct_orders'],
      fullRefresh: true,
      state: priorState,
      customRunners,
    });

    expect(result.ok).toBe(true);
    // The rebuild emits a DROP + a CREATE for fct_orders (two statements, hence
    // two execution rows) — and nothing else.
    expect([...new Set(executedModels(result))]).toEqual(['fct_orders']);
    // The forced rebuild dropped the incompatible prior object first.
    const allSql = run.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allSql).toMatch(/DROP TABLE IF EXISTS/i);
    // ...and emitted no spurious "config drift" warning for the rebuild.
    expect(result.warnings.some((w) => w.includes('config drift'))).toBe(false);
  });
});
