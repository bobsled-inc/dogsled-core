import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceVerifiedCheckpoint } from '../../../src/agentic/checkpoint-verified.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { applyAgenticCheckpoint } from '../../../src/agentic/state.js';
import type { AgenticCheckpointCommand, AgenticRunSnapshot } from '../../../src/agentic/state.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

type Attempt = AgenticRunSnapshot['work'][number]['attempts'][number];
type Damage = (next: AgenticRunSnapshot, attempt: Attempt, index: number) => void;

// A correct transition never trips most of these checks. They are there for an incorrect one, as
// the complete check is, so this replaces the transition the proof calls with a damaged one. The
// complete path keeps the real transition, because it calls it inside state.ts.
const sabotage = vi.hoisted(() => ({ damage: undefined as Damage | undefined, used: 0 }));
vi.mock('../../../src/agentic/state.js', async (original) => {
  const module = await original<typeof import('../../../src/agentic/state.js')>();
  return {
    ...module,
    applyParsedCommand: (
      state: AgenticRunSnapshot,
      command: Extract<AgenticCheckpointCommand, { work: number }>,
      ...rest: [number, Parameters<typeof module.applyParsedCommand>[3]]
    ) => {
      const changed = module.applyParsedCommand(state, command, ...rest);
      if (changed && sabotage.damage) {
        sabotage.used++;
        sabotage.damage(state, state.work[command.work]!.attempts.at(-1)!, command.work);
      }
      return changed;
    },
  };
});

async function fixture(accounting: 'spend_cap' | 'reservation') {
  const memory = new MemoryStateStore();
  const f = runFixture(2);
  f.model.limits = { tokens: 100000 };
  f.host.executeAgent = () => Promise.reject(new Error('Stop here.'));
  await executeAgenticRun(f.host, f.context(), {
    projectDirectory: '/unused',
    stateStore: memory,
    run: { id: 'run', mode: 'start' },
    accounting,
  }).catch(() => undefined);
  // Leaves one interrupted attempt; a verified state continues from it on the second item.
  const saved = [...memory.runs.values()][0]!;
  const spendCap = accounting === 'spend_cap';
  const start: AgenticCheckpointCommand = {
    type: 'start_attempt',
    operation_id: 'start_attempt:two',
    expected_revision: saved.revision,
    work: 1,
    attempt_id: 'two',
    ...(spendCap ? { charge: 1, charge_microusd: 1 } : {}),
  };
  const started = applyAgenticCheckpoint(saved, start);
  const finish: AgenticCheckpointCommand = {
    type: 'finish_attempt',
    operation_id: 'finish_attempt:two',
    expected_revision: started.revision,
    work: 1,
    attempt_id: 'two',
    outcome: {
      contract_version: 2,
      attempt_id: 'two',
      status: 'succeeded',
      usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      rows: [],
    },
    charge: 2,
    ...(spendCap ? { charge_microusd: 2 } : {}),
  };
  return { saved, start, started, finish };
}

const inWork = (damage: (work: AgenticRunSnapshot['work'][number]) => void): Damage => {
  return (next, _attempt, index) => damage(next.work[index]!);
};

describe('a proof does not trust the transition', () => {
  beforeEach(() => {
    sabotage.damage = undefined;
    sabotage.used = 0;
  });

  const both: [string, Damage][] = [
    ['skips a revision', (next) => void next.revision++],
    ['repeats a revision', (next) => void next.revision--],
    ['charges a fraction', (next) => void (next.charged += 0.5)],
    ['charges a negative total', (next) => void (next.charged = -1)],
    ['overflows the total', (next) => void (next.charged = Number.MAX_SAFE_INTEGER + 2)],
    ['drifts from the attempts', (next) => void next.charged++],
    ['charges an attempt without the run', (_next, attempt) => void attempt.charge++],
    [
      'writes a field the schema refuses',
      (_next, attempt) => void Object.assign(attempt, { x: 1 }),
    ],
    ['writes an empty ID', (_next, attempt) => void (attempt.id = '')],
    ['writes a mistyped charge', (_next, attempt) => void Object.assign(attempt, { charge: '2' })],
    ['starts before the run was sealed', (_next, attempt) => void (attempt.start_revision = 0)],
    ['writes too many attempts', inWork((work) => work.attempts.push(...work.attempts))],
    ['changes the run status', (next) => void (next.status = 'execution_complete')],
    ['changes the attempt limit', (next) => void (next.max_attempts = 10)],
    ['changes the start time', (next) => void (next.started_at = '2001-01-01T00:00:00.000Z')],
    ['adds a run field', (next) => void Object.assign(next, { superseded: true })],
    ['removes a run field', (next) => void delete (next as { deadline_at?: unknown }).deadline_at],
    ['writes an unknown work field', inWork((work) => void Object.assign(work, { note: 'x' }))],
    [
      'replaces another work item',
      (next, _attempt, index) => void (next.work[1 - index] = next.work[index]!),
    ],
    ['adds a work item', (next) => void next.work.push(next.work[0]!)],
    [
      'replaces an equal assignment',
      inWork((work) => void (work.assignment = structuredClone(work.assignment))),
    ],
    [
      'writes more attempts than the schema holds',
      inWork((work) => {
        const last = work.attempts.at(-1)!;
        while (work.attempts.length <= 10) {
          work.attempts.push({ ...last, id: `x${work.attempts.length}` });
        }
      }),
    ],
    [
      'moves the assignment',
      inWork((work) => void (work.assignment = { ...work.assignment, run_id: 'other' })),
    ],
  ];

  it.each(both)('refuses a transition that %s', async (_name, damage) => {
    for (const accounting of ['spend_cap', 'reservation'] as const) {
      sabotage.damage = undefined;
      const { saved, start, started, finish } = await fixture(accounting);
      sabotage.damage = damage;
      sabotage.used = 0;
      expect(
        advanceVerifiedCheckpoint(saved, start, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
      ).toBeUndefined();
      expect(
        advanceVerifiedCheckpoint(started, finish, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
      ).toBeUndefined();
      expect(sabotage.used).toBe(2);
      // The complete path never saw the damage, so a real command still succeeds.
      expect(applyAgenticCheckpoint(saved, start)).toEqual(started);
    }
  });

  const spendCapOnly: [string, Damage][] = [
    ['prices a fraction', (next) => void (next.charged_microusd! += 0.5)],
    ['drifts the price', (next) => void next.charged_microusd!++],
    ['prices a negative total', (next) => void (next.charged_microusd = -1)],
    ['reserves on a spend-cap run', (_next, attempt) => void (attempt.reservation = 1)],
    ['prices an attempt without the run', (_next, attempt) => void attempt.charge_microusd!++],
  ];
  it.each(spendCapOnly)('refuses a transition that %s', async (_name, damage) => {
    const { saved, start, started, finish } = await fixture('spend_cap');
    sabotage.damage = damage;
    expect(
      advanceVerifiedCheckpoint(saved, start, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
    expect(
      advanceVerifiedCheckpoint(started, finish, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
  });

  const reservationOnly: [string, Damage][] = [
    ['prices a reservation run', (_next, attempt) => void (attempt.charge_microusd = 1)],
    ['reserves the wrong amount', (_next, attempt) => void (attempt.reservation! += 1)],
  ];
  it.each(reservationOnly)('refuses a transition that %s', async (_name, damage) => {
    const { saved, start, started, finish } = await fixture('reservation');
    sabotage.damage = damage;
    expect(
      advanceVerifiedCheckpoint(saved, start, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
    expect(
      advanceVerifiedCheckpoint(started, finish, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
  });

  it('refuses a reservation that does not match a shared budget', async () => {
    const memory = new MemoryStateStore();
    const f = runFixture(2);
    f.model.limits = { tokens: 100000 };
    delete f.host.tokensPerAssignment;
    // Stops before the first attempt, which would otherwise reserve the whole budget.
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: {
        async acquire(key) {
          const session = await memory.acquire(key);
          return {
            ...session,
            checkpoint: (command) =>
              command.type === 'start_attempt'
                ? Promise.reject(new Error('Stop here.'))
                : session.checkpoint(command),
          };
        },
      },
      run: { id: 'run', mode: 'start' },
      accounting: 'reservation',
    }).catch(() => undefined);
    const saved = [...memory.runs.values()][0]!;
    expect(saved.work[0]!.assignment.limits.tokens).toBeNull();
    // Only the run total shows what this reservation should be, so the totals stay consistent.
    sabotage.damage = (next, attempt) => {
      attempt.reservation! -= 1;
      attempt.charge -= 1;
      next.charged -= 1;
    };
    const start: AgenticCheckpointCommand = {
      type: 'start_attempt',
      operation_id: 'start_attempt:one',
      expected_revision: saved.revision,
      work: 0,
      attempt_id: 'one',
    };
    expect(
      advanceVerifiedCheckpoint(saved, start, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
    expect(sabotage.used).toBe(1);
  });

  const finishOnly: [string, Damage][] = [
    ['leaves the finish time out', (_next, attempt) => void delete attempt.finished_at],
    [
      'finishes before the run started',
      (_next, attempt) => void (attempt.finished_at = '2001-01-01T00:00:00.000Z'),
    ],
    [
      'finishes in the future',
      (_next, attempt) => void (attempt.finished_at = '2999-01-01T00:00:00.000Z'),
    ],
    ['writes a stale digest', (_next, attempt) => void (attempt.finish_digest = '0'.repeat(64))],
    ['writes a short digest', (_next, attempt) => void (attempt.finish_digest = '0')],
    ['loses the finish revision', (_next, attempt) => void delete attempt.finish_revision],
    [
      'finishes before it started',
      (_next, attempt) => void (attempt.finish_revision = attempt.start_revision),
    ],
    ['loses an accepted answer', inWork((work) => void delete work.accepted)],
    [
      'accepts a different answer',
      inWork((work) => void (work.accepted = { ...work.accepted!, attempt_id: 'other' })),
    ],
    [
      'accepts a malformed answer',
      inWork((work) => void Object.assign(work, { accepted: { status: 'succeeded' } })),
    ],
    [
      'changes an answer after its digest',
      (_next, attempt) =>
        void (attempt.outcome = {
          ...attempt.outcome!,
          usage: { status: 'unknown', reason: 'unavailable' },
        }),
    ],
  ];
  it.each(finishOnly)('refuses a transition that %s', async (_name, damage) => {
    const { started, finish } = await fixture('spend_cap');
    sabotage.damage = damage;
    expect(
      advanceVerifiedCheckpoint(started, finish, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
    expect(sabotage.used).toBe(1);
  });

  it('refuses a transition that rewrites an earlier attempt', async () => {
    const { saved } = await fixture('spend_cap');
    sabotage.damage = (next, _attempt, index) => {
      next.work[index]!.attempts[0]!.charge = 0;
    };
    // The first work item already holds the attempt the fixture interrupted.
    expect(saved.work[0]!.attempts).toHaveLength(1);
    const again: AgenticCheckpointCommand = {
      type: 'start_attempt',
      operation_id: 'start_attempt:again',
      expected_revision: saved.revision,
      work: 0,
      attempt_id: 'again',
      charge: 1,
      charge_microusd: 1,
    };
    expect(
      advanceVerifiedCheckpoint(saved, again, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
    ).toBeUndefined();
    expect(applyAgenticCheckpoint(saved, again).work[0]!.attempts[0]).toEqual(
      saved.work[0]!.attempts[0]
    );
  });

  it('accepts the same commands from the undamaged transition', async () => {
    for (const accounting of ['spend_cap', 'reservation'] as const) {
      const { saved, start, started, finish } = await fixture(accounting);
      expect(
        advanceVerifiedCheckpoint(saved, start, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
      ).toEqual(started);
      expect(
        advanceVerifiedCheckpoint(started, finish, Date.now(), AGENTIC_DEFAULT_STORE_LIMITS)
      ).toBeDefined();
    }
  });
});
