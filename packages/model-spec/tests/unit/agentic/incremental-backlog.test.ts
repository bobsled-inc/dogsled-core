import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  createLocalAgenticCursorStore,
  type AgenticPublisher,
  type AgenticProbeContext,
} from '../../../src/agentic/index.js';
import { runFixture, MemoryStateStore } from './state-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Five rows of about 300 KB: only three fit in the 1 MiB batch limit.
const backlog = Array.from({ length: 5 }, (_, index) => ({
  pair_id: `p${index + 1}`,
  updated_at: index + 1,
  note: 'x'.repeat(300_000),
}));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dogsled-backlog-'));
  dirs.push(dir);
  const f = runFixture(5);
  f.model.limits.tokens = null;
  f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
  f.host.incrementalBatches = true;
  f.host.inputs = {
    undecided_pairs: [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'updated_at', type: 'integer', nullable: false },
      { name: 'note', type: 'string', nullable: false },
    ],
  };
  const contexts: AgenticProbeContext[] = [];
  // Like a warehouse query: filter after the cursor and order by it.
  f.host.prepare = vi.fn(async (context: AgenticProbeContext) => {
    contexts.push(context);
    const after = context.incremental?.after;
    return backlog.filter((row) => after === undefined || row.updated_at > Number(after));
  });
  f.host.executeAgent = vi.fn(f.host.executeAgent);
  const publisher: AgenticPublisher = {
    preflight: vi.fn(async () => {}),
    claim: vi.fn(async () => ({ version: 0, fence: 'owner' })),
    prepare: vi.fn(async (_context, identity, _rows, _keys, claim) => ({
      identity,
      expected_version: claim.version,
      stage: `stage_${identity.operation_id}`,
    })),
    inspect: vi.fn(async () => null),
    commit: vi.fn(async (intent) => ({ intent, committed_version: 1 })),
    close: vi.fn(async () => {}),
  };
  const stateStore = new MemoryStateStore();
  const cursorStore = createLocalAgenticCursorStore(dir);
  const run = (id: string, mode: 'start' | 'resume' = 'start', signal?: AbortSignal) =>
    executeAgenticRun(f.host, f.context(), {
      run: { id, mode },
      stateStore,
      cursorStore,
      publisher,
      projectDirectory: dir,
      ...(signal ? { signal } : {}),
    });
  return { ...f, contexts, publisher, run };
}

// Plan steps order assignments by group digest, so compare the set of keys.
const ids = (keys: unknown[]) => keys.map((key) => (key as { pair_id: string }).pair_id).sort();

describe('incremental backlog batches', { timeout: 60_000 }, () => {
  it('processes a backlog over several runs without skipping or repeating rows', async () => {
    const f = fixture();
    const first = await f.run('batch-1');
    expect(f.contexts[0]!.incremental).toMatchObject({ cursor_field: 'updated_at', batch: true });
    expect(ids(first.processedKeys)).toEqual(['p1', 'p2', 'p3']);
    expect(first.remainingInput).toEqual(['undecided_pairs']);

    const second = await f.run('batch-2');
    expect(f.contexts[1]!.incremental?.after).toBe(3);
    expect(ids(second.processedKeys)).toEqual(['p4', 'p5']);
    expect(second.remainingInput).toEqual([]);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(5);
  });

  it('still reports waiting rows when an interrupted run resumes', async () => {
    const f = fixture();
    const execute = f.host.executeAgent;
    const controller = new AbortController();
    f.host.executeAgent = vi.fn(async () => {
      controller.abort();
      throw new Error('interrupted');
    });
    await expect(f.run('batch-1', 'start', controller.signal)).rejects.toThrow();
    f.host.executeAgent = execute;
    const resumed = await f.run('batch-1', 'resume');
    // The resume uses the saved batch and does not read the source again.
    expect(f.host.prepare).toHaveBeenCalledTimes(1);
    expect(ids(resumed.processedKeys)).toEqual(['p1', 'p2', 'p3']);
    expect(resumed.remainingInput).toEqual(['undecided_pairs']);
  });

  it('still reports waiting rows when only publication is retried', async () => {
    const f = fixture();
    vi.mocked(f.publisher.commit).mockRejectedValueOnce(new Error('connection reset'));
    await expect(f.run('batch-1')).rejects.toThrow();
    const resumed = await f.run('batch-1', 'resume');
    expect(resumed.reusedCompletion).toBe(true);
    expect(resumed.remainingInput).toEqual(['undecided_pairs']);
  });

  it('keeps failing clearly for hosts that do not return ordered batches', async () => {
    const f = fixture();
    f.host.incrementalBatches = false;
    const error = await f.run('legacy').catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('Agentic input "undecided_pairs" is');
    expect(error.message).toContain('the limit is 1 MiB');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });
});
