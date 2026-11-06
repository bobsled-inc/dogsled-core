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
import type {
  ContentionWorkerOptions,
  ContentionWorkerResult,
} from '../../support/row-store-contention-worker.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from '../../support/row-store-integrations.js';

const env = process.env;
const enabled = env.CHECKPOINT_BENCHMARK === '1';
const number = (value: string | undefined, fallback: number) => Number(value ?? fallback);
const settings = {
  runs: (env.CHECKPOINT_BENCHMARK_RUNS ?? '1,4,8,16').split(',').map(Number),
  assignments: number(env.CHECKPOINT_BENCHMARK_ASSIGNMENTS, 100),
  samples: number(env.CHECKPOINT_BENCHMARK_SAMPLES, 3),
  modelMs: number(env.CHECKPOINT_BENCHMARK_MODEL_MS, 0),
  /** Header tables on Snowflake, to compare numbers without changing the dialect. */
  headerTables: number(env.CHECKPOINT_BENCHMARK_HEADER_TABLES, 0),
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
const engines: { engine: 'postgres' | 'snowflake'; integration: () => IntegrationFile }[] = [
  ...(enabled && env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres')
    ? [{ engine: 'postgres' as const, integration: postgresIntegration }]
    : []),
  ...(snowflake ? [{ engine: 'snowflake' as const, integration: () => snowflake }] : []),
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

async function measure(engine: (typeof engines)[number], runs: number) {
  const integration = engine.integration();
  const q = (name: string) =>
    quoteIdentifier(caseName(name, integration.source_type), integration.source_type);
  const database = integration.source_type === 'snowflake' ? integration.connection.database : null;
  const prefix = env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA ?? 'bench';
  const schema = `${prefix}_contention_${randomUUID().replaceAll('-', '')}`;
  // PostgreSQL truncates a longer name, which could cut the random part off what gets dropped.
  if (engine.engine === 'postgres' && Buffer.byteLength(schema) > 63) {
    throw new Error('The schema prefix is too long for PostgreSQL');
  }
  const namespace = [...(database ? [database] : []), schema].map(q).join('.');
  const directory = mkdtempSync(join(tmpdir(), 'row-contention-'));
  try {
    // Create the tables first, so that the runs measure work rather than setup.
    const first = await createWarehouseRowStore(integration, { schema, ...runners }).acquire({
      scope: 'bench',
      model: 'setup',
      id: 'setup',
    });
    await first.release();
    const startAt = Date.now() + 8_000;
    const outputs = Array.from({ length: runs }, (_, index) => join(directory, `${index}.json`));
    await Promise.all(
      outputs.map(async (output, index) => {
        const options: ContentionWorkerOptions = {
          engine: engine.engine,
          store: settings.store,
          schema,
          ...(settings.headerTables ? { headerTables: settings.headerTables } : {}),
          run: `run-${index}`,
          assignments: settings.assignments,
          startAt,
          output,
          modelMs: settings.modelMs,
        };
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', worker, JSON.stringify(options)],
          { stdio: ['ignore', 'ignore', 'inherit'] }
        );
        const [code] = await once(child, 'exit');
        expect(code).toBe(0);
      })
    );
    const results = outputs.map(
      (output) => JSON.parse(readFileSync(output, 'utf8')) as ContentionWorkerResult
    );
    const kinds = new Set(results.flatMap((result) => Object.keys(result.samples)));
    const statements = Object.fromEntries(
      [...kinds]
        .sort()
        .map((kind) => [kind, latency(results.flatMap((result) => result.samples[kind] ?? []))])
    );
    const elapsedMs =
      Math.max(...results.map((result) => result.finishedAt)) -
      Math.min(...results.map((result) => result.startedAt));
    const assignments = runs * settings.assignments;
    const total = Object.values(statements).reduce((sum, kind) => sum + kind.count, 0);
    const header = statements.header_update;
    return {
      elapsedMs,
      statementsPerAssignment: round(total / assignments),
      headerUpdatesPerSecond: round(((header?.count ?? 0) * 1000) / elapsedMs),
      assignmentsPerMinute: round((assignments * 60_000) / elapsedMs),
      failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
      statements,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    const runner = await resolveRunner(integration, runners);
    try {
      await runner.run(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    } finally {
      await runner.close?.();
    }
  }
}

// Opt-in measurement, not a regression gate. Real runs, a synthetic model call, and one process
// per run.
describe.skipIf(!engines.length)('row store contention', () => {
  for (const engine of engines) {
    it.each(settings.runs)(
      `${engine.engine}: %s runs at once`,
      async (runs) => {
        for (let sample = 0; sample < settings.samples; sample++) {
          const line = JSON.stringify({
            ...settings,
            engine: engine.engine,
            runs,
            sample,
            ...(await measure(engine, runs)),
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
