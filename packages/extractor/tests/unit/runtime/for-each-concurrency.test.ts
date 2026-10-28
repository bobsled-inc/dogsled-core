import { describe, expect, it } from 'vitest';

import {
  EMPTY_FAN_OUT_CONTEXT,
  FanOutPrimaryKeyTracker,
  assertCompleteFanOutContext,
  extendFanOutContext,
  getContextProjectionValues,
  getFanOutContextOutput,
  normalizeForEachConfig,
  runWithConcurrency,
} from '../../../src/runtime/for-each.js';
import { makeResource } from '../../helpers/fixtures.js';

/**
 * A manually-advanced promise — resolve()/reject() are exposed so the test
 * can pause workers mid-flight and assert how many ran in parallel.
 */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runWithConcurrency', () => {
  it('runs strictly sequentially when concurrency is 1', async () => {
    const items = ['a', 'b', 'c'];
    const inFlight: string[] = [];
    let maxObserved = 0;
    const gates = items.map(() => deferred());

    const run = runWithConcurrency(items, 1, async (item) => {
      inFlight.push(item);
      maxObserved = Math.max(maxObserved, inFlight.length);
      const gate = gates[items.indexOf(item)]!;
      await gate.promise;
      inFlight.splice(inFlight.indexOf(item), 1);
    });

    // Yield to the microtask queue so the first worker can latch.
    await new Promise((r) => setImmediate(r));
    expect(inFlight).toEqual(['a']);

    gates[0]!.resolve();
    await new Promise((r) => setImmediate(r));
    expect(inFlight).toEqual(['b']);

    gates[1]!.resolve();
    await new Promise((r) => setImmediate(r));
    expect(inFlight).toEqual(['c']);

    gates[2]!.resolve();
    await run;
    expect(maxObserved).toBe(1);
  });

  it('starts up to N items in parallel when concurrency is N', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const inFlight = new Set<string>();
    let maxObserved = 0;
    const gates = new Map(items.map((item) => [item, deferred()]));

    const run = runWithConcurrency(items, 4, async (item) => {
      inFlight.add(item);
      maxObserved = Math.max(maxObserved, inFlight.size);
      await gates.get(item)!.promise;
      inFlight.delete(item);
    });

    await new Promise((r) => setImmediate(r));
    // First four should latch before any resolves.
    expect(inFlight.size).toBe(4);
    expect(inFlight.has('a')).toBe(true);
    expect(inFlight.has('d')).toBe(true);
    expect(inFlight.has('e')).toBe(false);

    // Drain in arbitrary order — the dispatcher should fill freed slots.
    gates.get('a')!.resolve();
    await new Promise((r) => setImmediate(r));
    expect(inFlight.has('e')).toBe(true);

    for (const g of gates.values()) g.resolve();
    await run;
    expect(maxObserved).toBe(4);
  });

  it('clamps concurrency to the number of items', async () => {
    const items = ['a', 'b'];
    let maxObserved = 0;
    let inFlight = 0;
    await runWithConcurrency(items, 32, async () => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
    });
    expect(maxObserved).toBe(2);
  });

  it('returns immediately on empty input without invoking the worker', async () => {
    let calls = 0;
    await runWithConcurrency([], 8, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('lets the caller swallow per-iteration failures without cancelling siblings', async () => {
    const items = ['ok-1', 'fail', 'ok-2', 'ok-3'];
    const completed: string[] = [];
    const warnings: string[] = [];

    // Mirrors the extract loop's per-iteration try/catch + warn pattern.
    await runWithConcurrency(items, 2, async (item) => {
      try {
        if (item === 'fail') {
          throw new Error(`boom: ${item}`);
        }
        await new Promise((r) => setImmediate(r));
        completed.push(item);
      } catch (err) {
        // Async warn — must drain before runWithConcurrency resolves.
        await new Promise((r) => setImmediate(r));
        warnings.push((err as Error).message);
      }
    });

    expect(completed.sort()).toEqual(['ok-1', 'ok-2', 'ok-3']);
    expect(warnings).toEqual(['boom: fail']);
  });

  it('drains async work queued inside the worker before resolving', async () => {
    const items = [1, 2, 3, 4];
    const flushed: number[] = [];

    await runWithConcurrency(items, 2, async (n) => {
      // Schedule the push at the end of the microtask queue. If runWithConcurrency
      // returned before awaiting the inner work, `flushed` would be empty.
      await new Promise((r) => setImmediate(r));
      flushed.push(n);
    });

    expect(flushed.sort()).toEqual([1, 2, 3, 4]);
  });

  it('lets every started worker settle before surfacing an uncaught throw', async () => {
    // Locks in the all-settle-then-reject contract: if a worker throws without
    // its own try/catch, in-flight siblings must still drain before
    // runWithConcurrency rejects.
    const items = ['fail', 'ok-1', 'ok-2', 'ok-3'];
    const gates = new Map(items.map((item) => [item, deferred()]));
    const completed: string[] = [];
    const started: string[] = [];

    const run = runWithConcurrency(items, 2, async (item) => {
      started.push(item);
      await gates.get(item)!.promise;
      if (item === 'fail') {
        throw new Error(`boom: ${item}`);
      }
      completed.push(item);
    });

    // Let the first wave latch onto their gates before we release anything.
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['fail', 'ok-1']);

    // Releasing the failing iteration must not abort the sibling.
    gates.get('fail')!.resolve();
    await new Promise((r) => setImmediate(r));
    // The freed slot should pick up the next item, not bail out.
    expect(started).toContain('ok-2');

    // Drain the rest.
    for (const [, gate] of gates) gate.resolve();

    await expect(run).rejects.toThrow('boom: fail');
    // Every non-throwing iteration that was started must have completed.
    expect(completed.sort()).toEqual(['ok-1', 'ok-2', 'ok-3']);
  });

  it('preserves shared mutable state across iterations regardless of completion order', async () => {
    // Mirrors extract.ts:498 — many iterations push into a shared cache array
    // via onRecord callbacks. Order may vary, but every iteration's record
    // must end up present.
    const items = Array.from({ length: 20 }, (_, i) => i);
    const cache: number[] = [];

    await runWithConcurrency(items, 5, async (i) => {
      // Random-ish delay to interleave completions.
      await new Promise((r) => setTimeout(r, (i * 13) % 7));
      cache.push(i * 10);
    });

    expect(cache.sort((a, b) => a - b)).toEqual(items.map((i) => i * 10));
  });
});

describe('normalizeForEachConfig — concurrency', () => {
  it('defaults concurrency to 1 when omitted (legacy form)', () => {
    const normalized = normalizeForEachConfig({
      resource: 'parents',
      field: 'id',
      input: 'parent_id',
    });
    expect(normalized?.concurrency).toBe(1);
  });

  it('defaults concurrency to 1 when omitted (bindings form)', () => {
    const normalized = normalizeForEachConfig({
      resource: 'parents',
      bindings: [{ field: 'id', input: 'parent_id' }],
    });
    expect(normalized?.concurrency).toBe(1);
  });

  it('threads through an explicit concurrency value (legacy form)', () => {
    const normalized = normalizeForEachConfig({
      resource: 'parents',
      field: 'id',
      input: 'parent_id',
      concurrency: 8,
    });
    expect(normalized?.concurrency).toBe(8);
  });

  it('threads through an explicit concurrency value (bindings form)', () => {
    const normalized = normalizeForEachConfig({
      resource: 'parents',
      bindings: [{ field: 'id', input: 'parent_id' }],
      concurrency: 12,
    });
    expect(normalized?.concurrency).toBe(12);
  });
});

describe('fan-out lineage context', () => {
  it('creates isolated immutable ancestry snapshots', () => {
    const source = { id: 1, nested: { name: 'first' } };
    const first = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', source);
    const second = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 2 });
    source.id = 999;
    source.nested.name = 'mutated';

    expect(getFanOutContextOutput(first, 'projects')).toEqual({
      id: 1,
      nested: { name: 'first' },
    });
    expect(getFanOutContextOutput(second, 'projects')).toEqual({ id: 2 });
  });

  it('uses projected context values as part of a dedupe identity', () => {
    const output = {
      project_id: {
        type: 'integer' as const,
        from: { resource: 'projects', path: '$.id' },
      },
    };
    const first = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 1 });
    const second = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 2 });

    expect(getContextProjectionValues(output, first)).toEqual([1]);
    expect(getContextProjectionValues(output, second)).toEqual([2]);
  });

  it('rejects an iteration before requesting when required context is missing', () => {
    expect(() =>
      assertCompleteFanOutContext(
        'events',
        {
          project_id: {
            type: 'integer',
            from: { resource: 'projects', path: '$.id' },
          },
        },
        EMPTY_FAN_OUT_CONTEXT
      )
    ).toThrow(/Incomplete fan-out context/);
  });

  it('detects equal primary keys under distinct contexts without false positives', () => {
    const resource = makeResource({
      name: 'events',
      output: {
        id: { type: 'string', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
      extract: { table: { primary_key: ['id'] } },
    });
    const tracker = new FanOutPrimaryKeyTracker(resource);
    const projectOne = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 1 });
    const projectTwo = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 2 });

    tracker.observe({ id: 'same', project_id: 1 }, projectOne);
    tracker.observe({ id: 'same', project_id: 1 }, projectOne);
    tracker.observe({ id: 'same', project_id: 2 }, projectTwo);

    expect(tracker.report()).toEqual({ observed: 3, collisions: 1, truncated: false });
  });

  it('bounds primary-key collision state and reports truncation', () => {
    const resource = makeResource({
      name: 'events',
      output: {
        id: { type: 'string', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
      extract: { table: { primary_key: ['id'] } },
    });
    const tracker = new FanOutPrimaryKeyTracker(resource, 1);
    const context = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', { id: 1 });

    tracker.observe({ id: 'one', project_id: 1 }, context);
    tracker.observe({ id: 'two', project_id: 1 }, context);

    expect(tracker.report()).toEqual({ observed: 2, collisions: 0, truncated: true });
  });
});
