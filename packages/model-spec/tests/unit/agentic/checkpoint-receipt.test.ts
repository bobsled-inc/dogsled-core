import { describe, expect, it } from 'vitest';
import {
  createAgenticReceiptValidator,
  validateAgenticReceipt,
} from '../../../src/agentic/checkpoint-receipt.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../../src/agentic/state.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';

interface Step {
  command: AgenticCheckpointCommand;
  requestedAt: number;
  response: AgenticRunSnapshot;
}
/** Records each command with the response of a supplied store during a real run. */
async function recordRun() {
  const memory = new MemoryStateStore();
  const steps: Step[] = [];
  let initial: AgenticRunSnapshot | undefined;
  const store: AgenticStateStore = {
    async acquire(key) {
      const session = await memory.acquire(key);
      return {
        ...session,
        async create(value) {
          initial = structuredClone(await session.create(value));
          return structuredClone(initial);
        },
        async checkpoint(command) {
          const requestedAt = Date.now();
          const response = await session.checkpoint(command);
          steps.push({ command: structuredClone(command), requestedAt, response });
          return structuredClone(response);
        },
      };
    },
  };
  const f = runFixture(3);
  await executeAgenticRun(f.host, f.context(), {
    projectDirectory: '/unused',
    stateStore: store,
    run: { id: 'receipts', mode: 'start' },
  });
  return { initial: initial!, steps };
}
const outcome = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
};

describe('coordinator receipt validation', () => {
  it('accepts exactly the responses the complete check accepts, validating each once', async () => {
    const { initial, steps } = await recordRun();
    expect(steps.map((step) => step.command.type)).toEqual([
      'seal_work',
      ...Array.from({ length: 3 }, () => ['start_attempt', 'finish_attempt']).flat(),
      'complete',
    ]);
    const validate = createAgenticReceiptValidator();
    let before = validate(initial, initial);
    const counters = { validations: 0 };
    const restore = countSnapshotValidations(counters);
    try {
      for (const { command, requestedAt, response } of steps) {
        const expected = validateAgenticReceipt(response, before, command, requestedAt);
        counters.validations = 0;
        before = validate(response, before, command, requestedAt);
        expect(before).toEqual(expected);
        expect(counters.validations).toBe(1);
      }
    } finally {
      restore();
    }
  });

  it('rejects stale, forged, foreign and malformed responses like the complete check', async () => {
    const { initial, steps } = await recordRun();
    const validate = createAgenticReceiptValidator();
    let before = validate(initial, initial);
    for (const [index, { command, requestedAt, response }] of steps.entries()) {
      const forged = structuredClone(response);
      forged.charged += 1;
      const foreign = steps[index + 1]?.response ?? initial;
      for (const candidate of [before, forged, foreign, {}, null]) {
        const expected = outcome(() =>
          validateAgenticReceipt(candidate, before, command, requestedAt)
        );
        expect(expected).toEqual({ error: 'AgenticStateError: Agentic state corrupt' });
        expect(outcome(() => validate(candidate, before, command, requestedAt))).toEqual(expected);
      }
      before = validate(response, before, command, requestedAt);
    }
  });

  it('falls back to the complete check when the coordinator state changed after validation', async () => {
    const { initial, steps } = await recordRun();
    const validate = createAgenticReceiptValidator();
    let before = validate(initial, initial);
    for (const { command, requestedAt, response } of steps) {
      before = validate(response, before, command, requestedAt);
      if (command.type === 'start_attempt') break;
    }
    const finish = steps.find((step) => step.command.type === 'finish_attempt')!;
    // A shared key object changed after validation. Both checks reject the same input.
    before.work[0]!.assignment.processed_keys[0]!.pair_id = 'changed';
    const expected = outcome(() =>
      validateAgenticReceipt(finish.response, before, finish.command, finish.requestedAt)
    );
    expect(expected.error).toMatch(/^ZodError/);
    expect(
      outcome(() => validate(finish.response, before, finish.command, finish.requestedAt))
    ).toEqual(expected);
    // An equal copy is not the validated object, so it also takes the complete check.
    const { initial: first, steps: again } = await recordRun();
    const fresh = createAgenticReceiptValidator();
    const copy = structuredClone(fresh(first, first));
    const step = again[0]!;
    expect(fresh(step.response, copy, step.command, step.requestedAt)).toEqual(
      validateAgenticReceipt(step.response, copy, step.command, step.requestedAt)
    );
  });
});
