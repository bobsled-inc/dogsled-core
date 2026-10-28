import { describe, expect, it, vi } from 'vitest';
import { executeAgenticRun } from '../../../src/agentic/index.js';
import type { AgentExecutorRequest } from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(count = 5, concurrency = 3) {
  const f = runFixture(count);
  f.host.concurrency = concurrency;
  const stateStore = new MemoryStateStore();
  const options = {
    projectDirectory: '/not-used',
    stateStore,
    run: { id: 'concurrent', mode: 'start' as const },
  };
  const state = () => [...stateStore.runs.values()][0]!;
  return {
    ...f,
    stateStore,
    options,
    state,
    run: () => executeAgenticRun(f.host, f.context(), options),
  };
}
const usage = { status: 'measured' as const, input_tokens: 1, output_tokens: 1, total_tokens: 2 };
async function succeed({ assignment, budget }: AgentExecutorRequest) {
  const receipt = await budget.reserve(100);
  await budget.settle(receipt, usage);
  return {
    contract_version: 2 as const,
    attempt_id: assignment.attempt_id,
    status: 'succeeded' as const,
    usage,
    rows: [],
  };
}

// These tests validate many full checkpoints. Shared CI runners need more time.
describe('concurrent agentic assignments', { timeout: 60_000 }, () => {
  it('bounds active calls, saves out-of-order results, and keeps output keys in input order', async () => {
    const f = setup();
    const gates = Array.from({ length: 5 }, deferred);
    const entered = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let active = 0,
      peak = 0;
    f.host.executeAgent = async (request) => {
      const index = Number(request.assignment.shard_id);
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      // Reservation is durable before the external call can start.
      expect(f.state().work[index]!.attempts).toHaveLength(1);
      entered[index]!.resolve();
      await gates[index]!.promise;
      active--;
      return succeed(request);
    };
    const run = f.run();
    await entered[2]!.promise;
    expect(started).toEqual([0, 1, 2]);
    expect(f.state().charged).toBe(300);
    gates[2]!.resolve();
    await entered[3]!.promise;
    expect(started).toEqual([0, 1, 2, 3]);
    expect(f.state().work[2]!.accepted?.status).toBe('succeeded');
    expect(f.state().work[0]!.accepted).toBeUndefined();
    gates[3]!.resolve();
    await entered[4]!.promise;
    expect(started).toHaveLength(5);
    for (const gate of gates) gate.resolve();
    expect((await run).processedKeys).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ pair_id: `p${i}` }))
    );
    expect(peak).toBe(3);
    expect(f.state().charged).toBe(10);
  });

  it('waits for active reservations to settle instead of failing or overspending', async () => {
    const f = setup(3);
    f.model.limits.tokens = 150;
    const first = deferred();
    const entered = deferred();
    const started: string[] = [];
    f.host.executeAgent = async (request) => {
      started.push(request.assignment.shard_id);
      if (started.length === 1) {
        entered.resolve();
        await first.promise;
      }
      return succeed(request);
    };
    const run = f.run();
    await entered.promise;
    expect(started).toEqual(['0']);
    expect(f.state().charged).toBe(100);
    first.resolve();
    expect((await run).chargedTokens).toBe(6);
    expect(started).toEqual(['0', '1', '2']);
  });

  it('counts retry usage and never exceeds the active-call limit', async () => {
    const f = setup(3, 2);
    const seen = new Set<string>();
    let active = 0,
      peak = 0;
    f.host.executeAgent = async (request) => {
      active++;
      peak = Math.max(peak, active);
      const result = await succeed(request);
      active--;
      if (!seen.has(request.assignment.shard_id)) {
        seen.add(request.assignment.shard_id);
        return {
          contract_version: result.contract_version,
          attempt_id: result.attempt_id,
          usage: result.usage,
          status: 'failed',
          error: { kind: 'provider', code: 'busy', retryable: true },
        };
      }
      return result;
    };
    expect((await f.run()).chargedTokens).toBe(12);
    expect(peak).toBeLessThanOrEqual(2);
    expect(f.state().work.every((w) => w.attempts.length === 2)).toBe(true);
  });

  it('cancels all active calls, retains their reservations, and ignores late output', async () => {
    const f = setup(5, 3);
    const stop = new AbortController();
    const gates = Array.from({ length: 3 }, deferred);
    const listening = Array.from({ length: 3 }, deferred);
    const requests: AgentExecutorRequest[] = [];
    f.host.executeAgent = async (request) => {
      requests.push(request);
      const result = await succeed(request);
      request.signal.addEventListener(
        'abort',
        () => gates[Number(request.assignment.shard_id)]!.resolve(),
        { once: true }
      );
      if (request.signal.aborted) gates[Number(request.assignment.shard_id)]!.resolve();
      listening[Number(request.assignment.shard_id)]!.resolve();
      await gates[Number(request.assignment.shard_id)]!.promise;
      return result;
    };
    const run = executeAgenticRun(f.host, f.context(), { ...f.options, signal: stop.signal });
    const rejected = expect(run).rejects.toThrow();
    await Promise.all(listening.map((gate) => gate.promise));
    expect(requests).toHaveLength(3);
    stop.abort();
    await rejected;
    expect(requests.every((r) => r.signal.aborted)).toBe(true);
    expect(f.state().charged).toBe(300);
    expect(f.state().work.every((w) => !w.accepted)).toBe(true);
    const saved = structuredClone(f.state());
    for (const gate of gates) gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state()).toEqual(saved);
    expect(f.stateStore.owners.size).toBe(0);
    f.host.concurrency = 1;
    f.host.executeAgent = vi.fn(succeed);
    const recovered = await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      run: { id: 'concurrent', mode: 'resume' },
    });
    expect(recovered.chargedTokens).toBe(310);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(5);
  });

  it.each([false, true])(
    'stops active assignments after terminal failure or exhausted retries (retryable=%s)',
    async (retryable) => {
      const f = setup(5, 2);
      if (retryable) Object.assign(f.options, { maxAttempts: 1 });
      const gate = deferred();
      const entered = Array.from({ length: 2 }, deferred);
      const requests: AgentExecutorRequest[] = [];
      f.host.executeAgent = async (request) => {
        requests.push(request);
        if (request.assignment.shard_id === '1') {
          entered[1]!.resolve();
          await gate.promise;
          const result = await succeed(request);
          return {
            contract_version: result.contract_version,
            attempt_id: result.attempt_id,
            usage: result.usage,
            status: 'failed',
            error: { kind: 'validation', code: 'invalid', retryable },
          };
        }
        const result = await succeed(request);
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
          if (request.signal.aborted) resolve();
          entered[0]!.resolve();
        });
        return result;
      };
      const run = f.run();
      const rejected = expect(run).rejects.toThrow(
        retryable ? 'limit' : 'Agentic assignment failed'
      );
      await Promise.all(entered.map((gate) => gate.promise));
      expect(requests).toHaveLength(2);
      gate.resolve();
      await rejected;
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(requests).toHaveLength(2);
      expect(f.state().publication).toBe('pending');
      f.host.executeAgent = vi.fn(succeed);
      await expect(
        executeAgenticRun(f.host, f.context(), {
          ...f.options,
          run: { id: 'concurrent', mode: 'resume' },
        })
      ).rejects.toThrow(retryable ? 'limit' : 'Agentic assignment failed');
      expect(f.host.executeAgent).not.toHaveBeenCalled();
    }
  );

  it('spaces dispatch starts, including retries, while saving completed work', async () => {
    const f = setup(2, 3);
    f.host.minDispatchIntervalMs = 40;
    const starts: number[] = [];
    f.host.executeAgent = async (request) => {
      starts.push(Date.now());
      return succeed(request);
    };
    await f.run();
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(40);
  });

  it('keeps unknown usage charged and refuses work after the shared budget is exhausted', async () => {
    const f = setup(3, 2);
    f.model.limits.tokens = 200;
    f.host.executeAgent = vi.fn(async (request) => ({
      contract_version: 2,
      attempt_id: request.assignment.attempt_id,
      status: 'succeeded',
      rows: [],
      usage: { status: 'unknown', reason: 'unavailable' },
    }));
    await expect(f.run()).rejects.toThrow('limit');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    expect(f.state().charged).toBe(200);
    expect(f.state().publication).toBe('pending');
    f.host.executeAgent = vi.fn(succeed);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        ...f.options,
        run: { id: 'concurrent', mode: 'resume' },
      })
    ).rejects.toThrow('limit');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('enforces each attempt deadline while waiting and refreshes it on explicit resume', async () => {
    const f = setup(2, 2);
    // Keep enough time for the run coordinator to initialize on loaded CI workers.
    f.model.limits.timeout_seconds = 5;
    f.host.minDispatchIntervalMs = 6000;
    f.host.executeAgent = vi.fn(succeed);
    await expect(f.run()).rejects.toThrow();
    expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    expect(f.state().work[0]!.accepted?.status).toBe('succeeded');
    expect(f.state().work[1]!.attempts).toHaveLength(0);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        ...f.options,
        run: { id: 'concurrent', mode: 'resume' },
      })
    ).resolves.toMatchObject({ status: 'execution_complete' });
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 65 },
    { concurrency: 1.5 },
    { minDispatchIntervalMs: -1 },
    { minDispatchIntervalMs: 60001 },
  ])('rejects invalid scheduling controls before acquiring state: %j', async (invalid) => {
    const f = setup();
    Object.assign(f.host, invalid);
    const acquire = vi.spyOn(f.stateStore, 'acquire');
    await expect(f.run()).rejects.toThrow('limit');
    expect(acquire).not.toHaveBeenCalled();
  });
});
