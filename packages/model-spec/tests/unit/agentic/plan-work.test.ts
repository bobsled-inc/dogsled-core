import { describe, expect, it, vi } from 'vitest';
import { buildAgenticStepAssignments } from '../../../src/agentic/plan-work.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { MemoryStateStore } from './state-fixture.js';
import { benchmarkWorkload } from '../../support/agentic-benchmark.js';

const counters = vi.hoisted(() => ({ digests: 0 }));
vi.mock('json-canonicalize', async (original) => {
  const module = await original<typeof import('json-canonicalize')>();
  return {
    ...module,
    canonicalize: (value: unknown, allowCircular?: boolean) => {
      counters.digests++;
      return module.canonicalize(value, allowCircular);
    },
  };
});

async function completedPlan(assignments: number) {
  const workload = benchmarkWorkload(assignments, 'plan');
  const store = new MemoryStateStore();
  await executeAgenticRun(workload.host, workload.context(), {
    projectDirectory: '/unused',
    stateStore: store,
    run: { id: 'plan-work', mode: 'start' },
  });
  return { workload, store, snapshot: [...store.runs.values()][0]! };
}

describe('plan step construction', () => {
  it('rebuilds a reduce over upstream markers with work linear in its rows', async () => {
    const { snapshot } = await completedPlan(50);
    const review = snapshot.work.filter((work) => work.assignment.step_id === 'review');
    expect(review).toHaveLength(10);
    counters.digests = 0;
    const rebuilt = buildAgenticStepAssignments(snapshot, 1);
    expect(rebuilt).toEqual(review.map((work) => work.assignment));
    // Forty upstream rows and forty markers without the cluster grouping field.
    expect(counters.digests).toBeLessThan(10 * 40);
  });

  it('still rejects markers whose keys have no upstream output row', async () => {
    const workload = benchmarkWorkload(10, 'plan');
    const answer = workload.host.executeAgent;
    workload.host.executeAgent = async (request) => {
      const result = await answer(request);
      // An empty answer leaves only a pair marker, which cannot supply a cluster.
      return request.assignment.processed_keys[0]!.pair_id === 'p5'
        ? { ...result, rows: [] }
        : result;
    };
    await expect(
      executeAgenticRun(workload.host, workload.context(), {
        projectDirectory: '/unused',
        stateStore: new MemoryStateStore(),
        run: { id: 'plan-work-empty', mode: 'start' },
      })
    ).rejects.toThrow('Empty work cannot supply the requested grouping keys');
  });
});
