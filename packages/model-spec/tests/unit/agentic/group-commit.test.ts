import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  AgenticAssignmentError,
  AgenticStateError,
  executeAgenticRun,
} from '../../../src/agentic/index.js';
import type {
  AgentExecutorRequest,
  AgenticRunProgress,
  AgenticUsage,
} from '../../../src/agentic/index.js';
import { validateAgenticReceipts } from '../../../src/agentic/checkpoint-receipt.js';
import { createAgenticProgress } from '../../../src/agentic/progress.js';
import {
  applyAgenticCheckpoint,
  digestAgenticState,
  type AgenticCheckpointCommand,
  type AgenticRunKey,
  type AgenticRunSnapshot,
  type AgenticStateStore,
} from '../../../src/agentic/state.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import { benchmarkWorkload, sharedGroupStore } from '../../support/agentic-benchmark.js';
import { parseVerifiedCheckpoint } from '../../../src/agentic/checkpoint-verified.js';
import { mapScenario } from '../../support/agentic-store-scenario.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

type Fault = 'refuse' | 'lose_reply' | 'save_first_only';

/**
 * The in-memory store with a group commit: all of a group or none of it, as the row store saves
 * it. Each save is recorded as the command types it held, in order.
 */
class GroupMemoryStore extends MemoryStateStore {
  /** Without groups, the same store and faults for one command at a time. */
  constructor(readonly groups = true) {
    super();
  }
  saves: AgenticCheckpointCommand['type'][][] = [];
  faults: Fault[] = [];
  /** Refuses single starts with this error, as a store whose clock passed the deadline would. */
  refuseSingleStart?: AgenticStateError;
  /** Reply with copies, as a store that parses its state would, rather than the frozen state. */
  copies = false;
  override async acquire(key: AgenticRunKey) {
    const session = await super.acquire(key);
    const id = digestAgenticState(key);
    const grouped = {
      ...session,
      checkpoint: async (command: AgenticCheckpointCommand) => {
        if (command.type === 'start_attempt' && this.refuseSingleStart) {
          throw this.refuseSingleStart;
        }
        const saved = await session.checkpoint(command);
        this.saves.push([command.type]);
        return saved;
      },
      checkpointMany: async (commands: readonly AgenticCheckpointCommand[]) => {
        const fault = this.faults.shift();
        if (fault === 'refuse') throw new AgenticStateError('unavailable');
        let state = this.runs.get(id)!;
        for (const command of fault === 'save_first_only' ? commands.slice(0, 1) : commands) {
          state = applyAgenticCheckpoint(state, command);
        }
        this.runs.set(id, state);
        this.saves.push(commands.map((command) => command.type));
        if (fault === 'lose_reply') throw new Error('Synthetic lost reply');
        return this.copies ? structuredClone(state) : state;
      },
    };
    if (this.groups) return grouped;
    const { checkpointMany: _, ...alone } = grouped;
    return alone;
  }
}

const usage = { status: 'measured' as const, input_tokens: 1, output_tokens: 1, total_tokens: 2 };
function answer(request: AgentExecutorRequest, measured: AgenticUsage = usage) {
  return {
    contract_version: 2 as const,
    attempt_id: request.assignment.attempt_id,
    status: 'succeeded' as const,
    usage: measured,
    rows: [],
  };
}

function setup(count: number, concurrency: number, stateStore = new GroupMemoryStore()) {
  const f = runFixture(count);
  f.host.concurrency = concurrency;
  const options = {
    projectDirectory: '/not-used',
    stateStore,
    run: { id: 'grouped', mode: 'start' as const },
  };
  const state = () => [...stateStore.runs.values()][0]!;
  return {
    ...f,
    stateStore,
    options,
    state,
    run: (extra: Record<string, unknown> = {}) =>
      executeAgenticRun(f.host, f.context(), { ...options, ...extra }),
  };
}

/** What a run decided, without the attempt IDs and times that differ from run to run. */
const outcome = (snapshot: AgenticRunSnapshot) => ({
  revision: snapshot.revision,
  status: snapshot.status,
  charged: snapshot.charged,
  charged_microusd: snapshot.charged_microusd,
  work: snapshot.work.map((work) => ({
    attempts: work.attempts.map((attempt) => ({
      charge: attempt.charge,
      status: attempt.outcome?.status ?? null,
    })),
    accepted: work.accepted?.status ?? null,
  })),
});

/** Calls that return after a short, uneven wait, so that they finish out of order. */
const uneven = (request: AgentExecutorRequest) =>
  delay(1 + ((Number(request.assignment.shard_id) * 7) % 5)).then(() => answer(request));

// These runs validate many checkpoints. Shared CI runners need more time.
describe('group commit', { timeout: 60_000 }, () => {
  it('saves each start before its call and commits waiting commands together', async () => {
    const f = setup(12, 3);
    let calls = 0;
    f.host.executeAgent = async (request) => {
      calls++;
      // The start is durable before the call, as it is one command at a time.
      const work = f.state().work[Number(request.assignment.shard_id)]!;
      expect(work.attempts.map((attempt) => attempt.id)).toContain(request.assignment.attempt_id);
      return uneven(request);
    };
    const result = await f.run();
    expect(calls).toBe(12);
    expect(result.processedKeys).toHaveLength(12);
    const grouped = f.stateStore.saves.filter((save) => save.length > 1);
    expect(grouped.length).toBeGreaterThan(0);
    // Two commands per call, in fewer saves than commands.
    const attemptCommands = f.stateStore.saves
      .flat()
      .filter((type) => type === 'start_attempt' || type === 'finish_attempt');
    expect(attemptCommands).toHaveLength(24);
    expect(f.stateStore.saves.length).toBeLessThan(24);
    // A group holds finishes first, so that its starts see what they charged.
    for (const save of grouped) {
      const firstStart = save.indexOf('start_attempt');
      if (firstStart !== -1) expect(save.slice(firstStart)).not.toContain('finish_attempt');
    }
  });

  it('decides a run exactly as one command at a time does', async () => {
    const single = setup(12, 3, new GroupMemoryStore(false));
    const grouped = setup(12, 3);
    single.host.executeAgent = uneven;
    grouped.host.executeAgent = uneven;
    const before = await single.run();
    const after = await grouped.run();
    expect(after.processedKeys).toEqual(before.processedKeys);
    expect(after.chargedTokens).toBe(before.chargedTokens);
    expect(outcome(grouped.state())).toEqual(outcome(single.state()));
  });

  it('runs a map then reduce plan the same way', async () => {
    const run = async (stateStore: GroupMemoryStore) => {
      const workload = benchmarkWorkload(10, 'plan');
      workload.host.concurrency = 4;
      const result = await executeAgenticRun(workload.host, workload.context(), {
        projectDirectory: '/not-used',
        stateStore,
        run: { id: 'plan', mode: 'start' },
      });
      return { result, snapshot: [...stateStore.runs.values()][0]! };
    };
    const store = new GroupMemoryStore();
    const before = await run(new GroupMemoryStore(false));
    const after = await run(store);
    // Each run reads its inputs at its own time; everything else must match.
    const rows = (result: typeof before.result) =>
      JSON.parse(
        JSON.stringify(result.rows).replace(/"retrieved_at":"[^"]*"/g, '"retrieved_at":""')
      );
    expect(rows(after.result)).toEqual(rows(before.result));
    expect(outcome(after.snapshot)).toEqual(outcome(before.snapshot));
    expect(store.saves.some((save) => save.length > 1)).toBe(true);
  });

  it('validates replies that are copies of the saved state', async () => {
    const f = setup(8, 4);
    f.stateStore.copies = true;
    f.host.executeAgent = uneven;
    expect((await f.run()).processedKeys).toHaveLength(8);
    expect(f.stateStore.saves.some((save) => save.length > 1)).toBe(true);
  });

  it('sends a group one command at a time when the store saves none of it', async () => {
    const f = setup(6, 3);
    f.stateStore.faults = ['refuse'];
    let calls = 0;
    f.host.executeAgent = async (request) => {
      calls++;
      return uneven(request);
    };
    expect((await f.run()).processedKeys).toHaveLength(6);
    expect(calls).toBe(6);
    // The refused group of three starts went again as three single commands.
    expect(f.stateStore.saves[2]).toEqual(['start_attempt']);
    expect(f.state().status).toBe('execution_complete');
  });

  it('continues from a saved group whose reply was lost, without repeating a call', async () => {
    const f = setup(6, 3);
    f.stateStore.faults = ['lose_reply', 'lose_reply'];
    let calls = 0;
    f.host.executeAgent = async (request) => {
      calls++;
      return uneven(request);
    };
    expect((await f.run()).processedKeys).toHaveLength(6);
    expect(calls).toBe(6);
    expect(f.state().work.every((work) => work.attempts.length === 1)).toBe(true);
  });

  it('decides a group the store refuses as one command at a time decides it', async () => {
    // Once three calls have returned, the store refuses groups and single starts alike. How many
    // more calls return before the run stops depends on timing, so only those three are compared.
    const run = async (stateStore: GroupMemoryStore) => {
      const f = setup(6, 3, stateStore);
      const returned: string[] = [];
      f.host.executeAgent = async (request) => {
        const result = await uneven(request);
        returned.push(request.assignment.attempt_id);
        if (returned.length === 3) {
          stateStore.faults = Array.from({ length: 10 }, () => 'refuse' as const);
          stateStore.refuseSingleStart = new AgenticStateError('unavailable');
        }
        return result;
      };
      const error = await f.run().catch((caught: unknown) => caught);
      const saved = new Set(
        f
          .state()
          .work.flatMap((work) => work.attempts.filter((attempt) => attempt.outcome))
          .map((attempt) => attempt.id)
      );
      return { error, firstThreeSaved: returned.slice(0, 3).every((id) => saved.has(id)) };
    };
    const single = await run(new GroupMemoryStore(false));
    const grouped = await run(new GroupMemoryStore());
    // The store refused a start it should have taken: both report what one command reports.
    expect(grouped.error).toMatchObject({ code: (single.error as AgenticStateError).code });
    // The answers that returned first were saved, one at a time after the group was refused.
    expect(single.firstThreeSaved).toBe(true);
    expect(grouped.firstThreeSaved).toBe(true);
  });

  it('stops when an executor throws and still saves the answers that returned', async () => {
    const run = async (stateStore: GroupMemoryStore) => {
      const f = setup(6, 3, stateStore);
      f.host.executeAgent = async (request) => {
        if (request.assignment.shard_id === '1') {
          await delay(5);
          throw new Error('Synthetic executor failure');
        }
        return answer(request);
      };
      const error = await f.run().catch((caught: unknown) => caught);
      return { error, snapshot: f.state() };
    };
    const single = await run(new GroupMemoryStore(false));
    const grouped = await run(new GroupMemoryStore());
    expect((grouped.error as Error).message).toBe((single.error as Error).message);
    expect(grouped.snapshot.work[1]!.accepted).toBeUndefined();
    expect(grouped.snapshot.work[0]!.accepted?.status).toBe('succeeded');
    expect(grouped.snapshot.work[2]!.accepted?.status).toBe('succeeded');
  });

  it('stops as corrupt when a store saves part of a group', async () => {
    const f = setup(6, 3);
    f.stateStore.faults = ['save_first_only'];
    f.host.executeAgent = uneven;
    await expect(f.run()).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('makes no call once a terminal failure has returned', async () => {
    const f = setup(9, 3);
    const calls: { shard: string; at: number }[] = [];
    let failedAt = Infinity;
    f.host.executeAgent = async (request) => {
      const shard = request.assignment.shard_id;
      calls.push({ shard, at: performance.now() });
      if (shard === '1') {
        // Later than the calls that started with it, so it fails while they run.
        await delay(10);
        failedAt = performance.now();
        return {
          contract_version: 2 as const,
          attempt_id: request.assignment.attempt_id,
          status: 'failed' as const,
          usage,
          error: { kind: 'provider' as const, code: 'bad_request', retryable: false },
        };
      }
      await delay(200, undefined, { signal: request.signal });
      return answer(request);
    };
    const error = await f.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgenticAssignmentError);
    expect(calls.map((call) => call.shard)).toEqual(['0', '1', '2']);
    expect(calls.filter((call) => call.at > failedAt)).toEqual([]);
    expect(f.state().work[1]!.attempts.at(-1)?.outcome?.status).toBe('failed');
  });

  it('retries a retryable failure in the group that saves it', async () => {
    const f = setup(4, 2);
    let failures = 0;
    f.host.executeAgent = async (request) => {
      if (request.assignment.shard_id === '0' && failures++ === 0) {
        return {
          contract_version: 2 as const,
          attempt_id: request.assignment.attempt_id,
          status: 'failed' as const,
          usage,
          error: { kind: 'provider' as const, code: 'rate_limited', retryable: true },
        };
      }
      return uneven(request);
    };
    expect((await f.run()).processedKeys).toHaveLength(4);
    expect(f.state().work[0]!.attempts).toHaveLength(2);
    expect(f.state().work[0]!.accepted?.status).toBe('succeeded');
  });

  it('keeps the interval between calls, one start per save', async () => {
    const f = setup(5, 3);
    f.host.minDispatchIntervalMs = 30;
    const started: number[] = [];
    f.host.executeAgent = async (request) => {
      started.push(performance.now());
      return answer(request);
    };
    await f.run();
    for (let index = 1; index < started.length; index++) {
      expect(started[index]! - started[index - 1]!).toBeGreaterThanOrEqual(29);
    }
    for (const save of f.stateStore.saves) {
      expect(save.filter((type) => type === 'start_attempt').length).toBeLessThanOrEqual(1);
    }
  });

  it('stops at the spend cap and keeps every answer that was paid for', async () => {
    const large = {
      status: 'measured' as const,
      input_tokens: 6000,
      output_tokens: 4000,
      total_tokens: 10_000,
    };
    // How many calls start before the first answer lands depends on timing, in either mode, so
    // each mode is held to the rule rather than to the other's count.
    const run = async (stateStore: GroupMemoryStore) => {
      const f = setup(5, 3, stateStore);
      f.model.limits.tokens = 10_400;
      let calls = 0;
      f.host.executeAgent = async (request) => {
        calls++;
        await delay(5);
        return answer(request, large);
      };
      const error = await f.run().catch((caught: unknown) => caught);
      return { error, calls, snapshot: f.state() };
    };
    for (const result of [
      await run(new GroupMemoryStore(false)),
      await run(new GroupMemoryStore()),
    ]) {
      expect(result.error).toMatchObject({ code: 'limit', reason: 'spend_cap_reached' });
      // The cap stops new calls; the ones in flight finish and their answers are kept.
      const started = result.snapshot.work.filter((work) => work.attempts.length);
      expect(started.length).toBe(result.calls);
      expect(started.every((work) => work.accepted?.status === 'succeeded')).toBe(true);
      expect(result.calls).toBeGreaterThanOrEqual(1);
      expect(result.calls).toBeLessThanOrEqual(3);
    }
  });

  it('reports progress after each group with the counts a fresh count gives', async () => {
    const f = setup(9, 3);
    f.host.executeAgent = uneven;
    const reports: AgenticRunProgress[] = [];
    await f.run({ onProgress: (progress: AgenticRunProgress) => void reports.push(progress) });
    const final = reports.at(-1)!;
    expect(final).toEqual(createAgenticProgress(f.state(), ['assess']));
    expect(final.accepted).toBe(9);
    for (const report of reports) {
      expect(report.accepted + report.running + report.pending + report.failed).toBe(report.total);
    }
  });

  it('groups the commands of a run past the default limits on a store that holds it', async () => {
    const base = sharedGroupStore();
    const sizes: number[] = [];
    const stateStore: AgenticStateStore = {
      limits: base.limits!,
      async acquire(key) {
        const session = await base.acquire(key);
        return {
          ...session,
          checkpointMany: async (commands) => {
            sizes.push(commands.length);
            return session.checkpointMany!(commands);
          },
        };
      },
    };
    const count = AGENTIC_DEFAULT_STORE_LIMITS.maxRows + 1;
    const f = runFixture(count);
    // No token cap, which this many assignments would pass before the first call.
    f.model.limits = {};
    f.host.concurrency = 3;
    f.host.executeAgent = async (request) => answer(request);
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/not-used',
      stateStore,
      run: { id: 'wide', mode: 'start' },
    });
    expect(result.processedKeys).toHaveLength(count);
    // Worked out within the default limits instead, every command would go alone.
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(count);
  });
});

describe('group receipts', () => {
  /** A recorded map run, up to its first start, and its next three attempt commands. */
  async function group() {
    const scenario = await mapScenario(3);
    const first = scenario.commands.findIndex((command) => command.type === 'start_attempt');
    let before = parseVerifiedCheckpoint(scenario.initial);
    for (const command of scenario.commands.slice(0, first)) {
      before = applyAgenticCheckpoint(before, command);
    }
    const commands = scenario.commands.slice(first, first + 3);
    expect(commands.map((command) => command.type)).toEqual([
      'start_attempt',
      'finish_attempt',
      'start_attempt',
    ]);
    const requestedAt = Date.now();
    let after = before;
    for (const command of commands) after = applyAgenticCheckpoint(after, command);
    return { before, commands, requestedAt, after };
  }

  it('accepts the state its commands produce in order, shared or copied', async () => {
    const { before, commands, requestedAt, after } = await group();
    expect(validateAgenticReceipts(after, before, commands, requestedAt)).toBe(after);
    const copy = structuredClone(after);
    expect(validateAgenticReceipts(copy, before, commands, requestedAt)).toEqual(after);
  });

  it('refuses a reply that holds only some of the commands', async () => {
    const { before, commands, requestedAt } = await group();
    const partial = applyAgenticCheckpoint(before, commands[0]!);
    expect(() => validateAgenticReceipts(partial, before, commands, requestedAt)).toThrow(
      expect.objectContaining({ code: 'corrupt' })
    );
    expect(() => validateAgenticReceipts(before, before, commands, requestedAt)).toThrow(
      expect.objectContaining({ code: 'corrupt' })
    );
  });

  it('refuses a finish the store dates before the request', async () => {
    const { before, commands, after } = await group();
    expect(() => validateAgenticReceipts(after, before, commands, Date.now() + 60_000)).toThrow(
      expect.objectContaining({ code: 'corrupt' })
    );
  });

  it('refuses a reply to commands the transition rejects, as for one command', async () => {
    const { before, commands, requestedAt } = await group();
    const stale = commands.map((command, index) =>
      index === 2 ? { ...command, expected_revision: before.revision } : command
    );
    // A finish the reply does not date cannot be proved, as with one command.
    expect(() => validateAgenticReceipts(before, before, stale, requestedAt)).toThrow(
      expect.objectContaining({ code: 'corrupt' })
    );
    expect(() =>
      validateAgenticReceipts(before, before, [stale[0]!, stale[2]!], requestedAt)
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});
