import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import type { AgenticStateStore } from '../../../src/agentic/state.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';
import { runFixture } from './state-fixture.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));

// Opt-in measurement, not a wall-clock regression gate. The store and executor are real;
// the runner is a deterministic transport double with optional simulated request latency.
describe.skipIf(process.env.CHECKPOINT_BENCHMARK !== '1')('checkpoint transport benchmark', () => {
  it.each([1, 5, 100, 300])(
    '%s assignments',
    async (assignments) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      try {
        const latencyMs = Number(process.env.CHECKPOINT_BENCHMARK_LATENCY_MS ?? 1);
        const transport = checkpointTransport(latencyMs, false);
        resolve.mockResolvedValue(transport.runner);
        const f = runFixture(assignments);
        f.model.limits = {};
        f.model.plan.steps[0]!.instructions = 'Synthetic checkpoint benchmark. '.repeat(
          Math.max(12, Math.floor(800 / Math.sqrt(assignments)))
        );
        f.host.inputs.undecided_pairs!.push({ name: 'evidence', type: 'string', nullable: false });
        f.host.prepare = async () =>
          Array.from({ length: assignments }, (_, index) => ({
            pair_id: `p${index}`,
            evidence: 'e'.repeat(Math.max(256, Math.floor(4096 / Math.sqrt(assignments)))),
          }));
        const baselineModule = '../../../src/agentic/warehouse-state.baseline.js';
        const createStore: typeof createWarehouseCheckpointStore =
          process.env.CHECKPOINT_BENCHMARK_BASELINE === '1'
            ? (await import(baselineModule)).createWarehouseCheckpointStore
            : createWarehouseCheckpointStore;
        const base = createStore(checkpointIntegrations[1]!, {
          schema: 'checkpoint_benchmark',
        });
        let checkpointMs = 0;
        const store: AgenticStateStore = {
          async acquire(key) {
            const session = await base.acquire(key);
            return {
              ...session,
              async create(value) {
                const start = performance.now();
                try {
                  return await session.create(value);
                } finally {
                  checkpointMs += performance.now() - start;
                }
              },
              async checkpoint(command) {
                const start = performance.now();
                try {
                  return await session.checkpoint(command);
                } finally {
                  checkpointMs += performance.now() - start;
                }
              },
            };
          },
        };
        const start = performance.now();
        const result = await executeAgenticRun(f.host, f.context(), {
          projectDirectory: '/unused',
          stateStore: store,
          run: { id: 'synthetic', mode: 'start' },
        });
        const executorMs = performance.now() - start;
        expect(result.chargedTokens).toBe(assignments * 2);
        process.stdout.write(
          `${JSON.stringify({ assignments, latencyMs, operations: transport.operations, totalRequests: Object.values(transport.operations).reduce((a, b) => a + b, 0), payloadBytes: transport.bytes, checkpointMs: Math.round(checkpointMs), executorMs: Math.round(executorMs) })}\n`
        );
      } finally {
        vi.useRealTimers();
      }
    },
    900000
  );
});
