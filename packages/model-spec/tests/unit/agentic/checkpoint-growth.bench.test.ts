import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultAgenticStateStore } from '../../../src/agentic/default-state.js';
import { createAgenticProgressReporter } from '../../../src/agentic/progress.js';
import { AGENTIC_MAX_ROWS } from '../../../src/agentic/rows.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { scheduleAgenticAssignments } from '../../../src/agentic/schedule.js';
import { applyAgenticCheckpoint } from '../../../src/agentic/state.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../../src/agentic/state.js';
import {
  benchmarkWorkload,
  profiled,
  sharedMemoryStore,
  type BenchmarkShape,
} from '../../support/agentic-benchmark.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';
import { MemoryStateStore } from './state-fixture.js';

const hashed = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('json-canonicalize', async (original) => {
  const module = await original<typeof import('json-canonicalize')>();
  return {
    ...module,
    canonicalize: (value: unknown, allowCircular?: boolean) => {
      const text = module.canonicalize(value, allowCircular);
      hashed.bytes += text?.length ?? 0;
      return text;
    },
  };
});

// A checkpoint must cost the same in a large run as in a small one. These tests run on every
// change, at the default row limit, the most a supplied store holds; row-store-growth.bench.test.ts
// takes the row store up to its own. Counts come first: they do not depend on the machine, and
// they name what grew. The clock then catches a pass over the run that no count sees, and
// compares two sizes in one process, so a slow runner slows both.
const SMALL = 100;
const LARGE = AGENTIC_MAX_ROWS;
const PAYLOAD = 1000;
/** The target at 2,000 assignments is twice the figure at 100; 1,000 has no cause to do worse. */
const MAX_GROWTH = 2;
/** A large run takes seconds, or half a minute on a busy runner. Growth takes hours there. */
const RUN_BUDGET_MS = 150_000;

const run = (
  workload: ReturnType<typeof benchmarkWorkload>,
  signal?: AbortSignal,
  stateStore = sharedMemoryStore()
) =>
  executeAgenticRun(workload.host, workload.context(), {
    projectDirectory: '/unused',
    stateStore,
    run: { id: 'growth', mode: 'start' },
    onProgress: () => {},
    ...(signal ? { signal } : {}),
  });

/** A run inside the budget, so that returning growth fails here and names the cause. */
const budgeted = (
  workload: ReturnType<typeof benchmarkWorkload>,
  assignments: number,
  stateStore?: AgenticStateStore
) =>
  run(workload, AbortSignal.timeout(RUN_BUDGET_MS), stateStore).catch((error: unknown) => {
    throw new Error(
      `${assignments} assignments did not finish in ${RUN_BUDGET_MS} ms. The cost of a checkpoint is growing with the run.`,
      { cause: error }
    );
  });

/** Replies as a store that keeps its state elsewhere does: with a copy. */
function copyingStore(): AgenticStateStore {
  const store = sharedMemoryStore();
  return {
    ...(store.limits ? { limits: store.limits } : {}),
    async acquire(key) {
      const session = await store.acquire(key);
      return {
        ...session,
        checkpoint: async (command) =>
          JSON.parse(JSON.stringify(await session.checkpoint(command))) as AgenticRunSnapshot,
      };
    },
  };
}

/** What one run reads in bulk, per assignment, and how often it validates the whole snapshot. */
async function counted(assignments: number, shape: BenchmarkShape, stateStore?: AgenticStateStore) {
  const workload = benchmarkWorkload(assignments, shape, PAYLOAD);
  const counters = { validations: 0 };
  let serialized = 0;
  hashed.bytes = 0;
  const stringify = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args) as string | undefined;
    serialized += text?.length ?? 0;
    return text;
  }) as typeof JSON.stringify;
  const restore = countSnapshotValidations(counters);
  try {
    await budgeted(workload, assignments, stateStore);
  } finally {
    restore();
    JSON.stringify = stringify;
  }
  return {
    validations: counters.validations,
    hashedPerAssignment: hashed.bytes / assignments,
    serializedPerAssignment: serialized / assignments,
  };
}

/** Median gap between model calls over the last quarter of a run, when its state is largest. */
async function lateCheckpointMs(assignments: number, shape: BenchmarkShape) {
  const workload = benchmarkWorkload(assignments, shape, PAYLOAD);
  const { executeAgent } = workload.host;
  const calls: number[] = [];
  workload.host.executeAgent = (request) => {
    calls.push(performance.now());
    return executeAgent(request);
  };
  await budgeted(workload, assignments);
  const gaps = calls.slice(1).map((time, index) => time - calls[index]!);
  const late = gaps.slice(Math.floor(gaps.length * 0.75)).sort((a, b) => a - b);
  return late[Math.floor(late.length / 2)]!;
}

/** Counts reads of `snapshot.work` items, which a pass over the run cannot avoid. */
function countingReads(snapshot: AgenticRunSnapshot, reads: { count: number }): AgenticRunSnapshot {
  return {
    ...snapshot,
    work: new Proxy(snapshot.work, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  };
}

/** A run with `assignments` sealed items and no attempts yet. */
async function sealedState(assignments: number): Promise<AgenticRunSnapshot> {
  const workload = benchmarkWorkload(assignments, 'map', PAYLOAD);
  workload.host.executeAgent = () => Promise.reject(new Error('Stop at the first model call.'));
  const store = new MemoryStateStore();
  await executeAgenticRun(workload.host, workload.context(), {
    projectDirectory: '/unused',
    stateStore: store,
    run: { id: 'reads', mode: 'start' },
  }).catch(() => undefined);
  return [...store.runs.values()][0]!;
}

// Opt-in measurement behind the table in docs/agentic-state.md.
describe.skipIf(process.env.CHECKPOINT_BENCHMARK !== '1')('checkpoint cost by run size', () => {
  const sizes = (process.env.CHECKPOINT_BENCHMARK_SIZES ?? `${SMALL},${LARGE}`).split(',');
  it.each(sizes.map(Number))(
    '%s assignments',
    async (assignments) => {
      for (const [replies, stateStore] of [
        ['shared', sharedMemoryStore()],
        ['copied', copyingStore()],
      ] as const) {
        const workload = benchmarkWorkload(assignments, 'map', PAYLOAD);
        const start = performance.now();
        const { cpu } = await profiled(
          process.env.CHECKPOINT_BENCHMARK_PROFILE,
          `checkpoint-growth-${replies}-${assignments}`,
          () => run(workload, undefined, stateStore)
        );
        const msPerAssignment = (performance.now() - start) / assignments;
        process.stdout.write(`${JSON.stringify({ assignments, replies, msPerAssignment, cpu })}\n`);
      }
    },
    7_200_000
  );
});

describe('checkpoint cost as a run grows', () => {
  it.each(['map', 'plan'] as const)(
    '%s: a run validates the same number of times and reads the same per assignment',
    async (shape) => {
      const small = await counted(SMALL, shape);
      const large = await counted(LARGE, shape);
      expect(large.validations).toBe(small.validations);
      expect(large.hashedPerAssignment).toBeLessThan(small.hashedPerAssignment * 1.25);
      expect(large.serializedPerAssignment).toBeLessThan(small.serializedPerAssignment * 1.25);
    },
    2 * RUN_BUDGET_MS + 60_000
  );

  it.each(['map', 'plan'] as const)(
    '%s: a late checkpoint in a large run costs what one costs in a small run',
    async (shape) => {
      await lateCheckpointMs(SMALL, shape); // The first run pays for compilation.
      const growth: number[] = [];
      // Noise only adds time, and growth shows in every round, so the best round decides.
      for (let round = 0; round < 3 && !(Math.min(...growth) <= MAX_GROWTH); round++) {
        const small = await lateCheckpointMs(SMALL, shape);
        growth.push((await lateCheckpointMs(LARGE, shape)) / small);
      }
      expect(Math.min(...growth)).toBeLessThanOrEqual(MAX_GROWTH);
    },
    4 * RUN_BUDGET_MS
  );

  it('keeps the row store from reading the run on every checkpoint', async () => {
    const onRowStore = async (assignments: number) => {
      const directory = mkdtempSync(join(tmpdir(), 'dogsled-growth-'));
      try {
        const result = await counted(assignments, 'map', createDefaultAgenticStateStore(directory));
        // The default store falls back to files without DuckDB, which would prove nothing here.
        const files = readdirSync(join(directory, '.dogsled/model-spec/agentic-state'));
        expect(files.some((name) => name.endsWith('.duckdb'))).toBe(true);
        return result;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    const small = await onRowStore(25);
    const large = await onRowStore(SMALL);
    expect(large.validations).toBe(small.validations);
    expect(large.serializedPerAssignment).toBeLessThan(small.serializedPerAssignment * 1.25);
  }, 120_000);

  it('schedules each attempt without passing over the run', async () => {
    const reads = { count: 0 };
    let saved = await sealedState(200);
    const perCheckpoint: number[] = [];
    const workload = benchmarkWorkload(200, 'map', PAYLOAD);
    await scheduleAgenticAssignments(workload.host, {
      snapshot: saved,
      checkpoint: async (command: AgenticCheckpointCommand) => {
        perCheckpoint.push(reads.count);
        reads.count = 0;
        saved = applyAgenticCheckpoint(saved, command);
        return countingReads(saved, reads);
      },
      signal: new AbortController().signal,
      abort: () => {},
      concurrency: 2,
      minDispatchIntervalMs: 0,
    });
    expect(perCheckpoint.length).toBeGreaterThanOrEqual(400);
    // The first look at the saved run reads it once, by design. After that, a few items each.
    expect(Math.max(...perCheckpoint.slice(1))).toBeLessThan(20);
  }, 30_000);

  it('reports an attempt without passing over the run', async () => {
    const report = createAgenticProgressReporter(['assess']);
    const reads = { count: 0 };
    let saved = await sealedState(200);
    let reported = countingReads(saved, reads);
    report(reported);
    for (let work = 0; work < 50; work++) {
      const command: AgenticCheckpointCommand = {
        type: 'start_attempt',
        operation_id: `start_attempt:${work}`,
        expected_revision: saved.revision,
        work,
        attempt_id: String(work),
        charge: 1,
        charge_microusd: 1,
      };
      saved = applyAgenticCheckpoint(saved, command);
      const next = countingReads(saved, reads);
      reads.count = 0;
      expect(report(next, reported, command).running).toBe(work + 1);
      expect(reads.count).toBeLessThan(5);
      reported = next;
    }
  }, 30_000);
});
