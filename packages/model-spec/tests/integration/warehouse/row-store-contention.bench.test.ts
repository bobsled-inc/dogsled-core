import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { snowflakeRowDialect } from '../../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import { caseName, quoteIdentifier } from '../../../src/compiler/dialect.js';
import { runContention, type ContentionRunResult } from '../../support/row-store-contention-run.js';
import type { ContentionWorkerOptions } from '../../support/row-store-contention-worker.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from '../../support/row-store-integrations.js';
import { slowSnowflake, snowflakeSampleLatency } from '../../support/slow-snowflake.js';
import { createSnowflakeEmulator } from '../../support/snowflake-emulator.js';

const env = process.env;
const enabled = env.CHECKPOINT_BENCHMARK === '1';
const number = (value: string | undefined, fallback: number) => Number(value ?? fallback);
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(',');
const settings = {
  runs: list(env.CHECKPOINT_BENCHMARK_RUNS, '1,4,8,16').map(Number),
  assignments: number(env.CHECKPOINT_BENCHMARK_ASSIGNMENTS, 100),
  samples: number(env.CHECKPOINT_BENCHMARK_SAMPLES, 3),
  modelMs: list(env.CHECKPOINT_BENCHMARK_MODEL_MS, '0').map(Number),
  /** Model calls in flight per run. */
  concurrency: list(env.CHECKPOINT_BENCHMARK_CONCURRENCY, '1').map(Number),
  /** `off`, `on` or both: whether a run commits its waiting starts and finishes together. */
  groupCommit: list(env.CHECKPOINT_BENCHMARK_GROUP_COMMIT, 'off').map((mode) => mode === 'on'),
  /** Header tables on Snowflake, to compare numbers without changing the dialect. */
  headerTables: number(env.CHECKPOINT_BENCHMARK_HEADER_TABLES, 0),
  /** Emulator only: the spread of statement times outside the table queues. See slow-snowflake.ts. */
  latencyTail: number(env.CHECKPOINT_BENCHMARK_LATENCY_TAIL, 0),
  store:
    env.CHECKPOINT_BENCHMARK_STORE === 'warehouse' ? ('warehouse' as const) : ('rows' as const),
};
if (settings.headerTables) {
  Object.assign(snowflakeRowDialect, { headerTables: [settings.headerTables] });
}
const worker = fileURLToPath(
  new URL('../../support/row-store-contention-worker.ts', import.meta.url)
);
const snowflake = enabled ? await snowflakeIntegration() : undefined;
const runners = enabled ? await hostRunners() : {};
type Engine = {
  engine: 'postgres' | 'snowflake' | 'emulator';
  integration: () => IntegrationFile;
};
const engines: Engine[] = [
  ...(enabled && env.BOBSLED_CORE_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres')
    ? [{ engine: 'postgres' as const, integration: postgresIntegration }]
    : []),
  ...(snowflake ? [{ engine: 'snowflake' as const, integration: () => snowflake }] : []),
  // Snowflake's timing on the emulator, fitted to one real sample. A prediction, not a proof.
  ...(enabled && env.CHECKPOINT_BENCHMARK_EMULATOR === '1'
    ? [{ engine: 'emulator' as const, integration: () => ({}) as IntegrationFile }]
    : []),
];

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
const round = (value: number) => Math.round(value * 100) / 100;
function latency(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

/**
 * How long a free slot waits for the call that fills it: the k-th call of a run can start only
 * once k - concurrency calls have returned, so it waited from the (k - concurrency)-th return.
 * This covers everything between two calls, where `startWait` covers only the start's commit.
 */
function slotWaits(result: ContentionRunResult, concurrency: number): number[] {
  const called = result.calls.map((call) => call.calledAt).sort((a, b) => a - b);
  const returned = result.calls.map((call) => call.returnedAt).sort((a, b) => a - b);
  return called.slice(concurrency).map((at, index) => at - returned[index]!);
}

type Scenario = { runs: number; modelMs: number; concurrency: number; groupCommit: boolean };

async function measure(engine: Engine, scenario: Scenario) {
  const emulator = engine.engine === 'emulator' ? await createSnowflakeEmulator() : undefined;
  const slow = emulator
    ? slowSnowflake(emulator, {
        ...snowflakeSampleLatency,
        tail: settings.latencyTail,
      })
    : undefined;
  const integration = emulator ? emulator.integration : engine.integration();
  const q = (name: string) =>
    quoteIdentifier(caseName(name, integration.source_type), integration.source_type);
  const database = integration.source_type === 'snowflake' ? integration.connection.database : null;
  const prefix = env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_SCHEMA ?? 'bench';
  const schema = `${prefix}_contention_${randomUUID().replaceAll('-', '')}`;
  // PostgreSQL truncates a longer name, which could cut the random part off what gets dropped.
  if (engine.engine === 'postgres' && Buffer.byteLength(schema) > 63) {
    throw new Error('The schema prefix is too long for PostgreSQL');
  }
  const namespace = [...(database ? [database] : []), schema].map(q).join('.');
  const directory = mkdtempSync(join(tmpdir(), 'row-contention-'));
  const storeRunners = slow ? { customRunners: slow.customRunners } : runners;
  try {
    // Create the tables first, so that the runs measure work rather than setup.
    const first = await createWarehouseRowStore(integration, { schema, ...storeRunners }).acquire({
      scope: 'bench',
      model: 'setup',
      id: 'setup',
    });
    await first.release();
    const options = (index: number) => ({
      store: settings.store,
      schema,
      run: `run-${index}`,
      assignments: settings.assignments,
      modelMs: scenario.modelMs,
      concurrency: scenario.concurrency,
      ...(scenario.groupCommit ? { groupCommit: true } : {}),
    });
    let results: ContentionRunResult[];
    if (slow) {
      // One emulator, so one process. Statements wait on timers, not on this event loop.
      const base = slow.customRunners.get('snowflake', 'pat')!;
      results = await Promise.all(
        Array.from({ length: scenario.runs }, (_, index) =>
          runContention(options(index), integration, base)
        )
      );
    } else {
      const startAt = Date.now() + 8_000;
      const outputs = Array.from({ length: scenario.runs }, (_, index) =>
        join(directory, `${index}.json`)
      );
      await Promise.all(
        outputs.map(async (output, index) => {
          const workerOptions: ContentionWorkerOptions = {
            ...options(index),
            engine: engine.engine as 'postgres' | 'snowflake',
            ...(settings.headerTables ? { headerTables: settings.headerTables } : {}),
            startAt,
            output,
          };
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', worker, JSON.stringify(workerOptions)],
            { stdio: ['ignore', 'ignore', 'inherit'] }
          );
          const [code] = await once(child, 'exit');
          expect(code).toBe(0);
        })
      );
      results = outputs.map(
        (output) => JSON.parse(readFileSync(output, 'utf8')) as ContentionRunResult
      );
    }
    const kinds = new Set(results.flatMap((result) => Object.keys(result.samples)));
    const statements = Object.fromEntries(
      [...kinds]
        .sort()
        .map((kind) => [kind, latency(results.flatMap((result) => result.samples[kind] ?? []))])
    );
    const elapsedMs =
      Math.max(...results.map((result) => result.finishedAt)) -
      Math.min(...results.map((result) => result.startedAt));
    const assignments = scenario.runs * settings.assignments;
    const total = Object.values(statements).reduce((sum, kind) => sum + kind.count, 0);
    const header = statements.header_update;
    const commits = results.reduce((sum, result) => sum + result.commits, 0);
    return {
      elapsedMs: Math.round(elapsedMs),
      statementsPerAssignment: round(total / assignments),
      rowInsertsPerAssignment: round((statements.row_insert?.count ?? 0) / assignments),
      headerUpdatesPerAssignment: round((header?.count ?? 0) / assignments),
      headerUpdatesPerSecond: round(((header?.count ?? 0) * 1000) / elapsedMs),
      rowInsertsPerSecond: round(((statements.row_insert?.count ?? 0) * 1000) / elapsedMs),
      assignmentsPerMinute: round((assignments * 60_000) / elapsedMs),
      perRunPerMinute: round((assignments * 60_000) / elapsedMs / scenario.runs),
      // Every model call is a start and a finish. Fixed commands per run come on top.
      callsPerCommit: round(assignments / commits),
      startWait: latency(
        results.flatMap((result) =>
          result.calls.flatMap((call) =>
            call.issuedAt === null ? [] : [call.calledAt - call.issuedAt]
          )
        )
      ),
      slotWait: latency(results.flatMap((result) => slotWaits(result, scenario.concurrency))),
      lockRefusals: emulator?.lockRefusals() ?? null,
      failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
      statements,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (emulator) {
      await emulator.close();
    } else {
      const runner = await resolveRunner(integration, runners);
      try {
        await runner.run(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      } finally {
        await runner.close?.();
      }
    }
  }
}

const scenarios: Scenario[] = settings.runs.flatMap((runs) =>
  settings.concurrency.flatMap((concurrency) =>
    settings.modelMs.flatMap((modelMs) =>
      settings.groupCommit.map((groupCommit) => ({ runs, modelMs, concurrency, groupCommit }))
    )
  )
);
const label = (scenario: Scenario) =>
  `${scenario.runs} runs at once, ${scenario.concurrency} calls in flight each, model ${scenario.modelMs} ms, group commit ${scenario.groupCommit ? 'on' : 'off'}`;

// Opt-in measurement, not a regression gate. Real runs and a synthetic model call. On a real
// engine each run has a process of its own.
describe.skipIf(!engines.length)('row store contention', () => {
  for (const engine of engines) {
    it.each(scenarios.map((scenario) => [label(scenario), scenario] as const))(
      `${engine.engine}: %s`,
      async (_, scenario) => {
        for (let sample = 0; sample < settings.samples; sample++) {
          const line = JSON.stringify({
            ...settings,
            ...scenario,
            engine: engine.engine,
            sample,
            ...(await measure(engine, scenario)),
          });
          process.stdout.write(`BENCH ${line}\n`);
          if (env.CHECKPOINT_BENCHMARK_OUTPUT) {
            appendFileSync(env.CHECKPOINT_BENCHMARK_OUTPUT, `${line}\n`);
          }
        }
      },
      14_400_000
    );
  }
});
