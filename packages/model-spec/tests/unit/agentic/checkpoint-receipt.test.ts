import { describe, expect, it } from 'vitest';
import { validateAgenticReceipt } from '../../../src/agentic/checkpoint-receipt.js';
import { isVerifiedCheckpoint } from '../../../src/agentic/checkpoint-verified.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { applyAgenticCheckpoint } from '../../../src/agentic/state.js';
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
/** A copy of `before` is not verified state, so this always runs the complete check. */
const completeCheck = (
  value: unknown,
  before: AgenticRunSnapshot,
  command: AgenticCheckpointCommand,
  requestedAt: number
) => validateAgenticReceipt(value, structuredClone(before), command, requestedAt);
const isAttempt = (command: AgenticCheckpointCommand) =>
  command.type === 'start_attempt' || command.type === 'finish_attempt';
const outcome = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
};

describe('coordinator receipt validation', () => {
  it('accepts exactly the responses the complete check accepts, validating at most once', async () => {
    const { initial, steps } = await recordRun();
    expect(steps.map((step) => step.command.type)).toEqual([
      'seal_work',
      ...Array.from({ length: 3 }, () => ['start_attempt', 'finish_attempt']).flat(),
      'complete',
    ]);
    let before = validateAgenticReceipt(initial, initial);
    const counters = { validations: 0 };
    const restore = countSnapshotValidations(counters);
    try {
      for (const { command, requestedAt, response } of steps) {
        const expected = completeCheck(response, before, command, requestedAt);
        counters.validations = 0;
        before = validateAgenticReceipt(response, before, command, requestedAt);
        expect(before).toEqual(expected);
        // An attempt is proved from verified state; anything else validates the response.
        expect(counters.validations).toBe(isAttempt(command) ? 0 : 1);
      }
    } finally {
      restore();
    }
  });

  it('rejects stale, forged, foreign and malformed responses like the complete check', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    for (const [index, { command, requestedAt, response }] of steps.entries()) {
      const forged = structuredClone(response);
      forged.charged += 1;
      const foreign = steps[index + 1]?.response ?? initial;
      for (const candidate of [before, forged, foreign, {}, null]) {
        const expected = outcome(() => completeCheck(candidate, before, command, requestedAt));
        expect(expected.error).toMatch(/^AgenticStateError: Agentic state corrupt/);
        expect(
          outcome(() => validateAgenticReceipt(candidate, before, command, requestedAt))
        ).toEqual(expected);
      }
      before = validateAgenticReceipt(response, before, command, requestedAt);
    }
  });

  it('takes the complete check for coordinator state it cannot prove unchanged', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    for (const { command, requestedAt, response } of steps) {
      before = validateAgenticReceipt(response, before, command, requestedAt);
      if (command.type === 'start_attempt') break;
    }
    const finish = steps.find((step) => step.command.type === 'finish_attempt')!;
    // Verified state cannot be changed in place, which is what makes it safe to rely on.
    expect(() => {
      before.work[0]!.assignment.processed_keys[0]!.pair_id = 'changed';
    }).toThrow(TypeError);
    // A changed copy is not verified state: it takes the complete check, which rejects it.
    const changed = structuredClone(before);
    changed.work[0]!.assignment.processed_keys[0]!.pair_id = 'changed';
    expect(
      outcome(() =>
        validateAgenticReceipt(finish.response, changed, finish.command, finish.requestedAt)
      ).error
    ).toMatch(/^ZodError/);
    // An equal copy is not the validated object, so it also takes the complete check.
    const { initial: first, steps: again } = await recordRun();
    const copy = structuredClone(validateAgenticReceipt(first, first));
    const step = again[0]!;
    const counters = { validations: 0 };
    const restore = countSnapshotValidations(counters);
    try {
      expect(validateAgenticReceipt(step.response, copy, step.command, step.requestedAt)).toEqual(
        completeCheck(step.response, copy, step.command, step.requestedAt)
      );
    } finally {
      restore();
    }
    expect(counters.validations).toBeGreaterThan(0);
  });

  /** Every path to a value in `value`, including those inside untouched work items. */
  function everyPath(value: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (typeof value !== 'object' || value === null) return [path];
    const children = Object.entries(value).flatMap(([key, child]) =>
      everyPath(child, [...path, Array.isArray(value) ? Number(key) : key])
    );
    return [path, ...children];
  }
  function changedAt(response: AgenticRunSnapshot, path: (string | number)[], how: string) {
    const copy = structuredClone(response) as unknown as Record<string | number, unknown>;
    if (path.length === 0) return copy;
    let parent = copy;
    for (const key of path.slice(0, -1)) parent = parent[key] as typeof parent;
    const key = path.at(-1)!;
    const value = parent[key];
    if (how === 'remove') {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key];
    } else if (how === 'undefined') parent[key] = undefined;
    else if (typeof value === 'string') parent[key] = `${value}x`;
    else if (typeof value === 'number') parent[key] = value + 1;
    else if (typeof value === 'boolean') parent[key] = !value;
    else if (value === null) parent[key] = 0;
    else if (Array.isArray(value)) value.push(null);
    else (value as Record<string, unknown>).added = 1;
    return copy;
  }

  it('gives a copied response the verdict of the complete check, whatever was changed', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    let attempts = 0;
    for (const { command, requestedAt, response } of steps) {
      if (isAttempt(command)) {
        attempts++;
        for (const path of everyPath(response)) {
          for (const how of ['change', 'remove', 'undefined']) {
            const candidate = changedAt(response, path, how);
            const expected = outcome(() => completeCheck(candidate, before, command, requestedAt));
            expect(
              outcome(() => validateAgenticReceipt(candidate, before, command, requestedAt)),
              `${how} ${path.join('.')}`
            ).toEqual(expected);
          }
        }
      }
      before = validateAgenticReceipt(response, before, command, requestedAt);
    }
    expect(attempts).toBe(6);
  }, 60_000);

  /** Ways to build a response that holds the right values and yet is not plain JSON. */
  class List extends Array {}
  class ListWithJson extends Array {
    toJSON() {
      return [];
    }
  }
  type Change = (
    node: never,
    parent: Record<string | number, unknown>,
    key: string | number
  ) => void;
  const asRecord = (node: never) => node as unknown as Record<string | symbol, unknown>;
  const oddObjects: Record<string, Change> = {
    'null prototype': (node, parent, key) => {
      parent[key] = Object.assign(Object.create(null), node);
    },
    'symbol key': (node) => void (asRecord(node)[Symbol('extra')] = 1),
    'hidden key': (node) => void Object.defineProperty(node, 'hidden', { value: 1 }),
    'hidden toJSON': (node) => {
      const copy = structuredClone(node);
      Object.defineProperty(node, 'toJSON', { value: () => copy });
    },
    getters: (node) => {
      for (const [key, value] of Object.entries(node)) {
        Object.defineProperty(node, key, { get: () => value as unknown, enumerable: true });
      }
    },
    proxy: (node, parent, key) => void (parent[key] = new Proxy(node as object, {})),
    frozen: (node) => void Object.freeze(node),
  };
  const oddArrays: Record<string, Change> = {
    subclass: (node, parent, key) => void (parent[key] = List.from(node as unknown[])),
    'subclass with toJSON': (node, parent, key) => {
      parent[key] = ListWithJson.from(node as unknown[]);
    },
    'extra field': (node) => void (asRecord(node).extra = 1),
    'extra constructor': (node) => void (asRecord(node).constructor = 1),
    'extra function': (node) => void (asRecord(node).extra = () => 1),
    'extra cycle': (node) => void (asRecord(node).extra = node),
    'extra Infinity': (node) => void (asRecord(node).extra = Infinity),
    'symbol key': (node) => void (asRecord(node)[Symbol('extra')] = 1),
    proxy: (node, parent, key) => void (parent[key] = new Proxy(node as object, {})),
    frozen: (node) => void Object.freeze(node),
  };
  function everyNode(
    value: unknown,
    parent: Record<string | number, unknown>,
    key: string | number,
    nodes: { value: never; parent: typeof parent; key: string | number }[] = []
  ) {
    if (typeof value !== 'object' || value === null) return nodes;
    nodes.push({ value: value as never, parent, key });
    for (const [name, child] of Object.entries(value)) {
      const next = Array.isArray(value) ? Number(name) : name;
      everyNode(child, value as typeof parent, next, nodes);
    }
    return nodes;
  }

  it('gives a response that is not plain JSON the verdict of the complete check', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    const verdicts: Record<string, number> = {};
    for (const { command, requestedAt, response } of steps) {
      if (isAttempt(command)) {
        const shape = everyNode(structuredClone(response), {}, 'reply');
        for (const position of shape.keys()) {
          // The definition is large and takes no part in an attempt, so a sample of it will do.
          if (position % 7 && JSON.stringify(shape[position]!.value).length > 2000) continue;
          const oddities = Array.isArray(shape[position]!.value) ? oddArrays : oddObjects;
          for (const [name, change] of Object.entries(oddities)) {
            const holder: { reply: unknown } = { reply: structuredClone(response) };
            const target = everyNode(holder.reply, holder, 'reply')[position]!;
            change(target.value, target.parent, target.key);
            const candidate = holder.reply;
            const expected = outcome(() => completeCheck(candidate, before, command, requestedAt));
            expect(
              outcome(() => validateAgenticReceipt(candidate, before, command, requestedAt)),
              `${name} at ${String(target.key)}`
            ).toEqual(expected);
            const verdict = `${name}: ${expected.error ? 'refused' : 'accepted'}`;
            verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
          }
        }
      }
      before = validateAgenticReceipt(response, before, command, requestedAt);
    }
    // The cases that drove this test: the complete check refuses these, so a response must not pass.
    for (const name of ['extra constructor', 'extra function', 'extra cycle', 'extra Infinity']) {
      expect(verdicts[`${name}: refused`]).toBeGreaterThan(0);
    }
    expect(verdicts['symbol key: refused']).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a finish time outside the request', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    for (const { command, requestedAt, response } of steps) {
      if (command.type === 'finish_attempt') {
        const finishedAt = response.work[command.work]!.attempts.at(-1)!.finished_at!;
        const at = (offset: number) => {
          const candidate = structuredClone(response);
          const attempt = candidate.work[command.work]!.attempts.at(-1)!;
          attempt.finished_at = new Date(Date.parse(finishedAt) + offset).toISOString();
          return candidate;
        };
        const check = (candidate: unknown, sentAt: number) =>
          outcome(() => validateAgenticReceipt(candidate, before, command, sentAt));
        // Finished before the request was made, and finished in the future.
        expect(check(response, Date.parse(finishedAt) + 1).error).toMatch(/corrupt/);
        expect(check(at(3_600_000), requestedAt).error).toMatch(/corrupt/);
        expect(check(response, Date.parse(finishedAt)).value).toEqual(response);
      }
      before = validateAgenticReceipt(response, before, command, requestedAt);
    }
  });

  it('refuses a response with the right values in the wrong shape', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    const [seal, start] = steps;
    before = validateAgenticReceipt(seal!.response, before, seal!.command, seal!.requestedAt);
    class Snapshot {}
    const { command, requestedAt, response } = start!;
    const inner = structuredClone(response);
    Object.setPrototypeOf(inner.work[0]!, Snapshot.prototype);
    const nulled = structuredClone(response);
    Object.setPrototypeOf(nulled.work[0]!, null);
    for (const candidate of [
      Object.assign(new Snapshot(), structuredClone(response)),
      inner,
      { ...structuredClone(response), extra: undefined },
      { ...structuredClone(response), work: { ...structuredClone(response).work } },
    ]) {
      const expected = outcome(() => completeCheck(candidate, before, command, requestedAt));
      expect(expected.error).toMatch(/^AgenticStateError: Agentic state corrupt/);
      expect(
        outcome(() => validateAgenticReceipt(candidate, before, command, requestedAt))
      ).toEqual(expected);
    }
    // A null prototype is plain JSON to the complete check, so it stays accepted here too.
    expect(validateAgenticReceipt(nulled, before, command, requestedAt)).toEqual(
      completeCheck(nulled, before, command, requestedAt)
    );
  });

  it('keeps a copied response out of the state it returns', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    for (const { command, requestedAt, response } of steps) {
      const reply = structuredClone(response);
      const next = validateAgenticReceipt(reply, before, command, requestedAt);
      expect(next).not.toBe(reply);
      expect(isVerifiedCheckpoint(next)).toBe(true);
      // The store still owns its reply, so nothing in it was frozen.
      expect(Object.isFrozen(reply)).toBe(false);
      expect(Object.isFrozen(reply.work[0] ?? {})).toBe(false);
      reply.charged = -1;
      before = next;
    }
    expect(before.charged).toBeGreaterThan(0);
  });

  it('adopts a response that shares verified state, without validating it', async () => {
    const { initial, steps } = await recordRun();
    let before = validateAgenticReceipt(initial, initial);
    const counters = { validations: 0 };
    let proved = 0;
    for (const { command, requestedAt, response } of steps) {
      if (!isAttempt(command)) {
        if (command.type === 'complete') break;
        before = validateAgenticReceipt(response, before, command, requestedAt);
        continue;
      }
      const sentAt = Date.now();
      const reply = applyAgenticCheckpoint(before, command);
      const restore = countSnapshotValidations(counters);
      const next = validateAgenticReceipt(reply, before, command, sentAt);
      restore();
      expect(next).toBe(reply);
      expect(next.work.filter((work, index) => work !== before.work[index])).toHaveLength(1);
      before = next;
      proved++;
    }
    expect(proved).toBe(6);
    expect(counters.validations).toBe(0);
  });
});
