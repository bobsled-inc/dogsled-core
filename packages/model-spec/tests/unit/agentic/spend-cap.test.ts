import { describe, expect, it, vi } from 'vitest';
import {
  AgenticAssignmentError,
  AgenticHostError,
  AgenticStateError,
  executeAgenticRun,
  formatAgenticError,
} from '../../../src/agentic/index.js';
import type {
  AgentExecutorRequest,
  AgenticRunProgress,
  AgenticUsage,
} from '../../../src/agentic/index.js';
import { createAgenticProgress } from '../../../src/agentic/progress.js';
import type { AgenticRunSnapshot } from '../../../src/agentic/state.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

const measured = {
  status: 'measured' as const,
  input_tokens: 600,
  output_tokens: 400,
  total_tokens: 1000,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function answer(request: AgentExecutorRequest, usage: AgenticUsage = measured) {
  return {
    contract_version: 2 as const,
    attempt_id: request.assignment.attempt_id,
    status: 'succeeded' as const,
    usage,
    rows: [
      {
        pair_id: request.assignment.group_key.pair_id,
        assessment: 'ok',
        _bobsled_evidence: null,
        _bobsled_confidence: null,
        _bobsled_reason: null,
      },
    ],
  };
}

function setup(count = 5) {
  const f = runFixture(count);
  const stateStore = new MemoryStateStore();
  const options = {
    projectDirectory: '/not-used',
    stateStore,
    run: { id: 'spend', mode: 'start' as const },
  };
  const state = () => [...stateStore.runs.values()][0]!;
  const resume = (extra: Record<string, unknown> = {}) =>
    executeAgenticRun(f.host, f.context(), {
      ...options,
      run: { id: 'spend', mode: 'resume' },
      ...extra,
    });
  return {
    ...f,
    options,
    state,
    resume,
    run: () => executeAgenticRun(f.host, f.context(), options),
  };
}

/** Ten US dollars per million tokens, input and output alike. */
const price = (_profile: unknown, usage: { input_tokens: number; output_tokens: number }) =>
  (usage.input_tokens + usage.output_tokens) / 100_000;

describe('spend-cap accounting', { timeout: 60_000 }, () => {
  it('stops dispatch at the token cap, keeps in-flight answers and resumes after the cap is raised', async () => {
    const f = setup(5);
    // Large answers keep the small input estimates far below the cap.
    const large = {
      status: 'measured' as const,
      input_tokens: 6000,
      output_tokens: 4000,
      total_tokens: 10_000,
    };
    f.model.limits.tokens = 10_400;
    f.host.concurrency = 3;
    const entered = Array.from({ length: 5 }, deferred);
    const gates = Array.from({ length: 5 }, deferred);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      const index = Number(request.assignment.shard_id);
      entered[index]!.resolve();
      await gates[index]!.promise;
      return answer(request, large);
    });
    const run = f.run();
    const outcome = expect(run).rejects.toThrow(AgenticStateError);
    await Promise.all(entered.slice(0, 3).map((item) => item.promise));
    // The first answer crosses the cap; the two calls already running still finish.
    for (const gate of gates.slice(0, 3)) gate.resolve();
    await outcome;
    const error = await run.catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('spend_cap_reached');
    expect(error.message).toContain('of 10,400 tokens (limits.tokens)');
    expect(error.message).toContain('3 of 5 assignments');
    expect(error.message).toContain('--agent-resume --agent-run-id spend');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
    expect(f.state().work.filter((work) => work.accepted)).toHaveLength(3);
    expect(f.state().work.flatMap((work) => work.attempts.map((a) => a.reservation))).toEqual([
      null,
      null,
      null,
    ]);

    // Raising the cap is allowed on resume and does not repeat accepted work.
    f.model.limits.tokens = 100_000;
    for (const gate of gates) gate.resolve();
    const result = await f.resume();
    expect(f.host.executeAgent).toHaveBeenCalledTimes(5);
    expect(result.rows).toHaveLength(5);
    expect(result.chargedTokens).toBe(50_000);
  });

  it('stops at a dollar cap, prices every finished attempt and resumes with a higher override', async () => {
    const f = setup(5);
    f.host.priceUsage = price;
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    const error = await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      maxCostUsd: 0.025,
    }).catch((caught: unknown) => caught as AgenticStateError);
    expect(error).toBeInstanceOf(AgenticStateError);
    expect(error.reason).toBe('spend_cap_reached');
    expect(error.message).toMatch(/spent \$0\.0300 of the \$0\.0250 cap \(limits\.max_cost_usd\)/);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
    expect(f.state().charged_microusd).toBe(30_000);

    const result = await f.resume({ maxCostUsd: 1 });
    expect(result.rows).toHaveLength(5);
    expect(result.chargedUsd).toBeCloseTo(0.05, 6);
  });

  it('refuses a cost cap without pricing before any model call', async () => {
    const f = setup(2);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    const error = await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      maxCostUsd: 5,
    }).catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('pricing_unknown');
    expect(error.message).toContain('profile "review" (openai/fake)');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    // Nothing is saved, so the run ID is not left behind half-started.
    expect(f.options.stateStore.runs.size).toBe(0);
  });

  it('checks a saved spend-cap run even when the caller asks for reservation accounting', async () => {
    const f = setup(2);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    await f.run();
    const before = structuredClone(f.state());
    const error = await f
      .resume({ accounting: 'reservation', maxCostUsd: 0.01 })
      .catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('pricing_unknown');
    expect(f.state()).toEqual(before);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  });

  it('checks saved legacy accounting before checking prices on resume', async () => {
    const f = setup(1);
    await executeAgenticRun(f.host, f.context(), { ...f.options, accounting: 'reservation' });
    const before = structuredClone(f.state());
    const error = await f
      .resume({ maxCostUsd: 0.01 })
      .catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('invalid_option');
    expect(f.state()).toEqual(before);
  });

  it('saves answers that finish while failure cleanup writes a checkpoint', async () => {
    const f = setup(3);
    f.host.concurrency = 3;
    const entered = Array.from({ length: 3 }, deferred);
    const gates = Array.from({ length: 3 }, deferred);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      const index = Number(request.assignment.shard_id);
      entered[index]!.resolve();
      await gates[index]!.promise;
      if (index === 0) {
        return {
          contract_version: 2,
          attempt_id: request.assignment.attempt_id,
          status: 'failed',
          usage: measured,
          error: { kind: 'internal', code: 'FAILED', retryable: false },
        };
      }
      return answer(request);
    });
    const acquire = f.options.stateStore.acquire.bind(f.options.stateStore);
    f.options.stateStore.acquire = async (key) => {
      const session = await acquire(key);
      return {
        ...session,
        checkpoint: async (command) => {
          if (command.type === 'finish_attempt' && command.work < 2) {
            gates[command.work + 1]!.resolve();
            // Let the next answer reach the scheduler while this write is pending.
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          return session.checkpoint(command);
        },
      };
    };
    const run = f.run();
    const rejected = expect(run).rejects.toThrow(AgenticAssignmentError);
    await Promise.all(entered.map((item) => item.promise));
    gates[0]!.resolve();
    await rejected;
    expect(f.state().work.map((work) => Boolean(work.accepted))).toEqual([false, true, true]);
    expect(f.state().work.map((work) => work.attempts[0]!.charge)).toEqual([1000, 1000, 1000]);
    expect(f.state().charged).toBe(3000);
  });

  it('refuses a batch whose input estimate alone exceeds the cap', async () => {
    const f = setup(5);
    f.model.limits.tokens = 50;
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    const error = await f.run().catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('estimate_exceeds_cap');
    expect(error.message).toContain('No model calls were made');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('charges unknown usage at the input estimate instead of the remaining budget', async () => {
    const f = setup(5);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) =>
      answer(request, { status: 'unknown', reason: 'unavailable' })
    );
    const result = await f.run();
    expect(result.rows).toHaveLength(5);
    const charges = f.state().work.map((work) => work.attempts[0]!.charge);
    expect(charges.every((charge) => charge > 0 && charge < 1000)).toBe(true);
    expect(result.chargedTokens).toBe(charges.reduce((sum, charge) => sum + charge, 0));
  });

  it('keeps usage from an executor that reserves less than it spends', async () => {
    const f = setup(2);
    f.model.limits.tokens_per_assignment = 1;
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      const receipt = await request.budget.reserve(10);
      await request.budget.settle(receipt, measured);
      return answer(request);
    });
    const result = await f.run();
    expect(result.rows).toHaveLength(2);
    expect(result.chargedTokens).toBe(2000);
  });

  it('retries invalid executor output and then names the assignment and the invalid field', async () => {
    const f = setup(1);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => ({
      ...answer(request),
      rows: [{ pair_id: request.assignment.group_key.pair_id, assessment: 5 }],
    }));
    const error = await f.run().catch((caught: unknown) => caught as AgenticAssignmentError);
    expect(error).toBeInstanceOf(AgenticAssignmentError);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(3);
    expect(error.message).toContain('Agentic step "assess" assignment 0 failed');
    expect(error.message).toContain('validation error "invalid_executor_output"');
    expect(error.message).toContain('3 of 3 attempts');
    expect(error.message).toContain('Output row does not match columns');
    expect(error.message).not.toContain('"assessment": 5');
  });

  it('accepts a saved answer that finishes after the deadline', async () => {
    const f = setup(1);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.state().deadline_at!) + 1);
      return answer(request);
    });
    // The deadline still stops later work, but the paid answer is kept.
    await f.run().catch(() => undefined);
    vi.restoreAllMocks();
    expect(f.state().work[0]!.accepted?.status).toBe('succeeded');
  });
});

describe('saved reservation runs', () => {
  it('resume with their original accounting even when the caller does not ask for it', async () => {
    const f = setup(2);
    f.host.executeAgent = vi.fn(async () => {
      throw new Error('interrupted');
    });
    await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      accounting: 'reservation',
    }).catch(() => undefined);
    expect(f.state().accounting).toBeUndefined();
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      const receipt = await request.budget.reserve(100);
      await request.budget.settle(receipt, {
        ...measured,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      });
      return answer(request, { ...measured, input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    });
    const result = await f.resume();
    expect(result.chargedUsd).toBeNull();
    expect(f.state().accounting).toBeUndefined();
    expect(f.state().work.every((work) => work.attempts.every((a) => a.reservation === 100))).toBe(
      true
    );
  });
});

describe('review fixes', { timeout: 60_000 }, () => {
  it('saves answers that finished before another assignment failed for good', async () => {
    const f = setup(2);
    f.host.concurrency = 2;
    const entered = [deferred(), deferred()];
    const gates = [deferred(), deferred()];
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      const index = Number(request.assignment.shard_id);
      entered[index]!.resolve();
      await gates[index]!.promise;
      if (index === 1) return answer(request);
      return {
        contract_version: 2 as const,
        attempt_id: request.assignment.attempt_id,
        status: 'failed' as const,
        usage: measured,
        error: { kind: 'auth' as const, code: 'AUTH_FAILED', retryable: false },
      };
    });
    const run = f.run();
    const outcome = expect(run).rejects.toThrow(AgenticAssignmentError);
    await Promise.all(entered.map((item) => item.promise));
    gates[0]!.resolve();
    gates[1]!.resolve();
    await outcome;
    expect(f.state().work[1]!.accepted?.status).toBe('succeeded');
  });

  it('refuses a cost cap on a run saved with reservation accounting', async () => {
    const f = setup(1);
    f.host.priceUsage = price;
    f.host.executeAgent = vi.fn(async () => {
      throw new Error('interrupted');
    });
    await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      accounting: 'reservation',
    }).catch(() => undefined);
    const error = await f
      .resume({ maxCostUsd: 5 })
      .catch((caught: unknown) => caught as AgenticStateError);
    expect(error.reason).toBe('invalid_option');
    expect(error.message).toContain('older token-reservation accounting');
  });
});

describe('assignment failure hints', () => {
  it('explain a loop that ran out of turns and how to raise the limit', () => {
    const error = new AgenticAssignmentError({
      step_id: 'research',
      shard_id: 'research:0',
      attempts: 1,
      max_attempts: 3,
      kind: 'validation',
      code: 'turn_limit',
      retryable: false,
    });
    expect(error.message).toContain('used all its turns without finishing');
    expect(error.message).toContain('maxTurns');
    expect(error.message).toContain('--agent-retry-failed');
  });
});

describe('progress reports', { timeout: 60_000 }, () => {
  it('include spend against the caps and the input still to process', async () => {
    const f = setup(3);
    f.host.priceUsage = price;
    const reports: AgenticRunProgress[] = [];
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      maxCostUsd: 1,
      onProgress: (progress) => {
        reports.push(progress);
      },
    });
    const first = reports.find((report) => report.total === 3 && report.accepted === 0)!;
    expect(first.remainingInputTokens).toBeGreaterThan(0);
    const last = reports.at(-1)!;
    expect(last.remainingInputTokens).toBe(0);
    expect(last.spend).toEqual({ tokens: 3000, usd: 0.03, tokenCap: 100000, usdCap: 1 });
  });

  it('estimate each assignment once and reuse it on later reports', async () => {
    const f = setup(3);
    let saved: AgenticRunSnapshot | undefined;
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => {
      saved ??= structuredClone(f.state());
      return answer(request);
    });
    await f.run();
    const steps = [...new Set(saved!.work.map((work) => work.assignment.step_id))];
    const cache = new Map<string, number>();
    const fresh = createAgenticProgress(saved!, steps, cache);
    const unstarted = saved!.work.filter((work) => !work.attempts.length).length;
    expect(unstarted).toBeGreaterThan(0);
    expect(cache.size).toBe(unstarted);
    expect(createAgenticProgress(saved!, steps).remainingInputTokens).toBe(
      fresh.remainingInputTokens
    );
    // A later report reads the cached values instead of measuring again.
    for (const key of cache.keys()) cache.set(key, 7);
    expect(createAgenticProgress(saved!, steps, cache).remainingInputTokens).toBe(7 * unstarted);
  });
});

describe('formatAgenticError', () => {
  it('prints safe causes and hides provider text behind its type and status', () => {
    const provider = Object.assign(new Error('401 for key sk-live-secret'), {
      name: 'APICallError',
      statusCode: 429,
    });
    const error = new AgenticHostError('Agentic executor failed for step "a" assignment 0.', {
      cause: provider,
    });
    const text = formatAgenticError(error);
    expect(text).toContain('Agentic executor failed for step "a" assignment 0.');
    expect(text).toContain('caused by: APICallError (status 429)');
    expect(text).not.toContain('sk-live-secret');
  });

  it('summarizes top-level validation errors by field without quoting data', async () => {
    const { z } = await import('zod');
    const result = z
      .object({ pair_id: z.literal('p1') })
      .safeParse({ pair_id: 'secret-row-value' });
    const text = formatAgenticError(result.error);
    expect(text).toContain('Agentic data failed validation: pair_id:');
    expect(text).not.toContain('secret-row-value');
  });

  it('shows system error codes for storage failures', () => {
    const disk = Object.assign(new Error('ENOSPC: no space left, write /home/user/x'), {
      code: 'ENOSPC',
    });
    const error = new AgenticStateError(
      'unavailable',
      { reason: 'state_write', message: 'Cannot save the local agentic checkpoint.' },
      { cause: disk }
    );
    const text = formatAgenticError(error);
    expect(text).toContain('Agentic state unavailable (state_write)');
    expect(text).toContain('caused by: Error (ENOSPC)');
    expect(text).not.toContain('/home/user');
  });
});

describe('invalid executor output detail', () => {
  it('does not echo executor-chosen keys or values', async () => {
    const f = setup(1);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => ({
      ...answer(request),
      'sk-live-secret': 'x',
    }));
    const error = await f.run().catch((caught: unknown) => caught as AgenticAssignmentError);
    expect(error).toBeInstanceOf(AgenticAssignmentError);
    expect(error.message).toContain('invalid_executor_output');
    expect(error.message).not.toContain('sk-live-secret');
  });
});

describe('auth failures', () => {
  it('stop after one unbilled attempt and point at the API key', async () => {
    const f = setup(2);
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => ({
      contract_version: 2 as const,
      attempt_id: request.assignment.attempt_id,
      status: 'failed' as const,
      usage: { status: 'measured' as const, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      error: { kind: 'auth' as const, code: 'auth_failed', retryable: false },
    }));
    const error = await f.run().catch((caught: unknown) => caught as AgenticAssignmentError);
    expect(error).toBeInstanceOf(AgenticAssignmentError);
    expect(error.message).toContain('auth error "auth_failed" after 1 of 3 attempts');
    expect(error.message).toContain('Check the API key');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    expect(f.state().charged).toBe(0);
  });
});

describe('cancellation with an instant executor', { timeout: 60_000 }, () => {
  it('still lets timers and signals run, so the run can be stopped', async () => {
    const f = setup(300);
    f.model.limits.tokens = null;
    f.host.executeAgent = vi.fn(async (request: AgentExecutorRequest) => answer(request));
    const controller = new AbortController();
    // A timer can only fire if the scheduler gives way to the event loop.
    setTimeout(() => controller.abort(), 20);
    await expect(
      executeAgenticRun(f.host, f.context(), { ...f.options, signal: controller.signal })
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(f.state().work.filter((work) => work.accepted).length).toBeLessThan(300);
  });
});
