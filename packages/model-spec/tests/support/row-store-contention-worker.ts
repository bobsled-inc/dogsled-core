/**
 * One real run on a shared store, in a process of its own so that runs contend at the database
 * rather than for one event loop. Every statement is timed at the runner boundary.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CustomRunnerRegistry,
  resolveRunner,
  type IntegrationFile,
  type SqlQueryRunner,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { executeAgenticRun } from '../../src/agentic/run.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { createWarehouseCheckpointStore } from '../../src/agentic/warehouse-state.js';
import { benchmarkWorkload } from './agentic-benchmark.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from './row-store-integrations.js';

export interface ContentionWorkerOptions {
  engine: 'postgres' | 'snowflake';
  /** The row store, or the store it replaces, for a before and after on one account. */
  store: 'rows' | 'warehouse';
  schema: string;
  run: string;
  assignments: number;
  /** Epoch milliseconds at which every worker starts. */
  startAt: number;
  output: string;
  modelMs: number;
}
export interface ContentionWorkerResult {
  /** Milliseconds per statement, by kind. */
  samples: Record<string, number[]>;
  startedAt: number;
  finishedAt: number;
  failure?: string;
}

const options = JSON.parse(process.argv[2]!) as ContentionWorkerOptions;
const samples: Record<string, number[]> = {};
const kindOf = (sql: string): string => {
  if (/^\s*UPDATE\b[^;]*__dogsled_agentic_runs/i.test(sql)) return 'header_update';
  if (/^\s*INSERT\b[^;]*__dogsled_agentic_rows/i.test(sql)) return 'row_insert';
  return /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? 'other';
};

function timed(runner: SqlRunnerModule): SqlRunnerModule {
  const measure = async <T>(sql: string, statement: () => Promise<T>): Promise<T> => {
    const kind = kindOf(sql);
    const started = performance.now();
    try {
      return await statement();
    } finally {
      (samples[kind] ??= []).push(performance.now() - started);
    }
  };
  return {
    ...runner,
    run: (...args: Parameters<SqlRunnerModule['run']>) =>
      measure(args[0], () => runner.run(...args)),
    query: (...args: Parameters<SqlQueryRunner>) => measure(args[0], () => runner.query!(...args)),
  };
}

async function main(): Promise<void> {
  const integration: IntegrationFile =
    options.engine === 'postgres' ? postgresIntegration() : (await snowflakeIntegration())!;
  const host = await hostRunners();
  const customRunners = new CustomRunnerRegistry();
  customRunners.register(integration.source_type, integration.auth.type, async (base, context) =>
    timed(await resolveRunner(base, { ...context, ...host }))
  );
  const workload = benchmarkWorkload(options.assignments, 'map');
  const execute = workload.host.executeAgent!;
  if (options.modelMs) {
    workload.host.executeAgent = async (request) => {
      await delay(options.modelMs);
      return execute(request);
    };
  }
  const directory = mkdtempSync(join(tmpdir(), 'row-contention-'));
  await delay(Math.max(0, options.startAt - Date.now()));
  const startedAt = Date.now();
  let failure: string | undefined;
  try {
    await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: directory,
      stateStore: (options.store === 'rows'
        ? createWarehouseRowStore
        : createWarehouseCheckpointStore)(integration, { schema: options.schema, customRunners }),
      run: { id: options.run, mode: 'start' },
    });
  } catch (error) {
    const { code, reason } = error as { code?: string; reason?: string };
    failure = [code ?? 'failed', reason].filter(Boolean).join(' ');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const result: ContentionWorkerResult = {
    samples,
    startedAt,
    finishedAt: Date.now(),
    ...(failure ? { failure } : {}),
  };
  writeFileSync(options.output, JSON.stringify(result));
}

await main();
