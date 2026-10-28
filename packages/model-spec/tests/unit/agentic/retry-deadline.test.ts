import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgenticRunSnapshotSchema,
  AgenticStateError,
  type AgenticStateStore,
  applyAgenticCheckpoint,
} from '../../../src/agentic/state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

afterEach(() => vi.useRealTimers());
describe('retry execution windows', () => {
  it.each(['resume', 'start'] as const)(
    'refreshes an expired existing run in %s mode and reuses work',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const f = runFixture(2);
      f.model.limits.timeout_seconds = 1;
      const store = new MemoryStateStore();
      const execute = f.host.executeAgent;
      const calls = vi
        .spyOn(f.host, 'executeAgent')
        .mockImplementationOnce(execute)
        .mockRejectedValueOnce(new Error('worker interrupted'));
      const options = {
        projectDirectory: '/unused',
        stateStore: store,
        run: { id: 'retry', mode: 'start' as const },
      };
      await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
      const before = structuredClone([...store.runs.values()][0]!);
      vi.setSystemTime(Date.now() + 2000);
      const restartedAt = Date.now();
      const result = await executeAgenticRun(f.host, f.context(), {
        ...options,
        run: { id: 'retry', mode },
      });
      expect(Date.parse(result.deadlineAt)).toBe(restartedAt + 1000);
      expect(calls).toHaveBeenCalledTimes(3);
      expect(calls.mock.calls[2]![0].assignment.limits.deadline_at).toBe(result.deadlineAt);
      expect(result.chargedTokens).toBe(104);
      const after = [...store.runs.values()][0]!;
      expect(after.work[0]).toEqual(before.work[0]);
      expect(after.started_at).toBe(before.started_at);
    }
  );

  it('retries expired preparation without changing the original input timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = runFixture(1);
    f.model.limits.timeout_seconds = 1;
    const prepare = vi.spyOn(f.host, 'prepare').mockRejectedValueOnce(new Error('offline'));
    const store = new MemoryStateStore();
    const options = {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'prepare', mode: 'start' as const },
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
    vi.setSystemTime(Date.now() + 2000);
    expect(
      (
        await executeAgenticRun(f.host, f.context(), {
          ...options,
          run: { id: 'prepare', mode: 'resume' },
        })
      ).status
    ).toBe('execution_complete');
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('checks retry receipts and rejects altered window history', async () => {
    const f = runFixture(1);
    const store = new MemoryStateStore();
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'windows', mode: 'start' },
    });
    const saved = [...store.runs.values()][0]!;
    const command = {
      type: 'begin_execution' as const,
      operation_id: 'retry-1',
      expected_revision: saved.revision,
      started_at: new Date(Date.now()).toISOString(),
    };
    const resumed = applyAgenticCheckpoint(saved, command);
    expect(applyAgenticCheckpoint(resumed, command)).toEqual(resumed);
    expect(() =>
      applyAgenticCheckpoint(resumed, { ...command, expected_revision: resumed.revision })
    ).toThrow('conflict');
    expect(resumed.work).toEqual(saved.work);
    for (const mutation of ['duration', 'revision', 'phase', 'duplicate'] as const) {
      const changed = structuredClone(resumed);
      const window = changed.execution_windows![0]!;
      if (mutation === 'duration') {
        window.deadline_at = new Date(Date.parse(window.deadline_at) + 1).toISOString();
      }
      if (mutation === 'revision') window.revision = changed.revision;
      if (mutation === 'phase') window.status = 'preparing';
      if (mutation === 'duplicate') changed.execution_windows!.push(window);
      expect(AgenticRunSnapshotSchema.safeParse(changed).success).toBe(false);
    }
  });
  it('does not accept an old late result under the new deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = runFixture(1);
    f.model.limits.timeout_seconds = 1;
    f.host.executeAgent = async () => {
      throw new Error('interrupted');
    };
    const store = new MemoryStateStore();
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store,
        run: { id: 'late', mode: 'start' },
      })
    ).rejects.toThrow();
    const saved = [...store.runs.values()][0]!;
    vi.setSystemTime(Date.now() + 2000);
    const resumed = applyAgenticCheckpoint(saved, {
      type: 'begin_execution',
      operation_id: 'retry',
      expected_revision: saved.revision,
      started_at: new Date(Date.now()).toISOString(),
    });
    const id = saved.work[0]!.attempts[0]!.id;
    const late = applyAgenticCheckpoint(resumed, {
      type: 'finish_attempt',
      operation_id: `finish_attempt:${id}`,
      expected_revision: resumed.revision,
      work: 0,
      attempt_id: id,
      charge: 2,
      outcome: {
        contract_version: 2,
        attempt_id: id,
        status: 'succeeded',
        rows: [],
        usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    expect(late.work[0]!.accepted).toBeUndefined();
    expect(late.charged).toBe(2);
  });
  it('does not reset the retry window again after an uncertain checkpoint and lease recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = runFixture(1);
    f.model.limits.timeout_seconds = 1;
    vi.spyOn(f.host, 'prepare').mockRejectedValueOnce(new Error('offline'));
    const memory = new MemoryStateStore();
    const options = {
      projectDirectory: '/unused',
      stateStore: memory,
      run: { id: 'uncertain-window', mode: 'start' as const },
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
    vi.setSystemTime(Date.now() + 2000);
    const started = Date.now();
    let acquisitions = 0;
    let lost = false;
    const store: AgenticStateStore = {
      async acquire(key) {
        const session = await memory.acquire(key);
        const first = ++acquisitions === 1;
        return {
          ...session,
          async read() {
            if (first && lost) throw new AgenticStateError('lease_lost');
            return session.read();
          },
          async checkpoint(command) {
            const result = await session.checkpoint(command);
            if (first && command.type === 'begin_execution') {
              lost = true;
              vi.setSystemTime(Date.now() + 500);
              throw new AgenticStateError('lease_lost');
            }
            return result;
          },
        };
      },
    };
    const result = await executeAgenticRun(f.host, f.context(), {
      ...options,
      stateStore: store,
      run: { id: 'uncertain-window', mode: 'resume' },
    });
    expect(acquisitions).toBe(2);
    expect(Date.parse(result.deadlineAt)).toBe(started + 1000);
    expect([...memory.runs.values()][0]!.execution_windows).toHaveLength(1);
  });
});
