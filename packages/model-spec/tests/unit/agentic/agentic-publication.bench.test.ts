import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import type { AgenticPublisher } from '../../../src/agentic/publication.js';
import type { AgentExecutorRequest } from '../../../src/agentic/index.js';
import { runFixture } from './state-fixture.js';
import { checkpointIntegrations } from '../../support/checkpoint-transport.js';
import { agenticWarehouse } from '../../support/agentic-warehouse.js';
import { median, phaseTimer, type PhaseTimer } from '../../support/agentic-benchmark.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));

const env = process.env;
const latencyMs = Number(env.PUBLICATION_BENCHMARK_LATENCY_MS ?? 0);
const samples = Number(env.PUBLICATION_BENCHMARK_SAMPLES ?? 3);
// PostgreSQL checks unchanged targets in place; Snowflake stages them. Both are supported.
const dialect = (env.PUBLICATION_BENCHMARK_DIALECT ?? 'postgres') as 'postgres' | 'snowflake';
if (!['postgres', 'snowflake'].includes(dialect)) throw new Error('Unsupported benchmark dialect');
const integration = checkpointIntegrations[dialect === 'postgres' ? 0 : 1]!;
const populated = 100;
type Row = { pair_id: string; updated_at: number; evidence: string };
const rows = (count: number, changed: number[] = []): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    pair_id: `p${index}`,
    updated_at: changed.includes(index) ? populated + 1 + changed.indexOf(index) : index + 1,
    evidence: `Synthetic evidence ${index}. `.repeat(8),
  }));

/** An incremental single-step model whose answers carry evidence metadata. */
function workload() {
  const f = runFixture(0);
  f.model.limits = {};
  f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
  f.host.inputs = {
    undecided_pairs: [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'updated_at', type: 'integer', nullable: false },
      { name: 'evidence', type: 'string', nullable: false },
    ],
  };
  let input: Row[] = [];
  const unanswered = new Set<string>();
  f.host.prepare = async () => input;
  f.host.executeAgent = async ({ assignment, budget }: AgentExecutorRequest) => {
    const reservation = await budget.reserve(100);
    const usage = {
      status: 'measured' as const,
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
    };
    await budget.settle(reservation, usage);
    return {
      contract_version: 2 as const,
      attempt_id: assignment.attempt_id,
      status: 'succeeded' as const,
      usage,
      rows: assignment.processed_keys
        .filter(({ pair_id }) => !unanswered.has(String(pair_id)))
        .map(({ pair_id }) => ({
          pair_id: String(pair_id),
          assessment: `Synthetic assessment ${String(pair_id)}.`,
          _dogsled_evidence: [
            {
              source: assignment.input.ref,
              reference: `${assignment.input.ref}/${String(pair_id)}`,
              support_excerpt: 'Synthetic supporting excerpt.',
              retrieved_at: assignment.input.retrieved_at!,
            },
          ],
          _dogsled_confidence: 0.75,
          _dogsled_reason: {
            summary: 'Synthetic summary.',
            supporting_factors: ['Synthetic factor'],
            conflicting_factors: [],
          },
        })),
    };
  };
  const context = f.context();
  const warehouse = agenticWarehouse(context, dialect);
  warehouse.publication.absent();
  resolve.mockImplementation(async () => warehouse.acquire());
  const run = async (id: string, mode: 'start' | 'resume' = 'start', timer?: PhaseTimer) => {
    const publisher = await createSqlAgenticPublisher(integration);
    try {
      return await executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: createWarehouseCheckpointStore(integration, { schema: 'agentic_state' }),
        publisher: timer ? timedPublisher(publisher, timer) : publisher,
        run: { id, mode },
      });
    } finally {
      await publisher.close();
    }
  };
  return {
    warehouse,
    run,
    input(value: Row[]) {
      input = value;
    },
    unanswered,
  };
}

function timedPublisher(publisher: AgenticPublisher, timer: PhaseTimer): AgenticPublisher {
  return {
    preflight: (...args) => timer.time('preflight', () => publisher.preflight(...args)),
    claim: (...args) => timer.time('claim', () => publisher.claim(...args)),
    prepare: (...args) => timer.time('prepare', () => publisher.prepare(...args)),
    inspect: (...args) => timer.time('inspect', () => publisher.inspect(...args)),
    commit: (...args) => timer.time('commit', () => publisher.commit(...args)),
    close: () => publisher.close(),
  };
}

type Workload = ReturnType<typeof workload>;
const populate = async (w: Workload) => {
  w.input(rows(populated));
  expect((await w.run('populate')).processedKeys).toHaveLength(populated);
};
/** Each scenario prepares state without latency, then measures one run. */
const scenarios: Record<
  string,
  {
    setup(w: Workload): Promise<void>;
    run(w: Workload, timer: PhaseTimer): Promise<unknown>;
    target: number;
  }
> = {
  'missing target, empty input': {
    setup: async () => {},
    run: (w, timer) => w.run('measured', 'start', timer),
    target: -1,
  },
  'populated target, no new rows': {
    setup: populate,
    run: (w, timer) => w.run('measured', 'start', timer),
    target: populated,
  },
  'second equivalent empty run': {
    setup: async (w) => {
      await populate(w);
      await w.run('first-empty');
    },
    run: (w, timer) => w.run('measured', 'start', timer),
    target: populated,
  },
  'five changed rows': {
    setup: async (w) => {
      await populate(w);
      w.input(rows(populated, [3, 17, 42, 64, 99]));
    },
    run: (w, timer) => w.run('measured', 'start', timer),
    target: populated,
  },
  'processed key without rows': {
    setup: async (w) => {
      await populate(w);
      w.input(rows(populated, [3, 17, 42, 64, 99]));
      w.unanswered.add('p42');
    },
    run: (w, timer) => w.run('measured', 'start', timer),
    target: populated - 1,
  },
  'one new row advances the cursor': {
    setup: async (w) => {
      await populate(w);
      w.input([...rows(populated), { ...rows(1)[0]!, pair_id: 'p100', updated_at: 101 }]);
    },
    run: (w, timer) => w.run('measured', 'start', timer),
    target: populated + 1,
  },
  'resume after an uncertain commit': {
    setup: async (w) => {
      await populate(w);
      w.input(rows(populated, [3, 17, 42, 64, 99]));
      // The commit applies but its response is lost, and the reconciling inspection fails.
      w.warehouse.loseResponse(/INSERT INTO \S+_RECEIPTS/i);
      w.warehouse.fail(/SELECT receipt FROM/i, 1);
      await expect(w.run('measured')).rejects.toThrow('Synthetic warehouse request failure');
      expect(w.warehouse.publication.receipts()).toHaveLength(2);
    },
    run: (w, timer) => w.run('measured', 'resume', timer),
    target: populated,
  },
};

// Opt-in measurement, not a wall-clock regression gate. The executor, checkpoint store,
// cursor store and SQL publisher are real; the warehouse is an in-memory protocol double.
describe.skipIf(env.PUBLICATION_BENCHMARK !== '1')('agentic publication benchmark', () => {
  it.each(Object.keys(scenarios))(
    '%s',
    async (name) => {
      const scenario = scenarios[name]!;
      const runs = [];
      for (let sample = 0; sample < samples; sample++) {
        const w = workload();
        await scenario.setup(w);
        const timer = phaseTimer();
        w.warehouse.measure(latencyMs);
        const start = performance.now();
        const result = (await scenario.run(w, timer)) as { publication: string };
        const elapsedMs = performance.now() - start;
        expect(result.publication).toBe('confirmed');
        const target = w.warehouse.publication.exists()
          ? w.warehouse.publication.target().length
          : -1;
        expect(target).toBe(scenario.target);
        runs.push({
          elapsedMs,
          phases: timer.phases,
          operations: { ...w.warehouse.operations },
          runners: w.warehouse.runners,
          receipts: w.warehouse.publication.receipts().length,
          cursors: [...w.warehouse.cursors.rows.values()]
            .filter((row) => row.record)
            .map((row) => JSON.parse(row.record).values),
        });
      }
      const last = runs.at(-1)!;
      const byArea = (area: string) =>
        Object.entries(last.operations)
          .filter(([key]) => key.startsWith(`${area}:`))
          .reduce((sum, [, count]) => sum + count, 0);
      process.stdout.write(
        `${JSON.stringify({
          scenario: name,
          dialect,
          latencyMs,
          samples,
          elapsedMs: median(runs.map((run) => run.elapsedMs)),
          elapsedSamplesMs: runs.map((run) => Math.round(run.elapsedMs)),
          publisherMs: Object.fromEntries(
            Object.keys(last.phases).map((phase) => [
              phase,
              median(runs.map((run) => run.phases[phase] ?? 0)),
            ])
          ),
          requests: {
            total: Object.values(last.operations).reduce((a, b) => a + b, 0),
            publication: byArea('publication'),
            checkpoint: byArea('checkpoint'),
            cursor: byArea('cursor'),
          },
          operations: last.operations,
          runners: last.runners,
          receipts: last.receipts,
          cursors: last.cursors,
        })}\n`
      );
    },
    600_000
  );
});
