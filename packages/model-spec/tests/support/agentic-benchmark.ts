import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { resolveAgenticModel } from '../../src/agentic/resolve.js';
import { applyAgenticCheckpointWithin } from '../../src/agentic/checkpoint-verified.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../src/agentic/state.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../src/agentic/store-limits.js';
import type { AgentExecutorRequest } from '../../src/agentic/index.js';
import { runFixture } from '../unit/agentic/state-fixture.js';

/** Deterministic synthetic workloads shared by the baseline and the candidate. */
export type BenchmarkShape = 'map' | 'plan';

/**
 * `map` has one map step with `assignments` input rows. `plan` maps four fifths of that
 * many rows, then reduces groups of four in a second step, for the same assignment count.
 * Every assignment returns accepted rows with evidence, confidence and a reason. Padding
 * shrinks as `payloadSize` grows. Pass a constant to keep each assignment the same size
 * at every run size, as a comparison of cost per assignment must.
 */
export function benchmarkWorkload(
  assignments: number,
  shape: BenchmarkShape,
  payloadSize = assignments
) {
  const groups = shape === 'plan' ? assignments / 5 : 0;
  if (!Number.isInteger(groups)) throw new Error('Plan workloads use multiples of five');
  const inputs = assignments - groups;
  const scale = Math.sqrt(Math.max(payloadSize, 1));
  const f = runFixture(inputs);
  f.model.limits = {};
  const first = f.model.plan.steps[0]!;
  first.instructions = 'Synthetic checkpoint benchmark. '.repeat(
    Math.max(12, Math.floor(800 / scale))
  );
  first.columns = [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'cluster_id', type: 'string', nullable: false },
    { name: 'assessment', type: 'string', nullable: false },
  ];
  if (shape === 'plan') {
    f.model.plan.steps.push({
      id: 'review',
      source: { ref: first.id },
      reduce: { over: first.id, group_by: ['cluster_id'] },
      execution: { mode: 'llm_call' },
      instructions: 'Review each synthetic cluster of assessments together.',
      columns: first.columns,
    });
    f.model.output.from = 'review';
  }
  f.host.inputs.undecided_pairs = [
    { name: 'pair_id', type: 'string', nullable: false },
    { name: 'cluster_id', type: 'string', nullable: false },
    { name: 'evidence', type: 'string', nullable: false },
  ];
  f.host.prepare = async () =>
    Array.from({ length: inputs }, (_, index) => ({
      pair_id: `p${index}`,
      cluster_id: `c${Math.floor(index / 4)}`,
      evidence: 'e'.repeat(Math.max(256, Math.floor(4096 / scale))),
    }));
  f.host.executeAgent = async ({ assignment, budget }: AgentExecutorRequest) => {
    const reservation = await budget.reserve(100);
    const usage = {
      status: 'measured' as const,
      input_tokens: 40,
      output_tokens: 20,
      total_tokens: 60,
    };
    await budget.settle(reservation, usage);
    const input = assignment.input;
    const cluster = (input.rows[0] as { cluster_id: string }).cluster_id;
    return {
      contract_version: 2 as const,
      attempt_id: assignment.attempt_id,
      status: 'succeeded' as const,
      usage,
      rows: assignment.processed_keys.map(({ pair_id }) => ({
        pair_id: String(pair_id),
        cluster_id: cluster,
        assessment: `Synthetic ${assignment.step_id} result for ${String(pair_id)}.`,
        _dogsled_evidence: [
          {
            source: input.ref,
            reference: `${input.ref}/${String(pair_id)}`,
            support_excerpt: 'Synthetic supporting excerpt. '.repeat(8),
            retrieved_at: input.retrieved_at!,
          },
        ],
        _dogsled_confidence: 0.75,
        _dogsled_reason: {
          summary: 'Synthetic summary of the supplied evidence.',
          supporting_factors: ['Matching synthetic attribute', 'Consistent synthetic history'],
          conflicting_factors: [],
        },
      })),
    };
  };
  const context = () => ({ ...f.context(), resolved: resolveAgenticModel(f.model, f.host) });
  return { host: f.host, model: f.model, context };
}

/**
 * The cheapest conforming store: nothing to save, and each reply is the value that the shared
 * transition returned, so storage takes no part in a measurement. It holds what the row store
 * holds, so a run can be measured at any size the row store allows.
 */
export function sharedMemoryStore(): AgenticStateStore {
  let saved: AgenticRunSnapshot | null = null;
  const limits = AGENTIC_ROW_STORE_LIMITS;
  return {
    limits,
    async acquire() {
      return {
        read: async () => saved,
        create: async (snapshot) => (saved = snapshot),
        checkpoint: async (command) =>
          (saved = applyAgenticCheckpointWithin(saved!, command, Date.now(), limits)),
        release: async () => {},
      };
    },
  };
}

/** As sharedMemoryStore, with a group commit that applies each command in turn and replies
 * with what the last returned, as the row store does. */
export function sharedGroupStore(): AgenticStateStore {
  let saved: AgenticRunSnapshot | null = null;
  const limits = AGENTIC_ROW_STORE_LIMITS;
  const apply = (state: AgenticRunSnapshot, command: AgenticCheckpointCommand) =>
    applyAgenticCheckpointWithin(state, command, Date.now(), limits);
  return {
    limits,
    async acquire() {
      return {
        read: async () => saved,
        create: async (snapshot) => (saved = snapshot),
        checkpoint: async (command) => (saved = apply(saved!, command)),
        checkpointMany: async (commands) => {
          let state = saved!;
          for (const command of commands) state = apply(state, command);
          return (saved = state);
        },
        release: async () => {},
      };
    },
  };
}

export interface PhaseTimer {
  phases: Record<string, number>;
  /** Adds the awaited duration of a call to its phase. */
  time<T>(phase: string, run: () => Promise<T>): Promise<T>;
}
export function phaseTimer(afterCall?: () => void): PhaseTimer {
  const phases: Record<string, number> = {};
  return {
    phases,
    async time(phase, run) {
      const start = performance.now();
      try {
        return await run();
      } finally {
        phases[phase] = (phases[phase] ?? 0) + performance.now() - start;
        afterCall?.();
      }
    },
  };
}

/** Times session calls by phase. It passes the store's declarations on unchanged: a wrapper that
 * dropped them would get the default limits. */
export function timedStore(base: AgenticStateStore, timer: PhaseTimer): AgenticStateStore {
  return {
    ...(base.cursors ? { cursors: base.cursors } : {}),
    ...(base.limits ? { limits: base.limits } : {}),
    ...(base.expiresRuns ? { expiresRuns: base.expiresRuns } : {}),
    async acquire(key) {
      const session = await timer.time('acquire', () => base.acquire(key));
      return {
        ...(session.ownershipLost ? { ownershipLost: session.ownershipLost } : {}),
        ...(session.limits ? { limits: session.limits } : {}),
        read: () => timer.time('read', () => session.read()),
        create: (value) => timer.time('checkpoint', () => session.create(value)),
        checkpoint: (command) => timer.time('checkpoint', () => session.checkpoint(command)),
        release: () => timer.time('release', () => session.release()),
      };
    },
  };
}

const collect = (() => {
  try {
    setFlagsFromString('--expose-gc');
    return runInNewContext('gc') as () => void;
  } catch {
    return undefined;
  }
})();
const mib = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
/** Peak heap is sampled after state calls and includes uncollected garbage. */
export function heapSampler() {
  collect?.();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  return {
    sample() {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    },
    result() {
      collect?.();
      return {
        peakHeapMiB: mib(peak - base),
        retainedHeapMiB: collect ? mib(process.memoryUsage().heapUsed - base) : null,
      };
    },
  };
}

// Function names present in both compared versions, grouped by the work they represent.
const categories: Record<string, (name: string, url: string) => boolean> = {
  schemaValidation: (name, url) =>
    url.includes('zod/v4/classic') && ['parse', 'safeParse', '_parse', '_safeParse'].includes(name),
  rowSchemaConstruction: (name) => name === 'createAgenticRowSchema',
  consistencyChecks: (name) => name === 'checkpointIsConsistent',
  outcomeValidation: (name) =>
    ['parseAgentAssignmentOutcome', 'parseAttemptOutcome'].includes(name),
  receiptValidation: (name) => ['validateAgenticReceipt', 'checkReceipt'].includes(name),
  canonicalDigests: (name) => name === 'digestAgenticState',
  boundedJsonScans: (name) => ['isBoundedCheckpoint', 'isBoundedAgenticJson'].includes(name),
  structuredClone: (name) => name === 'structuredClone',
  garbageCollection: (name) => name === '(garbage collector)',
};
interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}
function summarize({ nodes, samples, timeDeltas }: CpuProfile): Record<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const totals: Record<string, number> = { sampled: 0 };
  samples.forEach((sample, index) => {
    const ms = (timeDeltas[index + 1] ?? 0) / 1000;
    totals.sampled! += ms;
    const seen = new Set<string>();
    for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
      const { functionName, url } = byId.get(id)!.callFrame;
      for (const [category, matches] of Object.entries(categories)) {
        if (matches(functionName, url)) seen.add(category);
      }
    }
    for (const category of seen) totals[category] = (totals[category] ?? 0) + ms;
  });
  return Object.fromEntries(Object.entries(totals).map(([key, ms]) => [key, Math.round(ms)]));
}

/** Records a CPU profile of `run` when `directory` is set and attributes inclusive time. */
export async function profiled<T>(
  directory: string | undefined,
  name: string,
  run: () => Promise<T>
): Promise<{ value: T; cpu?: Record<string, number> }> {
  if (!directory) return { value: await run() };
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 500 });
    await session.post('Profiler.start');
    const value = await run();
    const { profile } = await session.post('Profiler.stop');
    writeFileSync(`${directory}/${name}.cpuprofile`, JSON.stringify(profile));
    return { value, cpu: summarize(profile as unknown as CpuProfile) };
  } finally {
    session.disconnect();
  }
}

export const median = (values: number[]): number =>
  Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
