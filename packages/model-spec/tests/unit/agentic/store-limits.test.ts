import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import {
  AGENTIC_MAX_BYTES,
  AGENTIC_MAX_ROWS,
  applyAgenticCheckpoint,
  boundedAgenticRows,
  createDefaultAgenticStateStore,
  createDuckDbCheckpointStore,
  createLocalAgenticStateStore,
  createWarehouseRowStore,
  executeAgenticRun,
  type AgenticStateStore,
} from '../../../src/agentic/index.js';
import {
  AGENTIC_DEFAULT_STORE_LIMITS,
  AGENTIC_MAX_STORE_LIMITS,
  AGENTIC_ROW_STORE_LIMITS,
  agenticCheckpointLimits,
  agenticCheckpointValues,
  resolveAgenticStoreLimits,
} from '../../../src/agentic/store-limits.js';
import { applyAgenticCheckpointWithin } from '../../../src/agentic/checkpoint-verified.js';
import { checkpointIntegrations } from '../../support/checkpoint-transport.js';
import { sealedScenario } from '../../support/agentic-store-scenario.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

const directories: string[] = [];
const project = () => {
  const directory = mkdtempSync(join(tmpdir(), 'store-limits-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function limited(limits: Partial<typeof AGENTIC_DEFAULT_STORE_LIMITS>): AgenticStateStore {
  const store = new MemoryStateStore();
  return {
    limits: { ...AGENTIC_DEFAULT_STORE_LIMITS, ...limits },
    acquire: (key) => store.acquire(key),
  };
}

describe('declared store limits', () => {
  it('keeps the historic limits for a store that declares nothing', () => {
    expect(resolveAgenticStoreLimits(new MemoryStateStore())).toEqual({
      maxRows: 1000,
      maxBatchBytes: 1_048_576,
      maxCheckpointBytes: 16 * 1024 * 1024,
    });
  });

  it('keeps the file store at its limits', () => {
    expect(resolveAgenticStoreLimits(createLocalAgenticStateStore(project()))).toEqual(
      AGENTIC_DEFAULT_STORE_LIMITS
    );
  });

  it.each([
    ['above the ceiling', { maxRows: AGENTIC_MAX_ROWS + 1 }],
    ['above the batch ceiling', { maxBatchBytes: AGENTIC_MAX_BYTES + 1 }],
    ['above the checkpoint ceiling', { maxCheckpointBytes: 16 * 1024 * 1024 + 1 }],
    ['zero', { maxRows: 0 }],
    ['fractional', { maxBatchBytes: 1.5 }],
  ])('rejects a declaration %s', (_, limits) => {
    expect(() => resolveAgenticStoreLimits(limited(limits))).toThrow(
      expect.objectContaining({ code: 'limit', reason: 'invalid_store_limits' })
    );
  });

  it('tells the host what the store accepts', async () => {
    const f = runFixture(2);
    const prepare = vi.spyOn(f.host, 'prepare');
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: project(),
      stateStore: limited({ maxRows: 7, maxBatchBytes: 4096 }),
      run: { id: 'run', mode: 'start' },
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ maxRows: 7, maxBytes: 4096 }));
  });

  it('bounds input by the declared row limit', async () => {
    const f = runFixture(3);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: project(),
        stateStore: limited({ maxRows: 2 }),
        run: { id: 'run', mode: 'start' },
      })
    ).rejects.toMatchObject({ code: 'limit', reason: 'too_many_rows' });
  });

  it('bounds input by the declared byte limit', async () => {
    const f = runFixture(3);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: project(),
        stateStore: limited({ maxBatchBytes: 16 }),
        run: { id: 'run', mode: 'start' },
      })
    ).rejects.toMatchObject({ code: 'limit', reason: 'batch_too_large' });
  });

  it('bounds plan input by the declared limit', async () => {
    const f = runFixture(3);
    f.model.plan.steps.push({
      id: 'review',
      source: { ref: f.model.plan.steps[0]!.id },
      reduce: { over: f.model.plan.steps[0]!.id, group_by: ['pair_id'] },
      execution: { mode: 'llm_call' },
      instructions: 'Review.',
      columns: f.model.plan.steps[0]!.columns,
    });
    f.model.output.from = 'review';
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: project(),
        stateStore: limited({ maxRows: 2 }),
        run: { id: 'run', mode: 'start' },
      })
    ).rejects.toMatchObject({ code: 'limit', reason: 'too_many_rows' });
  });

  it('applies an unchanged default to direct callers', () => {
    expect(() =>
      boundedAgenticRows(
        Array.from({ length: AGENTIC_MAX_ROWS + 1 }, () => ({})),
        'Rows'
      )
    ).toThrow(expect.objectContaining({ reason: 'too_many_rows' }));
  });
});

const duckDbAvailable = await isDuckDbAvailable();

describe('limits the row store declares', () => {
  const warehouse = (engine: string) =>
    createWarehouseRowStore(checkpointIntegrations.find((item) => item.source_type === engine)!, {
      schema: 'checkpoints',
    });

  it('raises them on DuckDB and PostgreSQL only, and keeps the file store at the defaults', () => {
    const duckdb = createDuckDbCheckpointStore(
      {
        spec_version: '1',
        type: 'integration',
        name: 'checkpoints',
        source_type: 'duckdb',
        connection: {},
        auth: { type: 'file', path: join(project(), 'checkpoints.duckdb'), read_only: false },
      },
      { schema: 'agentic_checkpoints' }
    );
    expect(resolveAgenticStoreLimits(duckdb)).toBe(AGENTIC_ROW_STORE_LIMITS);
    expect(resolveAgenticStoreLimits(warehouse('postgres'))).toBe(AGENTIC_ROW_STORE_LIMITS);
    expect(resolveAgenticStoreLimits(warehouse('snowflake'))).toEqual(AGENTIC_DEFAULT_STORE_LIMITS);
    expect(resolveAgenticStoreLimits(createLocalAgenticStateStore(project()))).toEqual(
      AGENTIC_DEFAULT_STORE_LIMITS
    );
    // The default store declares what its file-store runs hold; its DuckDB runs say more.
    expect(resolveAgenticStoreLimits(createDefaultAgenticStateStore(project()))).toEqual(
      AGENTIC_DEFAULT_STORE_LIMITS
    );
    expect(AGENTIC_ROW_STORE_LIMITS).toEqual({
      maxRows: 10_000,
      maxBatchBytes: 16 * 1024 * 1024,
      maxCheckpointBytes: 128 * 1024 * 1024,
    });
    expect(AGENTIC_MAX_STORE_LIMITS).toBe(AGENTIC_ROW_STORE_LIMITS);
  });

  it('lets only the row store go past the defaults', () => {
    expect(resolveAgenticStoreLimits({ limits: AGENTIC_ROW_STORE_LIMITS })).toBe(
      AGENTIC_ROW_STORE_LIMITS
    );
    // A wrapper that passes a row store's declaration on keeps it; a copy is a declaration of its own.
    expect(() => resolveAgenticStoreLimits({ limits: { ...AGENTIC_ROW_STORE_LIMITS } })).toThrow(
      expect.objectContaining({ code: 'limit', reason: 'invalid_store_limits' })
    );
  });

  it('keeps 262,144 values for 16 MiB and scales the count with the bytes', () => {
    expect(agenticCheckpointValues(AGENTIC_DEFAULT_STORE_LIMITS)).toBe(262_144);
    expect(agenticCheckpointValues(AGENTIC_ROW_STORE_LIMITS)).toBe(2_097_152);
  });

  it('checks a supplied store that declares less at the defaults it may hold', () => {
    expect(
      agenticCheckpointLimits({ maxRows: 7, maxBatchBytes: 4096, maxCheckpointBytes: 1 })
    ).toEqual(AGENTIC_DEFAULT_STORE_LIMITS);
    expect(agenticCheckpointLimits(AGENTIC_ROW_STORE_LIMITS)).toEqual(AGENTIC_ROW_STORE_LIMITS);
  });

  it('holds a run that applyAgenticCheckpoint refuses at the defaults', async () => {
    const { initial, over } = await sealedScenario(AGENTIC_MAX_ROWS);
    // A supplied store's transition keeps today's bounds, and says so with a limit error.
    expect(() => applyAgenticCheckpoint(initial, over)).toThrow(
      expect.objectContaining({ code: 'limit', reason: 'too_many_rows' })
    );
    const sealed = applyAgenticCheckpointWithin(
      initial,
      over,
      Date.now(),
      AGENTIC_ROW_STORE_LIMITS
    );
    expect(sealed.work).toHaveLength(AGENTIC_MAX_ROWS + 1);
  }, 60_000);

  it.skipIf(!duckDbAvailable)(
    'runs past the defaults on a DuckDB run file, and the file store refuses the same input',
    async () => {
      const rows = AGENTIC_MAX_ROWS + 200;
      const f = runFixture(rows);
      f.model.limits = {};
      const result = await executeAgenticRun(f.host, f.context(), {
        projectDirectory: project(),
        run: { id: 'wide', mode: 'start' },
      });
      expect(result.processedKeys).toHaveLength(rows);
      const prepare = vi.spyOn(f.host, 'prepare');
      await expect(
        executeAgenticRun(f.host, f.context(), {
          projectDirectory: project(),
          stateStore: createLocalAgenticStateStore(project()),
          run: { id: 'wide', mode: 'start' },
        })
      ).rejects.toMatchObject({ code: 'limit', reason: 'too_many_rows' });
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ maxRows: AGENTIC_MAX_ROWS }));
    },
    120_000
  );

  it.skipIf(!duckDbAvailable)(
    'refuses a group too large for one assignment before any model call',
    async () => {
      const f = runFixture(AGENTIC_MAX_ROWS + 1);
      f.model.limits = {};
      const first = f.model.plan.steps[0]! as Extract<
        (typeof f.model.plan.steps)[number],
        { map: unknown }
      >;
      first.map.group_by = ['batch'];
      first.columns = [
        { name: 'pair_id', type: 'string', nullable: false },
        { name: 'batch', type: 'string', nullable: false },
        { name: 'assessment', type: 'string', nullable: false },
      ];
      f.host.inputs.undecided_pairs = [
        { name: 'pair_id', type: 'string', nullable: false },
        { name: 'batch', type: 'string', nullable: false },
      ];
      f.host.prepare = async () =>
        Array.from({ length: AGENTIC_MAX_ROWS + 1 }, (_, index) => ({
          pair_id: `p${index}`,
          batch: 'one',
        }));
      f.model.plan.steps.push({
        id: 'review',
        source: { ref: first.id },
        reduce: { over: first.id, group_by: ['pair_id'] },
        execution: { mode: 'llm_call' },
        instructions: 'Review.',
        columns: first.columns,
      });
      f.model.output.from = 'review';
      const calls = vi.spyOn(f.host, 'executeAgent');
      await expect(
        executeAgenticRun(f.host, f.context(), {
          projectDirectory: project(),
          run: { id: 'grouped', mode: 'start' },
        })
      ).rejects.toMatchObject({ code: 'limit', reason: 'group_too_large' });
      expect(calls).not.toHaveBeenCalled();
    },
    120_000
  );
});
