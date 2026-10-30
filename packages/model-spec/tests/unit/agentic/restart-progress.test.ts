import { describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  AgenticStateError,
  AgenticRunSnapshotSchema,
  applyAgenticCheckpoint,
  type AgenticRunProgress,
} from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

describe('explicit failed assignment restart', () => {
  it('keeps accepted work and charges while retrying a saved terminal failure only on request', async () => {
    const f = runFixture(2);
    const store = new MemoryStateStore();
    const succeed = f.host.executeAgent;
    let repaired = false;
    f.host.prepare = vi.fn(f.host.prepare);
    f.host.executeAgent = vi.fn(async (request) => {
      if (!repaired && request.assignment.group_key.pair_id === 'p1') {
        return {
          contract_version: 2 as const,
          attempt_id: request.assignment.attempt_id,
          status: 'failed' as const,
          usage: {
            status: 'measured' as const,
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
          error: { kind: 'validation' as const, code: 'INVALID_OUTPUT', retryable: false },
        };
      }
      return succeed(request);
    });
    const options = {
      projectDirectory: '.',
      stateStore: store,
      run: { id: 'run', mode: 'start' as const },
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
      /assignment \d+ failed/
    );
    repaired = true;
    const resume = { ...options, run: { id: 'run', mode: 'resume' as const } };
    await expect(executeAgenticRun(f.host, f.context(), resume)).rejects.toThrow(
      /assignment \d+ failed/
    );
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    const result = await executeAgenticRun(f.host, f.context(), {
      ...resume,
      retryFailedAssignments: true,
    });
    expect(result.status).toBe('execution_complete');
    expect(result.chargedTokens).toBe(6);
    expect(f.host.prepare).toHaveBeenCalledTimes(1);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
    expect([...store.runs.values()][0]!.work.map((work) => work.attempts.length)).toEqual([1, 2]);
    const invalid = structuredClone([...store.runs.values()][0]!);
    for (const window of invalid.execution_windows ?? []) delete window.retry_failed;
    expect(AgenticRunSnapshotSchema.safeParse(invalid).success).toBe(false);
    await executeAgenticRun(f.host, f.context(), { ...resume, retryFailedAssignments: true });
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
  });
});

it('does not loop on a new terminal failure or reset attempt limits after explicit restart', async () => {
  const f = runFixture(1);
  const progress: AgenticRunProgress[] = [];
  f.host.executeAgent = vi.fn(async ({ assignment }) => ({
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'failed',
    usage: { status: 'unknown', reason: 'unavailable' },
    error: { kind: 'auth', code: 'AUTH_FAILED', retryable: false },
  }));
  const options = {
    projectDirectory: '.',
    stateStore: new MemoryStateStore(),
    maxAttempts: 2,
    run: { id: 'run', mode: 'start' as const },
    // Checks reservation charges; spend-cap charges are covered in spend-cap.test.ts.
    accounting: 'reservation' as const,
    onProgress: (value: AgenticRunProgress) => {
      progress.push(value);
    },
  };
  await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
    /assignment \d+ failed/
  );
  expect(progress.at(-1)).toMatchObject({ failed: 1, accepted: 0, running: 0 });
  const resume = {
    ...options,
    run: { id: 'run', mode: 'resume' as const },
    retryFailedAssignments: true,
  };
  await expect(executeAgenticRun(f.host, f.context(), resume)).rejects.toThrow(
    /assignment \d+ failed/
  );
  expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  await expect(executeAgenticRun(f.host, f.context(), resume)).rejects.toThrow(
    /assignment \d+ failed/
  );
  expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  expect([...options.stateStore.runs.values()][0]!.charged).toBe(200);
});

it('requires resume mode before an explicit restart can acquire storage', async () => {
  const f = runFixture(1);
  const stateStore = new MemoryStateStore();
  const acquire = vi.spyOn(stateStore, 'acquire');
  await expect(
    executeAgenticRun(f.host, f.context(), {
      projectDirectory: '.',
      stateStore,
      run: { id: 'run', mode: 'start' },
      retryFailedAssignments: true,
    })
  ).rejects.toThrow('conflict');
  expect(acquire).not.toHaveBeenCalled();
});

it('reports a checkpoint once after a lost response and tolerates observer failure', async () => {
  const f = runFixture(2);
  const base = new MemoryStateStore();
  let lost = false;
  const stateStore = {
    async acquire(key: Parameters<typeof base.acquire>[0]) {
      const session = await base.acquire(key);
      return {
        ...session,
        async checkpoint(command: Parameters<typeof applyAgenticCheckpoint>[1]) {
          const result = await session.checkpoint(command);
          if (!lost && command.type === 'finish_attempt') {
            lost = true;
            throw new AgenticStateError('unavailable');
          }
          return result;
        },
      };
    },
  };
  const progress: AgenticRunProgress[] = [];
  await executeAgenticRun(f.host, f.context(), {
    projectDirectory: '.',
    stateStore,
    run: { id: 'run', mode: 'start' },
    onProgress: async (value) => {
      progress.push(structuredClone(value));
      value.accepted = 999;
      throw new Error('Observer failed');
    },
  });
  expect(progress.filter((value) => value.accepted === 1 && value.running === 0)).toHaveLength(1);
  expect(progress.at(-1)).toMatchObject({ accepted: 2, total: 2 });
  expect(new Set(progress.map((value) => value.revision)).size).toBe(progress.length);
});

it('reports durable assignment counts and restores accepted progress on resume', async () => {
  const f = runFixture(2);
  const progress: AgenticRunProgress[] = [];
  const options = {
    projectDirectory: '.',
    stateStore: new MemoryStateStore(),
    run: { id: 'run', mode: 'start' as const },
    onProgress: (value: AgenticRunProgress) => {
      progress.push(value);
    },
  };
  await executeAgenticRun(f.host, f.context(), options);
  expect(progress[0]).toMatchObject({ total: 0, accepted: 0, totalIsFinal: false });
  expect(progress).toContainEqual(expect.objectContaining({ total: 2, accepted: 1, pending: 1 }));
  expect(progress.at(-1)).toMatchObject({
    runId: 'run',
    modelName: 'pair_assessments',
    total: 2,
    accepted: 2,
    running: 0,
    pending: 0,
    failed: 0,
    totalIsFinal: true,
    status: 'execution_complete',
    publication: 'pending',
  });
  for (const item of progress) {
    expect(item.accepted + item.running + item.pending + item.failed).toBe(item.total);
  }
  progress.length = 0;
  await executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } });
  expect(progress[0]).toMatchObject({ total: 2, accepted: 2, status: 'execution_complete' });
});
