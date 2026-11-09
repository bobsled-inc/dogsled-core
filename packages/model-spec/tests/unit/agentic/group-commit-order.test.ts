import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { parseVerifiedCheckpoint } from '../../../src/agentic/checkpoint-verified.js';
import { scheduleAgenticAssignments } from '../../../src/agentic/schedule.js';
import {
  applyAgenticCheckpoint,
  type AgenticCheckpointCommand,
  type AgenticRunSnapshot,
} from '../../../src/agentic/state.js';
import { mapScenario } from '../../support/agentic-store-scenario.js';
import { runFixture } from './state-fixture.js';

// Apart from a clock past the deadline, the transition refuses a start that passed the
// scheduler's own checks only when its attempt ID is already in the run. Repeating an ID on
// demand puts that refusal exactly where this test needs it.
const ids = vi.hoisted(() => ({ repeatAfter: 0, last: '' }));
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomUUID: () => {
      if (ids.repeatAfter > 0 && --ids.repeatAfter === 0) return ids.last;
      return (ids.last = crypto.randomUUID());
    },
  };
});

describe('group commit order', () => {
  it('makes the calls of a saved group before a start that goes alone', async () => {
    const scenario = await mapScenario(3);
    const first = scenario.commands.findIndex((command) => command.type === 'start_attempt');
    let saved = parseVerifiedCheckpoint(scenario.initial);
    for (const command of scenario.commands.slice(0, first)) {
      saved = applyAgenticCheckpoint(saved, command);
    }
    const sealed = saved;
    const { host } = runFixture(3);
    const called: string[] = [];
    let started!: () => void;
    const callStarted = new Promise<void>((resolve) => (started = resolve));
    host.executeAgent = async (request) => {
      called.push(request.assignment.shard_id);
      started();
      // In flight until the run stops.
      await delay(60_000, undefined, { signal: request.signal });
      throw new Error('The run should have stopped this call');
    };
    const checkpoint = async (command: AgenticCheckpointCommand): Promise<AgenticRunSnapshot> => {
      // The store refuses the lone start only once a call has started, or after two seconds,
      // so the order is what decides whether the group's call was made.
      if (command.type === 'start_attempt' && command.work === 1) {
        await Promise.race([callStarted, delay(2_000)]);
      }
      return (saved = applyAgenticCheckpoint(saved, command));
    };
    const checkpointGroup = async (commands: AgenticCheckpointCommand[]) => {
      let next = saved;
      for (const command of commands) next = applyAgenticCheckpoint(next, command);
      return (saved = next);
    };
    const controller = new AbortController();
    // The second start of the first group repeats the first one's ID, so it goes alone.
    ids.repeatAfter = 2;
    const run = scheduleAgenticAssignments(host, {
      snapshot: sealed,
      checkpoint,
      checkpointGroup,
      signal: controller.signal,
      abort: () => controller.abort(),
      concurrency: 2,
      minDispatchIntervalMs: 0,
    });
    await expect(run).rejects.toMatchObject({ code: 'conflict' });
    // The saved start of work 0 was made, as one command at a time makes it before the next
    // start, and the refusal stopped the run with that call in flight.
    expect(called).toEqual(['0']);
    expect(saved.work[0]!.attempts).toHaveLength(1);
    expect(saved.work[1]!.attempts).toHaveLength(0);
  }, 30_000);
});
