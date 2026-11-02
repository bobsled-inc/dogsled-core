import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  type AgentExecutorRequest,
  type AgenticTokenReservation,
} from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

function setup(field: 'context_sources' | 'sources' = 'context_sources') {
  const f = runFixture(1);
  f.model.plan.steps[0]!.execution.mode = 'agent_loop';
  f.model.sources.web = { ref: 'research.web' };
  f.model.sources.private = { ref: 'warehouse.hierarchy' };
  f.model.plan.steps[0]![field] = ['web'];
  const stateStore = new MemoryStateStore();
  const sources = vi.fn(async () => ({
    rows: [{ title: 'Public evidence' }],
    retrieved_at: new Date().toISOString(),
  }));
  const host = { ...f.host, sources };
  const options = {
    projectDirectory: '/not-used',
    stateStore,
    run: { id: 'loop', mode: 'start' as const },
    accounting: 'reservation' as const,
  };
  return {
    ...f,
    host,
    sources,
    stateStore,
    options,
    run: () => executeAgenticRun(host, f.context(), options),
    state: () => [...stateStore.runs.values()][0]!,
  };
}
const usage = (tokens: number) => ({
  status: 'measured' as const,
  input_tokens: tokens,
  output_tokens: 0,
  total_tokens: tokens,
});
const result = (request: AgentExecutorRequest, tokens = 0) => ({
  contract_version: 2 as const,
  attempt_id: request.assignment.attempt_id,
  status: 'succeeded' as const,
  rows: [],
  usage: usage(tokens),
});

describe('agent loop execution', { timeout: 60_000 }, () => {
  it.each(['context_sources', 'sources'] as const)(
    'dispatches and resumes with the %s allowlist',
    async (field) => {
      const f = setup(field);
      f.host.executeAgent = vi.fn(async (request) => {
        expect(request.assignment.mode).toBe('agent_loop');
        expect(request.assignment.allowed_sources).toEqual(['research.web']);
        expect(request.sources).toBeTypeOf('function');
        const first = await request.budget.reserve(60);
        await request.budget.settle(first, usage(20));
        const reply = await request.sources!({
          source: 'research.web',
          operation: 'search',
          arguments: { search: 'Acme' },
        });
        expect(reply).toHaveProperty('rows');
        const second = await request.budget.reserve(80);
        await request.budget.settle(second, usage(30));
        // Even an underreported executor total cannot erase the per-call receipts.
        return result(request, 0);
      });
      expect((await f.run()).chargedTokens).toBe(50);
      expect(f.sources).toHaveBeenCalledTimes(1);
      expect(f.sources.mock.calls[0]).toHaveLength(2);
      expect(JSON.stringify(f.state())).not.toContain('Public evidence');
      await executeAgenticRun(f.host, f.context(), {
        ...f.options,
        run: { id: 'loop', mode: 'resume' },
        accounting: 'reservation' as const,
      });
      expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    {
      name: 'undeclared source',
      call: { source: 'warehouse.hierarchy', operation: 'read', arguments: {} },
    },
    { name: 'source alias', call: { source: 'web', operation: 'read', arguments: {} } },
    {
      name: 'write operation',
      call: { source: 'research.web', operation: 'write', arguments: {} },
    },
  ])('denies $name before dispatch, including swallowed denials', async ({ call }) => {
    const f = setup();
    f.host.executeAgent = async (request) => {
      await expect(request.sources!(call)).rejects.toThrow();
      return result(request);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.sources).not.toHaveBeenCalled();
    expect(f.state().work[0]!.accepted).toBeUndefined();
  });

  it('rejects an oversized request without dispatch and lets the executor recover', async () => {
    const f = setup();
    let failure: unknown;
    f.host.executeAgent = async (request) => {
      failure = await request.sources!({
        source: 'research.web',
        operation: 'search',
        arguments: 'x'.repeat(1048577),
      }).catch((error: unknown) => error);
      return result(request);
    };
    await f.run();
    expect((failure as Error).message).toMatch(/invalid shape or was too large/);
    expect(f.sources).not.toHaveBeenCalled();
    expect(f.state().work[0]!.accepted?.status).toBe('succeeded');
  });

  it('gives the executor a safe reason for a host failure and lets the run continue', async () => {
    const f = setup();
    const privateCause = new Error('private-credential and private-row');
    f.sources.mockRejectedValueOnce(new Error('Host source failed', { cause: privateCause }));
    let failure: unknown;
    f.host.executeAgent = async (request) => {
      failure = await request.sources!({
        source: 'research.web',
        operation: 'read',
        arguments: {},
      }).catch((error: unknown) => error);
      return result(request);
    };
    await f.run();
    // Checked after the run so a failed assertion cannot pass as a rejected run.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Agentic source request failed: source "research.web" failed in the source host'
    );
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).stack).not.toContain('private-');
    expect(f.sources).toHaveBeenCalledOnce();
    expect(f.state().work[0]!.accepted?.status).toBe('succeeded');
    expect(JSON.stringify(f.state())).not.toContain('private-');
  });

  it('passes host policy messages through so the executor can correct its request', async () => {
    const f = setup();
    f.sources.mockRejectedValueOnce(new CommandError('Agent source column is not declared', 2));
    let failure: unknown;
    f.host.executeAgent = async (request) => {
      failure = await request.sources!({
        source: 'research.web',
        operation: 'read',
        arguments: {},
      }).catch((error: unknown) => error);
      return result(request);
    };
    await f.run();
    expect((failure as Error).message).toBe(
      'Agentic source request failed: source "research.web": Agent source column is not declared'
    );
  });

  it('fails only the assignment for a policy violation and names the reason', async () => {
    const f = setup();
    f.host.executeAgent = async (request) => {
      await request.sources!({
        source: 'warehouse.secret',
        operation: 'read',
        arguments: {},
      }).catch(() => undefined);
      return result(request);
    };
    const error = await f.run().catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('validation error "source_access_denied"');
    expect(error.message).toContain('named a source this step does not declare');
    const attempts = f.state().work[0]!.attempts;
    expect(attempts.every((attempt) => attempt.outcome?.status === 'failed')).toBe(true);
    expect(f.sources).not.toHaveBeenCalled();
  });

  it('rejects missing source access before preparation or state acquisition', async () => {
    const f = setup();
    const prepare = vi.spyOn(f.host, 'prepare');
    await expect(
      executeAgenticRun({ ...f.host, sources: undefined }, f.context(), f.options)
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.stateStore.runs.size).toBe(0);
  });

  it('cannot overspend with simultaneous reservations or swallowed budget errors', async () => {
    const f = setup();
    f.host.executeAgent = async (request) => {
      const attempts = await Promise.allSettled([
        request.budget.reserve(60),
        request.budget.reserve(60),
      ]);
      expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      return result(request);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.state().charged).toBe(100);
    expect(f.state().work[0]!.accepted).toBeUndefined();
  });

  it('retains unknown and unsettled usage when the executor reports a smaller total', async () => {
    const f = setup();
    f.host.executeAgent = async (request) => {
      const first = await request.budget.reserve(60);
      await request.budget.settle(first, { status: 'unknown', reason: 'unavailable' });
      await request.budget.reserve(40);
      return result(request);
    };
    expect((await f.run()).chargedTokens).toBe(100);
  });

  it('fences callbacks and budget handles after assignment completion', async () => {
    const f = setup();
    let saved!: AgentExecutorRequest;
    let reservation!: AgenticTokenReservation;
    f.host.executeAgent = async (request) => {
      saved = request;
      reservation = await request.budget.reserve(60);
      await request.budget.settle(reservation, usage(10));
      return result(request, 10);
    };
    await f.run();
    await expect(
      saved.sources!({ source: 'research.web', operation: 'read', arguments: {} })
    ).rejects.toThrow();
    await expect(saved.budget.reserve(1)).rejects.toThrow();
    await expect(saved.budget.settle(reservation, usage(10))).rejects.toThrow();
    expect(f.sources).not.toHaveBeenCalled();
  });

  it('rejects oversized source results and retains interrupted reservations', async () => {
    const f = setup();
    f.host.sources = vi.fn(async () => ({ rows: [], retrieved_at: 'x'.repeat(1048577) }));
    f.host.executeAgent = async (request) => {
      await request.sources!({ source: 'research.web', operation: 'read', arguments: {} });
      return result(request);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.state().charged).toBe(100);
  });
});

it('uses an immutable permission scope even when executor code edits its payload', async () => {
  const f = setup();
  f.host.executeAgent = async (request) => {
    request.assignment.allowed_sources.push('warehouse.hierarchy');
    await expect(
      request.sources!({ source: 'warehouse.hierarchy', operation: 'read', arguments: {} })
    ).rejects.toThrow();
    return result(request);
  };
  await expect(f.run()).rejects.toThrow();
  expect(f.sources).not.toHaveBeenCalled();
});

it('cancels an active source read and restarts the whole unfinished loop on resume', async () => {
  const f = setup();
  const stop = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.host.sources = async (_request, { signal }) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      entered();
    });
    return { rows: [], retrieved_at: new Date().toISOString() };
  };
  f.host.executeAgent = async (request) => {
    await request.budget.reserve(60);
    await request.sources!({ source: 'research.web', operation: 'read', arguments: {} });
    return result(request);
  };
  const run = executeAgenticRun(f.host, f.context(), { ...f.options, signal: stop.signal });
  const rejected = expect(run).rejects.toThrow();
  await started;
  stop.abort();
  await rejected;
  expect(f.state().charged).toBe(100);
  expect(f.state().work[0]!.accepted).toBeUndefined();
  f.host.executeAgent = vi.fn(async (request) => {
    const receipt = await request.budget.reserve(100);
    await request.budget.settle(receipt, usage(10));
    return result(request, 10);
  });
  expect(
    (
      await executeAgenticRun(f.host, f.context(), {
        ...f.options,
        run: { id: 'loop', mode: 'resume' },
        accounting: 'reservation' as const,
      })
    ).chargedTokens
  ).toBe(110);
  expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
  expect(f.state().work[0]!.attempts).toHaveLength(2);
}, 60_000);

it('closes the budget before it waits for outstanding source reads', async () => {
  const f = setup();
  let finishRead!: () => void;
  let returned!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const executorReturned = new Promise<void>((resolve) => {
    returned = resolve;
  });
  let saved!: AgentExecutorRequest;
  f.host.sources = async () => {
    await waiting;
    return { rows: [], retrieved_at: new Date().toISOString() };
  };
  f.host.executeAgent = async (request) => {
    saved = request;
    void request.sources!({ source: 'research.web', operation: 'read', arguments: {} });
    returned();
    return result(request);
  };
  const run = f.run();
  await executorReturned;
  // Let the executor result reach the coordinator, which still waits on the read.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(saved.budget.reserve(10)).rejects.toThrow('closed');
  finishRead();
  await run;
});

it('aborts an outstanding source read when executor code throws', async () => {
  const f = setup();
  let observedSignal: AbortSignal | undefined;
  f.host.sources = async (_request, { signal }) => {
    observedSignal = signal;
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
    return { rows: [], retrieved_at: new Date().toISOString() };
  };
  f.host.executeAgent = async (request) => {
    void request.sources!({ source: 'research.web', operation: 'read', arguments: {} }).catch(
      () => {}
    );
    await Promise.resolve();
    throw new Error('Executor failed');
  };
  await expect(f.run()).rejects.toThrow();
  expect(observedSignal?.aborted).toBe(true);
  expect(f.stateStore.owners.size).toBe(0);
});

it('retries the whole loop with a new attempt and retains prior call usage', async () => {
  const f = setup();
  const attempts: string[] = [];
  f.host.executeAgent = async (request) => {
    attempts.push(request.assignment.attempt_id);
    const receipt = await request.budget.reserve(100);
    await request.budget.settle(receipt, usage(10));
    if (attempts.length === 1) {
      return {
        contract_version: 2,
        attempt_id: request.assignment.attempt_id,
        status: 'failed',
        usage: usage(10),
        error: { kind: 'provider', code: 'call_failed', retryable: true },
      };
    }
    return result(request, 10);
  };
  expect((await f.run()).chargedTokens).toBe(20);
  expect(attempts).toHaveLength(2);
  expect(new Set(attempts).size).toBe(2);
  expect(f.state().work[0]!.attempts).toHaveLength(2);
});
