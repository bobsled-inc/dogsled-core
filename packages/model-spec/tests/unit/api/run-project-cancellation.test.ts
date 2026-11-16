/**
 * `runProject` cancellation contract.
 *
 * Covers the guarantees a programmatic host (the Dogsled lakehouse) relies on:
 * an already-aborted signal never touches the warehouse, an in-flight abort
 * reaches the active runner operation, nothing downstream starts, cancelled work
 * never advances run state, and runners are always closed.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry, SqlCancelledError } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';
import type { SqlExecOptions } from '../../../src/compiler/index.js';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Two chained view models, so the plan has a deterministic two-statement order
 * (`stg_items` then `mart_items`) and "no later statement runs" is observable.
 */
async function writeChainedProject(rootDir: string): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(rootDir, 'cancel-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'lake.yml'),
    `spec_version: '1'
type: integration
name: lake
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: /tmp/cancel-not-opened.duckdb
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_items.yml'),
    `spec_version: '0.2'
name: raw_items
type: source
source_type: warehouse_table
connection: lake
table: raw.items
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: name, type: STRING }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_items.yml'),
    `spec_version: '0.2'
name: stg_items
type: model
description: Staged items.
grain: id
source:
  ref: lake.raw_items
columns:
  - { name: id, expr: id, primary_key: true }
  - { name: name, expr: name }
materialization:
  type: view
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'mart_items.yml'),
    `spec_version: '0.2'
name: mart_items
type: model
description: Downstream mart.
grain: id
source:
  ref: stg_items
columns:
  - { name: id, expr: id, primary_key: true }
  - { name: name, expr: name }
materialization:
  type: view
`
  );
  return projectDir;
}

describe('runProject cancellation', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-model-spec-cancel-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('uses explicit host declarations with the supplied resolver and otherwise fails closed', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const file = path.join(projectDir, 'integrations', 'lake.yml');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(
        '/tmp/cancel-not-opened.duckdb',
        '${{ env.HOST_DATABASE }}'
      )
    );
    const resolve = vi.fn(async () => '/tmp/host-not-opened.duckdb');
    const factory = vi.fn(async () => ({ run: vi.fn(async () => ({ rowCount: 0 })) }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', factory);
    const options = { customRunners, secretResolver: { resolve }, state: { models: {} } };
    const rejected = await runProject(projectDir, options);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain('Undeclared environment variable: HOST_DATABASE');
    expect(resolve).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    const result = await runProject(projectDir, {
      ...options,
      declaredSecretNames: ['HOST_DATABASE'],
    });
    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('HOST_DATABASE');
    expect(factory).toHaveBeenCalled();
    await expect(
      runProject(projectDir, { declaredSecretNames: ['HOST_DATABASE'] })
    ).rejects.toThrow('explicit host secretResolver');
  });

  it('an already-aborted signal returns cancelled without opening a runner', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const factory = vi.fn(async () => ({ run: vi.fn(async () => ({ rowCount: 0 })) }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', factory);

    const controller = new AbortController();
    controller.abort();

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    // No runner was ever constructed, so no warehouse execution began.
    expect(factory).not.toHaveBeenCalled();
    expect(result.state.models).toEqual({});
  });

  it('an abort between runner resolution and the first statement runs no SQL', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const controller = new AbortController();
    const run = vi.fn(async () => ({ rowCount: 0 }));
    const close = vi.fn(async () => {});
    const customRunners = new CustomRunnerRegistry();
    // Abort while resolving the runner: the signal fires after the plan is
    // built and the connection is open, but before any statement is dispatched.
    customRunners.register('duckdb', 'file', async () => {
      controller.abort();
      return { run, close };
    });

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
      signal: controller.signal,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    // Cleanup still happened even though nothing executed.
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.state.models).toEqual({});
  });

  it('an in-flight abort reaches the runner, stops the plan, and commits no state', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const close = vi.fn(async () => {});

    // A runner that behaves like a real driver-backed one: it observes the
    // signal and settles by rejecting with a cancellation error.
    const run = vi.fn(async (sql: string, options?: SqlExecOptions) => {
      seenSignals.push(options?.signal);
      if (!sql.includes('stg_items')) return { rowCount: 0 };
      return new Promise<{ rowCount?: number }>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new SqlCancelledError('driver cancelled the query'))
        );
        setTimeout(() => controller.abort(), 5);
      });
    });

    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, close }));

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);

    // The runner received the caller's signal instance — that is what lets the
    // driver cancel the active operation rather than orphan it.
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);

    const executed = run.mock.calls.map(([sql]) => sql);
    // The downstream model's statement never started.
    expect(executed.some((sql) => sql.includes('mart_items'))).toBe(false);

    const results = result.byIntegration[0]?.executionResults ?? [];
    expect(results.find((r) => r.modelName === 'stg_items')?.status).toBe('cancelled');
    expect(results.find((r) => r.modelName === 'mart_items')?.status).toBe('cancelled');
    // Nothing is reported as a warehouse failure.
    expect(results.some((r) => r.status === 'failed')).toBe(false);

    // No cancelled model advanced run state.
    expect(result.state.models['lake.stg_items']).toBeUndefined();
    expect(result.state.models['lake.mart_items']).toBeUndefined();

    // The runner was closed on the way out.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps state for models that completed before the abort', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const controller = new AbortController();
    const run = vi.fn(async () => ({ rowCount: 0 }));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run }));

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
      signal: controller.signal,
      onSuccess: (message) => {
        // The callback fires only after stg_items completed and passed the
        // post-await abort guard, so its state is legitimately retainable.
        if (message.includes('stg_items')) controller.abort();
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    // A cancel stops further work; it does not roll back finished work.
    expect(result.state.models['lake.stg_items']).toBeDefined();
    expect(result.state.models['lake.mart_items']).toBeUndefined();
  });

  it('reports provisional SQL successes as cancelled when view verification is aborted', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const controller = new AbortController();
    const run = vi.fn(async () => ({ rowCount: 0 }));
    const query = vi.fn(async (_sql: string, _params?: unknown[], options?: SqlExecOptions) => {
      controller.abort();
      options?.signal?.throwIfAborted();
      return [];
    });
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, query }));

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    const executionResults = result.byIntegration[0]?.executionResults ?? [];
    expect(executionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelName: 'stg_items', status: 'cancelled' }),
        expect.objectContaining({ modelName: 'mart_items', status: 'cancelled' }),
      ])
    );
    expect(executionResults.some((item) => item.status === 'success')).toBe(false);
    expect(result.state.models).toEqual({});
  });

  it('does not treat pre-existing state as completion when view verification is aborted', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const controller = new AbortController();
    let abortOnVerification = false;
    const run = vi.fn(async () => ({ rowCount: 0 }));
    const query = vi.fn(async (_sql: string, _params?: unknown[], options?: SqlExecOptions) => {
      if (abortOnVerification) {
        controller.abort();
        options?.signal?.throwIfAborted();
      }
      return [{ table_name: 'x' }];
    });
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, query }));

    const prior = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
    });
    expect(prior.ok).toBe(true);
    const priorStgLastRunAt = prior.state.models['lake.stg_items']?.lastRunAt;
    const priorMartLastRunAt = prior.state.models['lake.mart_items']?.lastRunAt;

    abortOnVerification = true;
    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: prior.state,
      fullRefresh: true,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    const executionResults = result.byIntegration[0]?.executionResults ?? [];
    expect(executionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelName: 'stg_items', status: 'cancelled' }),
        expect.objectContaining({ modelName: 'mart_items', status: 'cancelled' }),
      ])
    );
    expect(executionResults.some((item) => item.status === 'success')).toBe(false);
    // Earlier successful state remains available but was not advanced by the
    // cancelled invocation.
    expect(result.state.models['lake.stg_items']?.lastRunAt).toBe(priorStgLastRunAt);
    expect(result.state.models['lake.mart_items']?.lastRunAt).toBe(priorMartLastRunAt);
  });

  it('behaves exactly as before when no signal is supplied', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    const run = vi.fn(async (_sql: string) => ({ rowCount: 0 }));
    const query = vi.fn(async (_sql: string) => [{ table_name: 'x' }]);
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, query }));

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
    });

    expect(result.cancelled).toBe(false);
    expect(result.ok).toBe(true);
    // Runner calls carry no options argument on the no-signal path.
    for (const call of run.mock.calls) expect(call).toHaveLength(1);
    expect(result.state.models['lake.stg_items']).toBeDefined();
    expect(result.state.models['lake.mart_items']).toBeDefined();
  });

  it('does not begin a published model after cancellation', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    // A published model rooted directly on the lake SOURCE (not on a lake
    // model — that would be a mixed model needing cross-warehouse staging).
    // It is stamped with its destination handle, so it lands in `other`'s plan
    // and is only reached after `lake`'s statements have run.
    await writeFile(
      path.join(projectDir, 'integrations', 'other.yml'),
      `spec_version: '1'
type: integration
name: other
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: /tmp/cancel-other.duckdb
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'pub_items.yml'),
      `spec_version: '0.2'
name: pub_items
type: model
description: Published copy.
grain: id
source:
  ref: lake.raw_items
publish: other
columns:
  - { name: id, expr: id, primary_key: true }
  - { name: name, expr: name }
materialization:
  type: table
`
    );

    const controller = new AbortController();
    const run = vi.fn(async (sql: string) => {
      if (sql.includes('stg_items')) controller.abort();
      return { rowCount: 0 };
    });
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run }));
    const crossWarehousePublisher = vi.fn();

    // No `integration` narrowing: the published node is stamped with its
    // destination handle (`other`), so it only appears in the plan when both
    // integrations are resolved.
    const result = await runProject(projectDir, {
      customRunners,
      state: { models: {} },
      signal: controller.signal,
      crossWarehousePublisher,
    });

    expect(result.cancelled).toBe(true);
    // Publishing moves data into a second warehouse — it must not start.
    expect(crossWarehousePublisher).not.toHaveBeenCalled();
    expect(result.state.models['other.pub_items']).toBeUndefined();
    const other = result.byIntegration.find((integration) => integration.handle === 'other');
    expect(other?.executionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelName: 'pub_items', status: 'cancelled' }),
      ])
    );
  });

  it('does not persist a legacy publisher success that resolves after abort', async () => {
    const projectDir = await writeChainedProject(tmpDir);
    await writeFile(
      path.join(projectDir, 'integrations', 'other.yml'),
      `spec_version: '1'
type: integration
name: other
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: /tmp/cancel-other.duckdb
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'pub_items.yml'),
      `spec_version: '0.2'
name: pub_items
type: model
description: Published copy.
grain: id
source:
  ref: lake.raw_items
publish: other
columns:
  - { name: id, expr: id, primary_key: true }
  - { name: name, expr: name }
materialization:
  type: table
`
    );

    const controller = new AbortController();
    const crossWarehousePublisher = vi.fn(async (_model, context) => {
      expect(context.signal).toBe(controller.signal);
      expect(context.warehouse).toBe('large');
      expect(context.queryTag).toBe('custom:model-run:123');
      controller.abort();
      return {
        executionResult: {
          modelName: 'pub_items',
          status: 'success' as const,
          rowsAffected: 1,
        },
        publishedSnapshotId: 'late-success',
        publishedAt: '2026-07-28T00:00:00.000Z',
      };
    });

    const result = await runProject(projectDir, {
      integration: 'other',
      state: { models: {} },
      signal: controller.signal,
      warehouse: 'large',
      queryTag: 'custom:model-run:123',
      crossWarehousePublisher,
    });

    expect(crossWarehousePublisher).toHaveBeenCalledOnce();
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.byIntegration[0]?.executionResults?.[0]?.status).toBe('cancelled');
    expect(result.state.models['other.pub_items']).toBeUndefined();
  });
});
