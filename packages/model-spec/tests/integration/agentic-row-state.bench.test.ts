import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { PostgresIntegration, SqlRunnerModule } from '@bobsled-inc/connections';
import { resolveRunner } from '@bobsled-inc/connections';
import { createDefaultAgenticStateStore } from '../../src/agentic/default-state.js';
import { createDuckDbCheckpointStore } from '../../src/agentic/duckdb-state.js';
import { createLocalAgenticStateStore } from '../../src/agentic/local-state.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import type { AgenticStateStore } from '../../src/agentic/state.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { createWarehouseCheckpointStore } from '../../src/agentic/warehouse-state.js';
import {
  benchmarkWorkload,
  heapSampler,
  median,
  phaseTimer,
  timedStore,
  type BenchmarkShape,
} from '../support/agentic-benchmark.js';

/** Counts every statement at the runner boundary and adds the simulated request latency. */
const probe = vi.hoisted(() => ({
  latencyMs: 0,
  statements: {} as Record<string, number>,
  /** SQL text and string parameters sent, in bytes. */
  sqlBytes: 0,
  opens: 0,
  fileWrites: 0,
  fileBytes: 0,
  wrap<T extends object>(runner: T): T {
    probe.opens++;
    const count = async (sql: string, params?: unknown) => {
      const kind = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'OTHER';
      probe.statements[kind] = (probe.statements[kind] ?? 0) + 1;
      probe.sqlBytes += Buffer.byteLength(sql);
      for (const value of Array.isArray(params) ? params : []) {
        if (typeof value === 'string') probe.sqlBytes += Buffer.byteLength(value);
      }
      if (probe.latencyMs) await new Promise((resolve) => setTimeout(resolve, probe.latencyMs));
    };
    const base = runner as unknown as {
      run: (sql: string, ...rest: unknown[]) => Promise<unknown>;
      query?: (sql: string, ...rest: unknown[]) => Promise<unknown>;
    };
    return {
      ...runner,
      run: async (sql: string, ...rest: unknown[]) => {
        await count(sql);
        return base.run(sql, ...rest);
      },
      query: async (sql: string, ...rest: unknown[]) => {
        await count(sql, rest[0]);
        return base.query!(sql, ...rest);
      },
    };
  },
}));
vi.mock('@bobsled-inc/connections', async (original) => {
  const actual = await original<typeof import('@bobsled-inc/connections')>();
  return {
    ...actual,
    resolveRunner: async (...args: Parameters<typeof actual.resolveRunner>) =>
      probe.wrap(await actual.resolveRunner(...args)),
    buildDuckDbRunner: async (...args: Parameters<typeof actual.buildDuckDbRunner>) =>
      probe.wrap(await actual.buildDuckDbRunner(...args)),
  };
});
vi.mock('../../src/compiler/durable-file.js', async (original) => {
  const actual = await original<typeof import('../../src/compiler/durable-file.js')>();
  return {
    ...actual,
    writeDurableFile: (file: string, value: string) => {
      probe.fileWrites++;
      probe.fileBytes += Buffer.byteLength(value);
      actual.writeDurableFile(file, value);
    },
  };
});

const env = process.env;
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(',');
const stores = list(
  env.CHECKPOINT_BENCHMARK_STORES,
  'file,duckdb-run-file,duckdb-shared,postgres-warehouse,postgres-rows'
);
const sizes = list(env.CHECKPOINT_BENCHMARK_SIZES, '5,100,300').map(Number);
const shapes = list(env.CHECKPOINT_BENCHMARK_SHAPES, 'map,plan') as BenchmarkShape[];
const samples = Number(env.CHECKPOINT_BENCHMARK_SAMPLES ?? 3);
const latencyMs = Number(env.CHECKPOINT_BENCHMARK_LATENCY_MS ?? 0);

const postgres = (): PostgresIntegration => ({
  spec_version: '1',
  type: 'integration',
  name: 'lake',
  source_type: 'postgres',
  connection: {
    host: env.DOGSLED_MODEL_SPEC_POSTGRES_HOST!,
    port: Number(env.DOGSLED_MODEL_SPEC_POSTGRES_PORT ?? 5432),
    database: env.DOGSLED_MODEL_SPEC_POSTGRES_DATABASE!,
  },
  auth: {
    type: 'password',
    user: env.DOGSLED_MODEL_SPEC_POSTGRES_USER!,
    password: env.DOGSLED_MODEL_SPEC_POSTGRES_PASSWORD!,
  },
});

function openStore(kind: string, directory: string, schema: string): AgenticStateStore {
  switch (kind) {
    case 'file':
      return createLocalAgenticStateStore(directory);
    case 'duckdb-run-file':
      return createDefaultAgenticStateStore(directory);
    case 'duckdb-shared':
      return createDuckDbCheckpointStore(
        {
          spec_version: '1',
          type: 'integration',
          name: 'state',
          source_type: 'duckdb',
          connection: {},
          auth: { type: 'file', path: join(directory, 'state.duckdb'), read_only: false },
        },
        { schema }
      );
    case 'postgres-warehouse':
      return createWarehouseCheckpointStore(postgres(), { schema });
    case 'postgres-rows':
      return createWarehouseRowStore(postgres(), { schema, retentionMs: 86_400_000 });
    default:
      throw new Error(`Unknown store ${kind}`);
  }
}

async function measure(kind: string, shape: BenchmarkShape, assignments: number) {
  const directory = mkdtempSync(join(tmpdir(), 'row-state-bench-'));
  const schema = `bench_${randomUUID().replaceAll('-', '')}`;
  const workload = benchmarkWorkload(assignments, shape);
  const heap = heapSampler();
  const timer = phaseTimer(heap.sample);
  Object.assign(probe, {
    statements: {},
    sqlBytes: 0,
    opens: 0,
    fileWrites: 0,
    fileBytes: 0,
    latencyMs,
  });
  const start = performance.now();
  try {
    const result = await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: directory,
      stateStore: timedStore(openStore(kind, directory, schema), timer),
      run: { id: 'synthetic', mode: 'start' },
    });
    const executorMs = performance.now() - start;
    expect(result.chargedTokens).toBe(assignments * 60);
    return {
      executorMs,
      checkpointMs: timer.phases.checkpoint ?? 0,
      statements: { ...probe.statements },
      sqlBytes: probe.sqlBytes,
      opens: probe.opens,
      fileWrites: probe.fileWrites,
      fileBytes: probe.fileBytes,
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
      ...heap.result(),
    };
  } finally {
    probe.latencyMs = 0;
    rmSync(directory, { recursive: true, force: true });
    if (kind.startsWith('postgres')) {
      const runner = await resolveRunner(postgres());
      await runner.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await (runner as SqlRunnerModule).close?.();
    }
  }
}

// Opt-in measurement, not a wall-clock regression gate. The executor, scheduler, receipts and
// engines are real: DuckDB in process and PostgreSQL on a local socket.
describe.skipIf(env.CHECKPOINT_BENCHMARK !== '1')('row state benchmark', () => {
  for (const kind of stores) {
    for (const shape of shapes) {
      it.each(sizes)(
        `${kind} ${shape}: %s assignments`,
        async (assignments) => {
          const runs = [];
          for (let sample = 0; sample < samples; sample++) {
            runs.push(await measure(kind, shape, assignments));
          }
          const last = runs.at(-1)!;
          const executorMs = median(runs.map((run) => run.executorMs));
          const checkpointMs = median(runs.map((run) => run.checkpointMs));
          const statements = Object.values(last.statements).reduce((a, b) => a + b, 0);
          process.stdout.write(
            `BENCH ${JSON.stringify({
              store: kind,
              shape,
              assignments,
              latencyMs,
              samples,
              executorMs,
              checkpointMs,
              msPerAssignment: Math.round((executorMs / assignments) * 100) / 100,
              checkpointMsPerAssignment: Math.round((checkpointMs / assignments) * 100) / 100,
              statementsPerAssignment: Math.round((statements / assignments) * 100) / 100,
              ...last,
              totalStatements: statements,
            })}\n`
          );
        },
        7_200_000
      );
    }
  }
});
