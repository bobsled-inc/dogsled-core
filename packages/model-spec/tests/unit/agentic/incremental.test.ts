import { normalizeCursor } from '../../../src/agentic/cursor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  createLocalAgenticCursorStore,
  type AgenticPublisher,
} from '../../../src/agentic/index.js';
import { runFixture, MemoryStateStore } from './state-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dogsled-cursors-'));
  dirs.push(dir);
  const f = runFixture(2);
  f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
  f.host.inputs = {
    undecided_pairs: [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'updated_at', type: 'integer', nullable: false },
    ],
  };
  let rows = [
    { pair_id: 'a', updated_at: 1 },
    { pair_id: 'b', updated_at: 2 },
  ];
  f.host.prepare = vi.fn(async () => rows);
  f.host.executeAgent = vi.fn(f.host.executeAgent);
  const stateStore = new MemoryStateStore();
  const cursorStore = createLocalAgenticCursorStore(dir);
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
  const run = (id: string, mode: 'start' | 'resume' = 'start') =>
    executeAgenticRun(f.host, f.context(), {
      run: { id, mode },
      stateStore,
      cursorStore,
      publisher,
      projectDirectory: dir,
    });
  return {
    ...f,
    dir,
    stateStore,
    cursorStore,
    publisher,
    run,
    setRows: (value: typeof rows) => {
      rows = value;
    },
  };
}
describe('incremental agentic batches', { timeout: 60_000 }, () => {
  it('reuses the cursor for classification and calls only changed inputs', async () => {
    const f = fixture();
    const step = f.model.plan.steps[0]!;
    step.classification = { choices: { same: 'Same place', different: 'Different places' } };
    step.columns = [
      step.columns[0]!,
      { name: 'choice', type: 'string', nullable: false },
      { name: 'confidence', type: 'number', nullable: false },
    ];
    f.host.platform.models.review = {
      provider: 'typesafe',
      model: 'jev-latest',
      api_key: '$KEY',
      auth_env_vars: ['KEY'],
    };
    const original = f.host.executeAgent;
    const execute = vi.fn(async (request: Parameters<typeof original>[0]) => ({
      ...(await original(request)),
      status: 'succeeded' as const,
      rows: [
        {
          ...request.assignment.group_key,
          choice: 'same',
          confidence: 0.8,
          _dogsled_evidence: null,
          _dogsled_confidence: 0.8,
          _dogsled_reason: null,
        },
      ],
    }));
    f.host.executeAgent = execute;
    await f.run('classification-first');
    expect(execute).toHaveBeenCalledTimes(2);
    await f.run('classification-unchanged');
    expect(execute).toHaveBeenCalledTimes(2);
    f.setRows([
      { pair_id: 'a', updated_at: 3 },
      { pair_id: 'b', updated_at: 2 },
    ]);
    await f.run('classification-changed');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]![0].assignment.group_key).toEqual({ pair_id: 'a' });
    expect([...f.stateStore.runs.values()].at(-1)?.cursor_values).toEqual({ pairs: 3 });
  });
  it('normalizes timestamp precision without rounding', () => {
    expect(normalizeCursor('2026-09-18T10:00:00.123456Z', 'timestamp')).toBe(
      '2026-09-18T10:00:00.123456000Z'
    );
    expect(normalizeCursor('2026-09-18T10:00:00Z', 'timestamp')).toBe(
      '2026-09-18T10:00:00.000000000Z'
    );
    expect(() => normalizeCursor(null, 'timestamp')).toThrow();
    expect(() => normalizeCursor('2026-09-18 10:00:00', 'timestamp')).toThrow();
  });
  it('rejects missing and unsupported cursor fields', () => {
    const f = fixture();
    f.model.sources.pairs!.incremental = { cursor_field: 'missing' };
    expect(() => f.context()).toThrow('cursor');
    f.model.sources.pairs!.incremental = { cursor_field: 'pair_id' };
    expect(() => f.context()).toThrow('cursor');
  });
  it('advances for zero-output inputs and selects only later changes', async () => {
    const f = fixture();
    await f.run('first');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    await f.run('empty');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    f.setRows([
      { pair_id: 'a', updated_at: 3 },
      { pair_id: 'b', updated_at: 2 },
      { pair_id: 'c', updated_at: 4 },
    ]);
    await f.run('second');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(4);
    expect([...f.stateStore.runs.values()].at(-1)?.cursor_values).toEqual({ pairs: 4 });
  });
  it('starts a fresh batch after an exhausted run without losing committed progress', async () => {
    const f = fixture();
    f.model.limits.tokens = 150;
    await f.run('committed');
    f.setRows([{ pair_id: 'c', updated_at: 3 }]);
    vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('lost response'));
    await expect(f.run('failed')).rejects.toThrow();
    await expect(f.run('failed', 'resume')).rejects.toThrow('limit');
    await f.run('replacement');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(4);
    const failed = [...f.stateStore.runs.values()].find((run) => run.key.id === 'failed')!;
    expect(failed.charged).toBe(100);
    await expect(f.run('failed', 'resume')).rejects.toThrow('superseded');
    await f.run('unchanged');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(4);
    const replacement = [...f.stateStore.runs.values()].find(
      (run) => run.key.id === 'replacement'
    )!;
    expect(replacement.plan_inputs!.pairs!.rows).toEqual([{ pair_id: 'c', updated_at: 3 }]);
  });
  it('does not replace a live run or dispatch work while its owner is held', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const execute = vi.mocked(f.host.executeAgent!).getMockImplementation()!;
    vi.mocked(f.host.executeAgent!).mockImplementationOnce(async (args) => {
      entered.resolve();
      await proceed.promise;
      return execute(args);
    });
    const live = f.run('live');
    await entered.promise;
    try {
      await expect(f.run('contender')).rejects.toThrow('may still be active');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
      expect(
        [...f.stateStore.runs.values()].find((run) => run.key.id === 'live')!.superseded
      ).toBeUndefined();
    } finally {
      proceed.resolve();
      await live;
    }
    await f.run('contender');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  });
  it('recovers when retirement succeeds but cursor takeover does not', async () => {
    const f = fixture();
    vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('failed')).rejects.toThrow();
    vi.spyOn(f.cursorStore, 'supersede').mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('interrupted')).rejects.toThrow();
    await expect(f.run('failed')).rejects.toThrow('superseded');
    await f.run('replacement');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
    await f.run('unchanged');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
  });
  it.each([true, false])(
    'requires durable retirement after an uncertain checkpoint reply (saved=%s)',
    async (saved) => {
      const f = fixture();
      vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('offline'));
      await expect(f.run('failed')).rejects.toThrow();
      const acquire = f.stateStore.acquire.bind(f.stateStore);
      const spy = vi.spyOn(f.stateStore, 'acquire').mockImplementation(async (key) => {
        const session = await acquire(key);
        const checkpoint = session.checkpoint.bind(session);
        session.checkpoint = async (command) => {
          if (command.type !== 'supersede') return checkpoint(command);
          if (saved) await checkpoint(command);
          throw new Error('lost checkpoint response');
        };
        return session;
      });
      if (saved) {
        await f.run('replacement');
        await expect(f.run('failed', 'resume')).rejects.toThrow('superseded');
      } else {
        const takeover = vi.spyOn(f.cursorStore, 'supersede');
        await expect(f.run('replacement')).rejects.toThrow('corrupt');
        expect(takeover).not.toHaveBeenCalled();
        spy.mockRestore();
        await f.run('failed', 'resume');
      }
    }
  );
  it('recovers a lost takeover response without resetting progress', async () => {
    const f = fixture();
    vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('failed')).rejects.toThrow();
    const supersede = f.cursorStore.supersede!.bind(f.cursorStore);
    vi.spyOn(f.cursorStore, 'supersede').mockImplementationOnce(async (...args) => {
      await supersede(...args);
      throw new Error('lost response');
    });
    await expect(f.run('replacement')).rejects.toThrow();
    await f.run('replacement');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
  });
  it('does not retire the old run if the custom cursor store lacks takeover support', async () => {
    const f = fixture();
    vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('failed')).rejects.toThrow();
    delete f.cursorStore.supersede;
    await expect(f.run('replacement')).rejects.toThrow('does not support safe takeover');
    await f.run('failed', 'resume');
  });
  it('never takes another batch when explicitly resuming', async () => {
    const f = fixture();
    vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('failed')).rejects.toThrow();
    // Create an independent checkpoint but leave the old cursor ownership intact.
    const preflight = f.cursorStore.begin.bind(f.cursorStore);
    vi.spyOn(f.cursorStore, 'begin').mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('other')).rejects.toThrow();
    vi.mocked(f.cursorStore.begin).mockImplementation(preflight);
    await expect(f.run('other', 'resume')).rejects.toThrow('owns this incremental batch');
    await f.run('failed', 'resume');
  });
  it('keeps a failed batch reserved and resumes without new calls', async () => {
    const f = fixture();
    vi.mocked(f.publisher.commit).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('first')).rejects.toThrow();
    await expect(f.run('other')).rejects.toThrow('may have published output');
    await f.run('first', 'resume');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    await f.run('next');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  });
  it('reconciles a lost cursor commit response without new agent calls', async () => {
    const f = fixture();
    const commit = f.cursorStore.commit.bind(f.cursorStore);
    vi.spyOn(f.cursorStore, 'commit').mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw new Error('lost reply');
    });
    await expect(f.run('first')).rejects.toThrow();
    await f.run('first', 'resume');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    await f.run('next');
    await f.run('first', 'resume');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  });
  it('rejects null cursors before calling the agent', async () => {
    const f = fixture();
    f.host.prepare = async () => [{ pair_id: 'a', updated_at: null }];
    await expect(f.run('bad')).rejects.toThrow('cursor');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });
  it('handles an empty first batch without inventing a cursor', async () => {
    const f = fixture();
    f.setRows([]);
    await f.run('empty');
    f.setRows([{ pair_id: 'a', updated_at: 0 }]);
    await f.run('first');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
  });
  it('persists shared local cursors across store instances', async () => {
    const f = fixture();
    const key = { scope: 'one', model: 'one', target: 'main.one' };
    const signature = 'a'.repeat(64);
    await f.cursorStore.begin(key, signature, 'first');
    await f.cursorStore.commit(key, signature, 'first', { pairs: 4 });
    const reopened = createLocalAgenticCursorStore(f.dir);
    expect(await reopened.begin(key, signature, 'next')).toEqual({ pairs: 4 });
    expect(await reopened.begin({ ...key, model: 'two' }, signature, 'other')).toEqual({});
    await expect(reopened.commit(key, signature, 'next', { pairs: 3 })).rejects.toThrow();
  });
});
