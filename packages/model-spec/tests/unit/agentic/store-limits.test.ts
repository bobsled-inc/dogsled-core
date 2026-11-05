import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTIC_MAX_BYTES,
  AGENTIC_MAX_ROWS,
  boundedAgenticRows,
  createLocalAgenticStateStore,
  executeAgenticRun,
  type AgenticStateStore,
} from '../../../src/agentic/index.js';
import {
  AGENTIC_DEFAULT_STORE_LIMITS,
  resolveAgenticStoreLimits,
} from '../../../src/agentic/store-limits.js';
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
