import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { createLocalAgenticCursorStore } from '../../../src/agentic/local-cursors.js';
import {
  AGENTIC_MAX_CHECKPOINT_BYTES,
  AGENTIC_MAX_CHECKPOINT_VALUES,
  measureCheckpoint,
} from '../../../src/agentic/checkpoint-json.js';
import {
  advanceVerifiedCheckpoint,
  checkpointJsonBytes,
  isVerifiedCheckpoint,
} from '../../../src/agentic/checkpoint-verified.js';
import { validateAgenticReceipt } from '../../../src/agentic/checkpoint-receipt.js';
import { buildAgenticStepAssignments } from '../../../src/agentic/plan-work.js';
import { resolveAgenticModel } from '../../../src/agentic/resolve.js';
import {
  AgenticRunSnapshotSchema,
  AgenticStateError,
  applyAgenticCheckpoint,
} from '../../../src/agentic/state.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../../src/agentic/state.js';
import { benchmarkWorkload, sharedMemoryStore } from '../../support/agentic-benchmark.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

type Accounting = 'spend_cap' | 'reservation';
type Verdict = { value: AgenticRunSnapshot } | { error: string };
type Outcome = Extract<AgenticCheckpointCommand, { type: 'finish_attempt' }>['outcome'];

const isAttempt = (command: AgenticCheckpointCommand) =>
  command.type === 'start_attempt' || command.type === 'finish_attempt';

const verdict = (run: () => AgenticRunSnapshot): Verdict => {
  try {
    return { value: run() };
  } catch (error) {
    const detail = error instanceof AgenticStateError ? `${error.code}/${error.reason}` : '';
    return { error: `${(error as Error).name} ${detail} ${(error as Error).message}` };
  }
};

/** A copy is never verified state, so this is always the complete path. */
const complete = (state: AgenticRunSnapshot, command: AgenticCheckpointCommand, now: number) =>
  verdict(() => applyAgenticCheckpoint(structuredClone(state), command, now));

/** The sealed state of a real run, before its first attempt. */
async function sealedRun(f: {
  host: Parameters<typeof executeAgenticRun>[0];
  context: () => Parameters<typeof executeAgenticRun>[1];
  accounting: Accounting;
}): Promise<AgenticRunSnapshot> {
  const memory = new MemoryStateStore();
  const store: AgenticStateStore = {
    async acquire(key) {
      const session = await memory.acquire(key);
      return {
        ...session,
        checkpoint: (command) =>
          command.type === 'start_attempt'
            ? Promise.reject(new AgenticStateError('conflict'))
            : session.checkpoint(command),
      };
    },
  };
  await executeAgenticRun(f.host, f.context(), {
    projectDirectory: '/unused',
    stateStore: store,
    run: { id: 'walk', mode: 'start' },
    accounting: f.accounting,
  }).catch(() => undefined);
  return [...memory.runs.values()][0]!;
}

function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    below: (limit: number) => Math.floor(next() * limit),
    chance: (share: number) => next() < share,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

/** A valid output row for one key of `work`, whatever columns its step declares. */
function row(work: AgenticRunSnapshot['work'][number], key: Record<string, unknown>) {
  const input = work.assignment.input.rows[0] as Record<string, unknown>;
  const columns = work.assignment.output.columns.map(({ name }) => [
    name,
    key[name] ?? input[name] ?? 'A result.',
  ]);
  return {
    ...Object.fromEntries(columns),
    _dogsled_evidence: null,
    _dogsled_confidence: null,
    _dogsled_reason: null,
  };
}

/** Mostly commands a coordinator sends, mixed with every way one can be wrong. */
function nextCommand(
  state: AgenticRunSnapshot,
  rng: ReturnType<typeof random>,
  sent: AgenticCheckpointCommand[],
  id: () => string
): AgenticCheckpointCommand {
  const spendCap = state.accounting === 'spend_cap';
  const expected_revision = state.revision;
  const open = state.work.flatMap((work, index) => {
    const last = work.attempts.at(-1);
    return last && !last.outcome ? [{ index, work, last }] : [];
  });
  const idle = state.work.flatMap((work, index) =>
    work.accepted || open.some((item) => item.index === index) ? [] : [index]
  );
  const start = (work: number, attempt = id()) => ({
    type: 'start_attempt' as const,
    operation_id: `start_attempt:${attempt}`,
    expected_revision,
    work,
    attempt_id: attempt,
    ...(spendCap ? { charge: rng.below(40), charge_microusd: rng.below(400) } : {}),
  });
  const finish = (index: number, attempt: string, outcome: Partial<Outcome> = {}) => {
    const target = state.work[index]!;
    const usage = rng.chance(0.2)
      ? ({ status: 'unknown', reason: 'unavailable' } as const)
      : ({ status: 'measured', input_tokens: 4, output_tokens: 3, total_tokens: 7 } as const);
    const reservation = target.attempts.at(-1)?.reservation ?? 0;
    const base: Outcome = rng.chance(0.25)
      ? {
          contract_version: 2,
          attempt_id: attempt,
          status: 'failed',
          error: { kind: 'provider', code: 'busy', retryable: rng.chance(0.6) },
          usage,
        }
      : {
          contract_version: 2,
          attempt_id: attempt,
          status: 'succeeded',
          usage,
          rows: target.assignment.processed_keys.map((key) => row(target, key)),
        };
    return {
      type: 'finish_attempt' as const,
      operation_id: `finish_attempt:${attempt}`,
      expected_revision,
      work: index,
      attempt_id: attempt,
      outcome: { ...base, ...outcome } as Outcome,
      charge: rng.chance(0.02) ? reservation + 1 : rng.pick([7, 7, 7, 20, reservation]),
      ...(spendCap ? { charge_microusd: rng.below(500) } : {}),
    };
  };
  const held = state.work.flatMap((work) => work.attempts).map((item) => item.id);
  const heldId = held.length ? rng.pick(held) : undefined;
  const options: (() => AgenticCheckpointCommand | undefined)[] = [
    // What a coordinator sends.
    ...Array.from({ length: 5 }, () => () => {
      const index = idle.length ? rng.pick(idle) : undefined;
      return index === undefined ? undefined : start(index);
    }),
    ...Array.from({ length: 6 }, () => () => {
      const item = open.length ? rng.pick(open) : undefined;
      return item && finish(item.index, item.last.id);
    }),
    // A terminal failure stays blocked until a window allows a retry, so this keeps asking.
    ...Array.from({ length: 4 }, () => () => {
      const blocked = idle.filter((index) => {
        const outcome = state.work[index]!.attempts.at(-1)?.outcome;
        return outcome?.status === 'failed' && !outcome.error.retryable;
      });
      return blocked.length ? start(rng.pick(blocked)) : undefined;
    }),
    // Attempts that must be refused.
    () => heldId && start(rng.below(state.work.length), heldId),
    () => ({ ...start(rng.below(state.work.length)), expected_revision: state.revision - 1 }),
    () => start(state.work.length + rng.below(3)),
    () => ({ ...start(rng.below(state.work.length)), operation_id: 'start_attempt:other' }),
    () => ({ ...start(rng.below(state.work.length)), charge: 5 }),
    () => ({ ...start(rng.below(state.work.length)), charge: Number.MAX_SAFE_INTEGER }),
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      return item && finish(item.index, item.last.id, { attempt_id: 'someone-else' });
    },
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      return item && { ...finish(item.index, item.last.id), charge: 0 };
    },
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      return item && { ...finish(item.index, item.last.id), charge: Number.MAX_SAFE_INTEGER };
    },
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      if (!item || !spendCap) return undefined;
      return { ...finish(item.index, item.last.id), charge_microusd: Number.MAX_SAFE_INTEGER };
    },
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      if (!item) return undefined;
      const rows = [row(item.work, { pair_id: 'outside' })];
      return finish(item.index, item.last.id, { status: 'succeeded', rows } as Partial<Outcome>);
    },
    () => {
      const item = open.length ? rng.pick(open) : undefined;
      if (!item) return undefined;
      const rows = [{ pair_id: 'p0' }];
      return finish(item.index, item.last.id, { status: 'succeeded', rows } as Partial<Outcome>);
    },
    () => finish(rng.below(state.work.length), 'not-started'),
    // Repeats, exact and altered.
    () => (sent.length ? rng.pick(sent) : undefined),
    () => {
      const earlier = sent.filter((command) => command.type === 'finish_attempt');
      return earlier.length ? { ...rng.pick(earlier), charge: 999 } : undefined;
    },
    // Commands that always take the complete path, so walks cross between the two.
    () => ({
      type: 'begin_execution' as const,
      operation_id: id(),
      expected_revision,
      started_at: new Date(Date.now()).toISOString(),
      ...(rng.chance(0.7) ? { retry_failed: true as const } : {}),
      ...(spendCap ? { token_limit: state.token_limit, cost_limit_microusd: null } : {}),
    }),
    () => ({ type: 'complete', operation_id: 'complete', expected_revision }),
    () => {
      const index = state.sealed_steps?.length ?? 0;
      if (!state.plan_inputs || index === 0) return undefined;
      const { resolved } = state.definition as { resolved: { steps: { step: { id: string } }[] } };
      const step = resolved.steps[index]?.step.id;
      if (!step) return undefined;
      try {
        return {
          type: 'append_step' as const,
          operation_id: `append_step:${step}`,
          expected_revision,
          step_id: step,
          assignments: buildAgenticStepAssignments(state, index),
        };
      } catch {
        return undefined;
      }
    },
  ];
  for (;;) {
    const command = rng.pick(options)();
    if (command) return command;
  }
}

/** Seeds differ in budget: tight or loose caps, and for reservations shared or per assignment. */
function workload(shape: 'map' | 'plan', accounting: Accounting, seed: number) {
  const w = benchmarkWorkload(shape === 'plan' ? 5 : 6, shape, 1000);
  if (shape === 'map') {
    w.model.plan.steps[0]!.columns = [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'assessment', type: 'string', nullable: false },
    ];
  }
  w.model.limits = { tokens: seed % 3 === 0 ? 60 : 5000, timeout_seconds: 600 };
  if (seed % 2 === 0) delete w.host.tokensPerAssignment;
  return {
    ...w,
    accounting,
    context: () => ({ ...w.context(), resolved: resolveAgenticModel(w.model, w.host) }),
  };
}

describe('verified checkpoint walks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['map', 'spend_cap'],
    ['map', 'reservation'],
    ['plan', 'spend_cap'],
    ['plan', 'reservation'],
  ] as const)(
    'agrees with the complete path on every command: %s, %s',
    async (shape, accounting) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      const counters = { validations: 0 };
      const seen: Record<string, number> = {};
      const reasons = new Set<string>();
      for (let seed = 1; seed <= 16; seed++) {
        const rng = random(seed);
        const f = workload(shape, accounting, seed);
        let state = await sealedRun(f);
        let sequence = 0;
        const id = () => `attempt-${seed}-${sequence++}`;
        const sent: AgenticCheckpointCommand[] = [];
        for (let step = 0; step < 70; step++) {
          vi.setSystemTime(Date.now() + rng.below(3) * 1000);
          // Runs out the deadline now and then, so late finishes and refused starts come up.
          if (rng.chance(0.005)) vi.setSystemTime(Date.now() + 700_000);
          // A clock can step back past the newest saved time. Both paths must then refuse.
          if (rng.chance(0.03)) vi.setSystemTime(Date.now() - 3000);
          const command = nextCommand(state, rng, sent, id);
          // An applied time in the future is refused by the complete check on its own.
          const now = Date.now() + (rng.chance(0.03) ? 60_000 : 0);
          const expected = complete(state, command, now);
          counters.validations = 0;
          const restore = countSnapshotValidations(counters);
          const actual = verdict(() => applyAgenticCheckpoint(state, command, now));
          restore();
          expect(actual).toEqual(expected);
          if (!('value' in actual)) {
            seen[`refused ${command.type}`] = (seen[`refused ${command.type}`] ?? 0) + 1;
            reasons.add(/^\w+ (\w+\/\w+)/.exec(actual.error)?.[1] ?? 'schema');
            continue;
          }
          seen[`applied ${command.type}`] = (seen[`applied ${command.type}`] ?? 0) + 1;
          if (command.type === 'finish_attempt') {
            const status = `finished ${command.outcome.status}`;
            seen[status] = (seen[status] ?? 0) + 1;
          }
          if (command.type === 'start_attempt' && actual.value.revision !== state.revision) {
            const previous = actual.value.work[command.work]!.attempts.at(-2)?.outcome;
            if (previous?.status === 'failed') {
              const retry = previous.error.retryable ? 'retried' : 'retried a terminal failure';
              seen[retry] = (seen[retry] ?? 0) + 1;
            }
          }
          // A valid result the proof could not reach would still be right, only slow.
          if (isAttempt(command) && isVerifiedCheckpoint(state)) {
            expect(counters.validations).toBe(0);
          }
          expect(isVerifiedCheckpoint(actual.value)).toBe(true);
          state = actual.value;
          sent.push(command);
        }
      }
      // A walk that stopped reaching these would pass without testing them.
      expect(seen['applied start_attempt']).toBeGreaterThan(10);
      expect(seen['applied finish_attempt']).toBeGreaterThan(10);
      expect(seen['refused start_attempt']).toBeGreaterThan(10);
      expect(seen['refused finish_attempt']).toBeGreaterThan(10);
      if (shape === 'plan') expect(seen['applied append_step']).toBeGreaterThan(0);
      expect(seen['finished succeeded']).toBeGreaterThan(5);
      expect(seen['finished failed']).toBeGreaterThan(5);
      expect(seen['retried']).toBeGreaterThan(1);
      expect(seen['retried a terminal failure']).toBeGreaterThan(0);
      expect([...reasons]).toEqual(
        expect.arrayContaining([
          'schema',
          'conflict/undefined',
          'expired/deadline_passed',
          ...(accounting === 'reservation'
            ? ['limit/assignment_overcharged', 'limit/token_budget_exhausted']
            : ['limit/spend_cap_reached']),
        ])
      );
    },
    180_000
  );
});

/** One attempt from start to finish, for tests that need a finished work item. */
function attempt(work: number, id: string, rows: unknown[] = []) {
  return (state: AgenticRunSnapshot) => {
    const started = applyAgenticCheckpoint(state, {
      type: 'start_attempt',
      operation_id: `start_attempt:${id}`,
      expected_revision: state.revision,
      work,
      attempt_id: id,
      charge: 1,
      charge_microusd: 1,
    });
    return { started, finish: finishCommand(started, work, id, rows) };
  };
}
function finishCommand(state: AgenticRunSnapshot, work: number, id: string, rows: unknown[]) {
  return {
    type: 'finish_attempt' as const,
    operation_id: `finish_attempt:${id}`,
    expected_revision: state.revision,
    work,
    attempt_id: id,
    outcome: {
      contract_version: 2 as const,
      attempt_id: id,
      status: 'succeeded' as const,
      usage: { status: 'measured' as const, input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      rows: rows as Extract<Outcome, { status: 'succeeded' }>['rows'],
    },
    charge: 2,
    charge_microusd: 2,
  };
}
const finished = (state: AgenticRunSnapshot, work: number, id: string, rows: unknown[] = []) => {
  const { started, finish } = attempt(work, id, rows)(state);
  return applyAgenticCheckpoint(started, finish);
};
const output = (pair_id: unknown, fields: Record<string, unknown>) => ({
  pair_id,
  _dogsled_evidence: null,
  _dogsled_confidence: null,
  _dogsled_reason: null,
  ...fields,
});
function everyObject(value: unknown): object[] {
  if (typeof value !== 'object' || value === null) return [];
  return [value, ...Object.values(value).flatMap(everyObject)];
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('verified state', () => {
  async function sealed(count = 3, accounting: Accounting = 'spend_cap') {
    const f = runFixture(count);
    f.model.limits = {};
    return sealedRun({ ...f, accounting });
  }

  it('freezes every object in a result and proves a chain the complete check accepts', async () => {
    const state = finished(await sealed(), 0, 'one');
    expect(isVerifiedCheckpoint(state)).toBe(true);
    expect(everyObject(state).every((item) => Object.isFrozen(item))).toBe(true);
    expect(() =>
      applyAgenticCheckpoint(structuredClone(state), finishCommand(state, 0, 'x', []))
    ).toThrow();
    expect(AgenticRunSnapshotSchema.parse(structuredClone(state))).toEqual(state);
  });

  it('shares unchanged work with its predecessor and nothing with the caller', async () => {
    const before = await sealed();
    const row = output('p0', { assessment: 'A result.' });
    const { started, finish } = attempt(0, 'one', [row])(before);
    const after = applyAgenticCheckpoint(started, finish);
    expect(after.work[1]).toBe(started.work[1]);
    expect(after.work[0]!.assignment).toBe(started.work[0]!.assignment);
    // The caller's command stays the caller's: unfrozen, and changing it changes nothing saved.
    expect(Object.isFrozen(row)).toBe(false);
    expect(Object.isFrozen(finish.outcome)).toBe(false);
    row.assessment = 'Changed.';
    expect(after.work[0]!.accepted).toMatchObject({ rows: [{ assessment: 'A result.' }] });
  });

  it('leaves an unverified snapshot as the caller passed it', async () => {
    const copy = structuredClone(await sealed());
    const next = applyAgenticCheckpoint(copy, {
      type: 'start_attempt',
      operation_id: 'start_attempt:one',
      expected_revision: copy.revision,
      work: 0,
      attempt_id: 'one',
      charge: 1,
      charge_microusd: 1,
    });
    expect(isVerifiedCheckpoint(copy)).toBe(false);
    expect(everyObject(copy).some((item) => Object.isFrozen(item))).toBe(false);
    expect(next.definition).not.toBe(copy.definition);
  });

  it('stops counting as verified when the clock moves behind a saved time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    try {
      const f = runFixture(3);
      f.model.limits = {};
      const sealedState = await sealedRun({ ...f, accounting: 'spend_cap' });
      vi.setSystemTime(new Date('2026-06-01T00:00:05Z'));
      const state = finished(sealedState, 0, 'one');
      const next = attempt(1, 'two');
      expect(isVerifiedCheckpoint(state)).toBe(true);
      vi.setSystemTime(new Date('2026-06-01T00:00:02Z'));
      // The finish time is now ahead of the clock. The schema refuses that, so the path must.
      expect(isVerifiedCheckpoint(state)).toBe(false);
      expect(() => next(state)).toThrow('Invalid execution checkpoint');
      vi.setSystemTime(new Date('2026-06-01T00:00:06Z'));
      expect(isVerifiedCheckpoint(state)).toBe(true);
      expect(isVerifiedCheckpoint(next(state).started)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the newest saved time in a state verified from a copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-06-01T00:00:00Z');
    const fromCopy = (state: AgenticRunSnapshot) => {
      const copy = structuredClone(state);
      return validateAgenticReceipt(copy, copy);
    };
    const newestAt = (state: AgenticRunSnapshot, time: number) => {
      vi.setSystemTime(time - 1);
      expect(isVerifiedCheckpoint(state)).toBe(false);
      vi.setSystemTime(time);
      expect(isVerifiedCheckpoint(state)).toBe(true);
    };
    try {
      vi.setSystemTime(start);
      const f = runFixture(2);
      f.model.limits = {};
      const sealedMap = await sealedRun({ ...f, accounting: 'spend_cap' });
      // An attempt's finish time.
      vi.setSystemTime(start + 5000);
      newestAt(fromCopy(finished(sealedMap, 0, 'one')), start + 5000);
      // An execution window's start.
      vi.setSystemTime(start + 7000);
      const reopened = applyAgenticCheckpoint(sealedMap, {
        type: 'begin_execution',
        operation_id: 'reopen',
        expected_revision: sealedMap.revision,
        started_at: new Date(start + 7000).toISOString(),
        token_limit: null,
        cost_limit_microusd: null,
      });
      newestAt(fromCopy(reopened), start + 7000);
      // When a plan's input was retrieved.
      vi.setSystemTime(start + 9000);
      const plan = await sealedRun({
        ...workload('plan', 'spend_cap', 1),
        accounting: 'spend_cap',
      });
      newestAt(fromCopy(plan), start + 9000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not vouch for a value whose JSON is not what the schema read', async () => {
    const started = structuredClone(attempt(0, 'one')(await sealed()).started);
    const valid = output('p0', { assessment: 'Valid.' });
    const forged = { ...valid, pair_id: 'outside', extra: 'never validated' };
    const hidden = Object.defineProperty({ ...valid }, 'toJSON', { value: () => forged });
    const finish = finishCommand(started, 0, 'one', [hidden]);
    // The complete path validates what it can see, so it stays on as it always was.
    const result = applyAgenticCheckpoint(started, finish);
    expect(isVerifiedCheckpoint(result)).toBe(false);
    expect(Object.isFrozen(result)).toBe(false);
    // From verified state too: the proof copies the command, sees the difference, and steps aside.
    const verifiedState = applyAgenticCheckpoint(await sealed(), {
      type: 'start_attempt',
      operation_id: 'start_attempt:one',
      expected_revision: (await sealed()).revision,
      work: 0,
      attempt_id: 'one',
      charge: 1,
      charge_microusd: 1,
    });
    expect(advanceVerifiedCheckpoint(verifiedState, finish, Date.now())).toBeUndefined();
    // Even when the hidden JSON would pass by itself, it is not what was read.
    const plausible = { ...valid, assessment: 'Valid too, and never validated.' };
    const twoFaced = Object.defineProperty({ ...valid }, 'toJSON', { value: () => plausible });
    const other = finishCommand(started, 0, 'one', [twoFaced]);
    expect(advanceVerifiedCheckpoint(verifiedState, other, Date.now())).toBeUndefined();
  });

  /** Runs `read` with a value in `target` that turns invalid at one read of a whole snapshot. */
  function withValueChangingAt(
    flip: number,
    target: Record<string, unknown>,
    read: () => AgenticRunSnapshot
  ) {
    let reads = 0;
    Object.defineProperty(target, 'assessment', {
      enumerable: true,
      get: () => (reads >= flip ? 42 : 'Valid.'),
    });
    const { stringify } = JSON;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const value = args[0] as { work?: { accepted?: unknown }[] } | undefined;
      if (Array.isArray(value?.work) && value.work[0]?.accepted) reads++;
      return stringify(...args);
    }) as typeof JSON.stringify;
    try {
      return verdict(read);
    } finally {
      JSON.stringify = stringify;
    }
  }

  it.each([1, 2, 3, 4])(
    'keeps only what the schema read when a value changes at read %s',
    async (flip) => {
      const started = structuredClone(attempt(0, 'one')(await sealed()).started);
      const row = output('p0', {});
      const finish = finishCommand(started, 0, 'one', [row]);
      const result = withValueChangingAt(flip, row, () => applyAgenticCheckpoint(started, finish));
      // Refused is fine, and so is an unverified result, which later commands validate in full.
      if ('value' in result && isVerifiedCheckpoint(result.value)) {
        expect(AgenticRunSnapshotSchema.safeParse(structuredClone(result.value)).success).toBe(
          true
        );
      }
    }
  );

  it.each([1, 2, 3, 4])(
    'keeps only what the schema read from a response that changes at read %s',
    async (flip) => {
      const state = finished(await sealed(), 0, 'one', [output('p0', { assessment: 'Valid.' })]);
      const reply = structuredClone(state);
      const accepted = reply.work[0]!.accepted as { rows: Record<string, unknown>[] };
      const result = withValueChangingAt(flip, accepted.rows[0]!, () =>
        validateAgenticReceipt(reply, structuredClone(state))
      );
      if ('value' in result && isVerifiedCheckpoint(result.value)) {
        expect(AgenticRunSnapshotSchema.safeParse(structuredClone(result.value)).success).toBe(
          true
        );
      }
    }
  );

  it('returns verified state itself instead of copying it again', async () => {
    const state = await sealed();
    expect(isVerifiedCheckpoint(state)).toBe(true);
    expect(validateAgenticReceipt(state, state)).toBe(state);
  });

  it('refuses what JSON would repair or cannot read, as the complete check does', async () => {
    const state = finished(await sealed(), 0, 'one', [output('p0', { assessment: 'Valid.' })]);
    const repaired = structuredClone(state);
    const accepted = repaired.work[0]!.accepted as { rows: Record<string, unknown>[] };
    accepted.rows[0]!.score = Number.NaN;
    const cycle: Record<string, unknown> = { ...state };
    cycle.extra = cycle;
    const refused = [
      repaired,
      cycle,
      { ...state, extra: undefined },
      { ...state, extra: () => 1 },
      { ...state, extra: BigInt(1) },
    ];
    for (const candidate of refused) {
      expect(() => validateAgenticReceipt(candidate, state)).toThrow('corrupt');
    }
  });

  it('finds an attempt ID in the state it is asked about, not in a sibling state', async () => {
    const base = await sealed();
    const start = (state: AgenticRunSnapshot, work: number, id: string) => ({
      type: 'start_attempt' as const,
      operation_id: `start_attempt:${id}`,
      expected_revision: state.revision,
      work,
      attempt_id: id,
      charge: 1,
      charge_microusd: 1,
    });
    // Two states descend from one, and each gives the same ID to a different work item.
    const first = applyAgenticCheckpoint(base, start(base, 0, 'shared'));
    const second = applyAgenticCheckpoint(base, start(base, 1, 'shared'));
    expect(second.work[1]!.attempts[0]!.id).toBe('shared');
    expect(() => applyAgenticCheckpoint(first, start(first, 1, 'shared'))).toThrow('conflict');
    expect(() => applyAgenticCheckpoint(second, start(second, 0, 'shared'))).toThrow('conflict');
    // A state without the ID can still use it, although a sibling already recorded it.
    expect(applyAgenticCheckpoint(base, start(base, 2, 'shared')).work[2]!.attempts).toHaveLength(
      1
    );
    // Two parties deriving the same command from one state get equal states.
    expect(applyAgenticCheckpoint(base, start(base, 0, 'shared'))).toEqual(first);
  });

  it('finds an attempt ID saved before the state was verified', async () => {
    const base = await sealed();
    const start = (state: AgenticRunSnapshot, work: number, id: string) => ({
      type: 'start_attempt' as const,
      operation_id: `start_attempt:${id}`,
      expected_revision: state.revision,
      work,
      attempt_id: id,
      charge: 1,
      charge_microusd: 1,
    });
    const started = applyAgenticCheckpoint(base, start(base, 0, 'saved'));
    // As after a resume: the state is read back, then verified by the complete path.
    const reopened = applyAgenticCheckpoint(structuredClone(started), {
      type: 'begin_execution',
      operation_id: 'reopen',
      expected_revision: started.revision,
      started_at: new Date(Date.now()).toISOString(),
      token_limit: null,
      cost_limit_microusd: null,
    });
    expect(isVerifiedCheckpoint(reopened)).toBe(true);
    const reused = start(reopened, 1, 'saved');
    expect(complete(reopened, reused, Date.now())).toMatchObject({
      error: expect.stringContaining('conflict'),
    });
    expect(() => applyAgenticCheckpoint(reopened, reused)).toThrow('conflict');
  });

  it('refuses a price that overflows the run total, as the complete path does', async () => {
    const earlier = finished(await sealed(), 1, 'earlier');
    const { started, finish } = attempt(0, 'one')(earlier);
    const over = { ...finish, charge_microusd: Number.MAX_SAFE_INTEGER };
    const expected = complete(started, over, Date.now());
    expect(expected).toMatchObject({ error: expect.stringContaining('too_big') });
    expect(verdict(() => applyAgenticCheckpoint(started, over))).toEqual(expected);
  });

  it('refuses to start after an overcharge, however the state was reached', async () => {
    const f = runFixture(3);
    f.model.limits = { tokens: 100000 };
    const base = await sealedRun({ ...f, accounting: 'reservation' });
    const start = (state: AgenticRunSnapshot, work: number, id: string) =>
      applyAgenticCheckpoint(state, {
        type: 'start_attempt',
        operation_id: `start_attempt:${id}`,
        expected_revision: state.revision,
        work,
        attempt_id: id,
      });
    const started = start(start(base, 0, 'one'), 1, 'two');
    const reservation = started.work[0]!.attempts[0]!.reservation!;
    const { charge_microusd: _one, ...finish } = finishCommand(started, 0, 'one', []);
    const over = applyAgenticCheckpoint(started, { ...finish, charge: reservation + 1 });
    expect(over.work[0]!.accepted).toBeUndefined();
    // Once by a chain of proofs, and once from a copy: both find it in a different work item.
    expect(() => start(over, 2, 'three')).toThrow('assignment_overcharged');
    expect(() => start(structuredClone(over), 2, 'three')).toThrow('assignment_overcharged');
    // A proved finish of another attempt in between must not lose the fact.
    const { charge_microusd: _two, ...other } = finishCommand(over, 1, 'two', []);
    const later = applyAgenticCheckpoint(over, other);
    expect(() => start(later, 2, 'three')).toThrow('assignment_overcharged');
    const revalidated = applyAgenticCheckpoint(structuredClone(later), {
      type: 'begin_execution',
      operation_id: 'again',
      expected_revision: later.revision,
      started_at: new Date(Date.now()).toISOString(),
    });
    expect(() => start(revalidated, 2, 'three')).toThrow('assignment_overcharged');
  });

  /** Fills a run with `fill`, then finds the largest last answer the complete check accepts. */
  async function boundary(
    columns: { name: string; type: 'string' | 'array'; nullable: boolean }[],
    fill: (size: number) => Record<string, unknown>,
    measure: (state: AgenticRunSnapshot) => number,
    limit: number,
    filled: number,
    fullSize: number
  ) {
    const f = runFixture(filled + 2);
    f.model.limits = {};
    f.model.plan.steps[0]!.columns = [
      { name: 'pair_id', type: 'string', nullable: false },
      ...columns,
    ];
    const base = await sealedRun({ ...f, accounting: 'spend_cap' });
    const rows = (work: number, size: number) => [output(`p${work}`, fill(size))];
    let state = base;
    for (let work = 0; work < filled; work++) {
      state = finished(state, work, `fill-${work}`, rows(work, fullSize));
    }
    const { started } = attempt(filled, 'last')(state);
    const command = (size: number) => finishCommand(started, filled, 'last', rows(filled, size));
    // Each unit of an answer counts twice: once in its attempt and once as accepted work.
    const probe = applyAgenticCheckpoint(structuredClone(started), command(0));
    const exact = Math.floor((limit - measure(probe)) / 2);
    return { started, command, exact };
  }

  it('knows the JSON size of a verified snapshot without reading it', async () => {
    let state = await sealed();
    const sizes = () => [checkpointJsonBytes(state), jsonBytes(state)];
    for (const [work, id] of ['one', 'two', 'three'].entries()) {
      const { started, finish } = attempt(work, id, [
        output(`p${work}`, { assessment: 'é'.repeat(9) }),
      ])(state);
      state = started;
      expect(new Set(sizes()).size).toBe(1);
      state = applyAgenticCheckpoint(started, finish);
      expect(new Set(sizes()).size).toBe(1);
    }
    // A copy is not verified, so its size is measured.
    const copy = structuredClone(state);
    expect(checkpointJsonBytes(copy)).toBe(jsonBytes(copy));
  });

  it('stops at the JSON size limit exactly where the complete check does', async () => {
    const { started, command, exact } = await boundary(
      [{ name: 'assessment', type: 'string', nullable: false }],
      (size) => ({ assessment: 'x'.repeat(size) }),
      jsonBytes,
      AGENTIC_MAX_CHECKPOINT_BYTES,
      16,
      490_000
    );
    expect(exact).toBeGreaterThan(0);
    const counters = { validations: 0 };
    const restore = countSnapshotValidations(counters);
    const fits = applyAgenticCheckpoint(started, command(exact));
    restore();
    expect(counters.validations).toBe(0);
    expect(jsonBytes(fits)).toBeLessThanOrEqual(AGENTIC_MAX_CHECKPOINT_BYTES);
    expect(jsonBytes(fits)).toBeGreaterThan(AGENTIC_MAX_CHECKPOINT_BYTES - 2);
    const over = command(exact + 1);
    const expected = complete(started, over, Date.now());
    expect(expected).toMatchObject({ error: expect.stringContaining('exceeds its limits') });
    expect(verdict(() => applyAgenticCheckpoint(started, over))).toEqual(expected);
  }, 60_000);

  it('counts array positions toward the text limit, as the complete check does', async () => {
    // Positions are text to the limit but take no room in JSON, so text can pass it first.
    const f = runFixture(20);
    f.model.limits = {};
    f.model.plan.steps[0]!.columns = [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'assessment', type: 'string', nullable: false },
      { name: 'items', type: 'array', nullable: false },
    ];
    let state = await sealedRun({ ...f, accounting: 'spend_cap' });
    const fields = (text: number, items: number) => ({
      assessment: 'x'.repeat(text),
      items: Array.from({ length: items }, () => 0),
    });
    for (let work = 0; work < 8; work++) {
      state = finished(state, work, `dense-${work}`, [output(`p${work}`, fields(450_000, 15_000))]);
    }
    for (let work = 8; work < 16; work++) {
      state = finished(state, work, `long-${work}`, [output(`p${work}`, fields(510_000, 0))]);
    }
    const { started } = attempt(16, 'last')(state);
    const room = AGENTIC_MAX_CHECKPOINT_BYTES - jsonBytes(started);
    const last = finishCommand(started, 16, 'last', [
      output('p16', fields(Math.floor(room / 2) - 4_000, 0)),
    ]);
    const expected = complete(started, last, Date.now());
    expect(expected).toMatchObject({ error: expect.stringContaining('exceeds its limits') });
    expect(verdict(() => applyAgenticCheckpoint(started, last))).toEqual(expected);
    // The JSON alone would have fitted, so only the text limit can have refused this.
    const size = jsonBytes(started) + 2 * Math.floor(room / 2) - 8_000;
    expect(size).toBeLessThan(AGENTIC_MAX_CHECKPOINT_BYTES);
  }, 60_000);

  it('stops at the value limit exactly where the complete check does', async () => {
    const { started, command, exact } = await boundary(
      [{ name: 'items', type: 'array', nullable: false }],
      (size) => ({ items: Array.from({ length: size }, () => 0) }),
      (state) => measureCheckpoint(state)?.values ?? Infinity,
      AGENTIC_MAX_CHECKPOINT_VALUES,
      8,
      15_000
    );
    expect(exact).toBeGreaterThan(0);
    const counters = { validations: 0 };
    const restore = countSnapshotValidations(counters);
    const fits = applyAgenticCheckpoint(started, command(exact));
    restore();
    expect(counters.validations).toBe(0);
    expect(measureCheckpoint(fits)?.values).toBeGreaterThanOrEqual(
      AGENTIC_MAX_CHECKPOINT_VALUES - 1
    );
    const over = command(exact + 1);
    const expected = complete(started, over, Date.now());
    expect(expected).toMatchObject({ error: expect.stringContaining('exceeds its limits') });
    expect(verdict(() => applyAgenticCheckpoint(started, over))).toEqual(expected);
  }, 60_000);
});

describe('a run on verified state', () => {
  it('hands hosts data of their own and keeps executor objects out of saved state', async () => {
    const f = runFixture(2);
    const reason = { summary: 'Why.', supporting_factors: ['One'], conflicting_factors: [] };
    const returned: Record<string, unknown>[] = [];
    f.host.executeAgent = async ({ assignment, budget }) => {
      const usage = {
        status: 'measured' as const,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      };
      await budget.settle(await budget.reserve(100), usage);
      const pair = assignment.processed_keys[0]!.pair_id;
      const answer = output(pair, { assessment: 'A result.', _dogsled_reason: reason });
      returned.push(answer);
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage,
        rows: [answer],
      };
    };
    const store = sharedMemoryStore();
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'owned', mode: 'start' },
    });
    expect(Object.isFrozen(reason)).toBe(false);
    expect(returned.every((answer) => !Object.isFrozen(answer))).toBe(true);
    reason.supporting_factors.push('Added after the call.');
    const session = await store.acquire({ scope: 'lake', model: f.model.name, id: 'owned' });
    const saved = (await session.read())!;
    expect(saved.work[0]!.accepted).toMatchObject({
      rows: [{ _dogsled_reason: { supporting_factors: ['One'] } }],
    });
    // Everything a host receives is its own to change, saved state is not.
    const [first] = result.rows as { _dogsled_reason: typeof reason }[];
    first!._dogsled_reason.supporting_factors.push('Host note.');
    (result.processedKeys[0] as { pair_id: string }).pair_id = 'changed';
    expect(saved.work[0]!.assignment.processed_keys).toEqual([{ pair_id: 'p0' }]);
    expect(AgenticRunSnapshotSchema.parse(structuredClone(saved)).revision).toBe(saved.revision);
  });

  it('finishes a run whose executor returns a value with a hidden toJSON', async () => {
    const f = runFixture(2);
    const { executeAgent } = f.host;
    f.host.executeAgent = async (request) => {
      const result = (await executeAgent(request)) as { rows: unknown[] };
      const pair_id = request.assignment.processed_keys[0]!.pair_id;
      const valid = output(pair_id, { assessment: 'Valid.' });
      const forged = { ...valid, pair_id: 'outside', assessment: 42 };
      const row = Object.defineProperty({ ...valid }, 'toJSON', { value: () => forged });
      return { ...result, rows: [row] } as never;
    };
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: sharedMemoryStore(),
      run: { id: 'hidden', mode: 'start' },
    });
    expect(result.rows).toMatchObject([
      { pair_id: 'p0', assessment: 'Valid.' },
      { pair_id: 'p1', assessment: 'Valid.' },
    ]);
  });

  it('hands stores, publishers and hosts data they can write to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogsled-verified-'));
    try {
      const f = runFixture(2);
      f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
      f.host.inputs = {
        undecided_pairs: [
          { name: 'pair_id', type: 'string', nullable: false },
          { name: 'updated_at', type: 'integer', nullable: false },
        ],
      };
      f.host.prepare = async () => [
        { pair_id: 'p0', updated_at: 1 },
        { pair_id: 'p1', updated_at: 2 },
      ];
      const frozen: string[] = [];
      const note = (name: string, value: object) => {
        if (Object.isFrozen(value)) frozen.push(name);
      };
      f.host.priceUsage = (profile) => {
        note('profile', profile);
        return 0.001;
      };
      const cursors = createLocalAgenticCursorStore(dir);
      let failCommit = true;
      const publisher = {
        preflight: async () => {},
        claim: async () => ({ version: 0, fence: 'owner' }),
        prepare: async (_context: unknown, identity: unknown, rows: unknown, keys: unknown) => {
          note('rows', (rows as object[])[0] ?? {});
          note('keys', (keys as object[])[0]!);
          const { operation_id } = identity as { operation_id: string };
          return { identity, expected_version: 0, stage: `stage_${operation_id}` };
        },
        inspect: async (intent: object) => {
          note('intent', intent);
          return null;
        },
        commit: async (intent: object) => {
          note('intent', intent);
          if (failCommit) throw new Error('Stop before the commit.');
          return { intent, committed_version: 1 };
        },
        close: async () => {},
      };
      const memory = new MemoryStateStore();
      const stateStore: AgenticStateStore = {
        async acquire(key) {
          const session = await memory.acquire(key);
          return {
            ...session,
            checkpoint(command) {
              if (command.type === 'append_step') {
                note('assignment row', command.assignments[0]!.input.rows[0] as object);
              }
              return session.checkpoint(command);
            },
          };
        },
      };
      const options = {
        projectDirectory: dir,
        stateStore,
        publisher: publisher as never,
        cursorStore: {
          ...cursors,
          commit: (...args: Parameters<typeof cursors.commit>) => {
            note('cursor values', args[3]);
            return cursors.commit(...args);
          },
        },
      };
      await expect(
        executeAgenticRun(f.host, f.context(), {
          ...options,
          run: { id: 'host', mode: 'start' },
        })
      ).rejects.toThrow();
      failCommit = false;
      // The resume reads the intent back from saved state and hands it to the publisher.
      await expect(
        executeAgenticRun(f.host, f.context(), {
          ...options,
          run: { id: 'host', mode: 'resume' },
        })
      ).resolves.toMatchObject({ publication: 'confirmed' });
      expect(frozen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves every attempt of a run on a store that returns its result', async () => {
    const run = async (assignments: number) => {
      const w = benchmarkWorkload(assignments, 'plan', 1000);
      const counters = { validations: 0 };
      const restore = countSnapshotValidations(counters);
      try {
        await executeAgenticRun(w.host, w.context(), {
          projectDirectory: '/unused',
          stateStore: sharedMemoryStore(),
          run: { id: 'proved', mode: 'start' },
        });
      } finally {
        restore();
      }
      return counters.validations;
    };
    expect(await run(20)).toBe(await run(5));
  });
});
