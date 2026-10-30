import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';
import {
  benchmarkWorkload,
  heapSampler,
  median,
  phaseTimer,
  profiled,
  timedStore,
  type BenchmarkShape,
} from '../../support/agentic-benchmark.js';

const resolve = vi.hoisted(() => vi.fn());
const counters = vi.hoisted(() => ({ validations: 0, digests: 0, digestBytes: 0 }));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
vi.mock('json-canonicalize', async (original) => {
  const module = await original<typeof import('json-canonicalize')>();
  return {
    ...module,
    canonicalize: (value: unknown, allowCircular?: boolean) => {
      const text = module.canonicalize(value, allowCircular);
      counters.digests++;
      counters.digestBytes += text?.length ?? 0;
      return text;
    },
  };
});

const env = process.env;
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(',');
const sizes = list(env.CHECKPOINT_BENCHMARK_SIZES, '0,5,100,300').map(Number);
const shapes = list(env.CHECKPOINT_BENCHMARK_SHAPES, 'map,plan') as BenchmarkShape[];
const latencyMs = Number(env.CHECKPOINT_BENCHMARK_LATENCY_MS ?? 0);
const samples = Number(env.CHECKPOINT_BENCHMARK_SAMPLES ?? 3);

async function measure(shape: BenchmarkShape, assignments: number) {
  const transport = checkpointTransport(latencyMs, false);
  resolve.mockResolvedValue(transport.runner);
  const workload = benchmarkWorkload(assignments, shape);
  const heap = heapSampler();
  const timer = phaseTimer(heap.sample);
  Object.assign(counters, { validations: 0, digests: 0, digestBytes: 0 });
  const restore = countSnapshotValidations(counters);
  const start = performance.now();
  try {
    const result = await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: '/unused',
      stateStore: timedStore(
        createWarehouseCheckpointStore(checkpointIntegrations[1]!, {
          schema: 'checkpoint_benchmark',
        }),
        timer
      ),
      run: { id: 'synthetic', mode: 'start' },
    });
    const executorMs = performance.now() - start;
    expect(result.chargedTokens).toBe(assignments * 60);
    expect(result.rows).toHaveLength(assignments - (shape === 'plan' ? assignments / 5 : 0));
    const snapshot = (transport.payloads.get(transport.pointer) ?? []).map((row) => row.data);
    return {
      executorMs,
      phases: timer.phases,
      operations: { ...transport.operations },
      payloadBytesWritten: transport.bytes,
      payloadBytesRead: transport.readBytes,
      finalSnapshotBytes: Buffer.from(snapshot.join(''), 'base64').byteLength,
      snapshotValidations: counters.validations,
      canonicalDigests: counters.digests,
      canonicalDigestBytes: counters.digestBytes,
      ...heap.result(),
    };
  } finally {
    restore();
  }
}

// Opt-in measurement, not a wall-clock regression gate. The executor, scheduler, checkpoint
// store and receipts are real; the runner is a deterministic transport double with optional
// simulated request latency. Dates are frozen so both versions write identical payloads.
describe.skipIf(env.CHECKPOINT_BENCHMARK !== '1')('checkpoint transport benchmark', () => {
  for (const shape of shapes) {
    it.each(sizes)(
      `${shape}: %s assignments`,
      async (assignments) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        try {
          const runs = [];
          for (let sample = 0; sample < samples; sample++) {
            runs.push(await measure(shape, assignments));
          }
          const profile = await profiled(
            env.CHECKPOINT_BENCHMARK_PROFILE,
            `${shape}-${assignments}-${latencyMs}ms`,
            () => measure(shape, assignments)
          );
          const last = runs.at(-1)!;
          const { executorMs: _executor, phases: _phases, ...counts } = last;
          process.stdout.write(
            `${JSON.stringify({
              shape,
              assignments,
              latencyMs,
              samples,
              executorMs: median(runs.map((run) => run.executorMs)),
              checkpointMs: median(runs.map((run) => run.phases.checkpoint ?? 0)),
              readMs: median(runs.map((run) => run.phases.read ?? 0)),
              executorSamplesMs: runs.map((run) => Math.round(run.executorMs)),
              ...counts,
              totalRequests: Object.values(last.operations).reduce((a, b) => a + b, 0),
              ...(profile.cpu ? { cpuMs: profile.cpu } : {}),
            })}\n`
          );
        } finally {
          vi.useRealTimers();
        }
      },
      3_600_000
    );
  }
});
