import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../../src/compiler/dialect.js';
import type { BenchmarkShape } from '../support/agentic-benchmark.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from '../support/row-store-integrations.js';
import type {
  RowLimitsPhase,
  RowLimitsPhaseResult,
  RowLimitsStore,
  RowLimitsWorkerOptions,
} from '../support/row-limits-worker.js';

const env = process.env;
const enabled = env.CHECKPOINT_BENCHMARK === '1';
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(',');
const snowflake = enabled ? await snowflakeIntegration() : undefined;
const available: RowLimitsStore[] = [
  'duckdb-run-file',
  'duckdb-shared',
  ...(env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres')
    ? (['postgres-rows'] as const)
    : []),
  ...(snowflake ? (['snowflake-rows'] as const) : []),
];
const stores = list(env.CHECKPOINT_BENCHMARK_STORES, available.join(',')) as RowLimitsStore[];
const sizes = list(env.CHECKPOINT_BENCHMARK_SIZES, '1000,2000,5000,10000').map(Number);
const shapes = list(env.CHECKPOINT_BENCHMARK_SHAPES, 'map') as BenchmarkShape[];
/** The share of assignments the first process finishes before it stops. */
const stopShare = Number(env.CHECKPOINT_BENCHMARK_STOP_SHARE ?? 0.9);
/** Publish each run through a publisher that writes nothing. */
const publish = env.CHECKPOINT_BENCHMARK_PUBLISH === '1';
/** Smaller makes each assignment larger; see `benchmarkWorkload`. */
const payload = Number(env.CHECKPOINT_BENCHMARK_PAYLOAD ?? 1000);
const worker = fileURLToPath(new URL('../support/row-limits-worker.ts', import.meta.url));

async function phase(options: RowLimitsWorkerOptions): Promise<RowLimitsPhaseResult> {
  const flags = [...(env.CHECKPOINT_BENCHMARK_NODE_OPTIONS?.split(' ').filter(Boolean) ?? [])];
  const child = spawn(
    process.execPath,
    ['--expose-gc', ...flags, '--import', 'tsx', worker, JSON.stringify(options)],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  return JSON.parse(readFileSync(options.output, 'utf8')) as RowLimitsPhaseResult;
}

async function dropSchema(store: RowLimitsStore, schema: string): Promise<void> {
  const integration: IntegrationFile | undefined = store.startsWith('postgres')
    ? postgresIntegration()
    : store === 'snowflake-rows'
      ? snowflake
      : undefined;
  if (!integration) return;
  const q = (name: string) =>
    quoteIdentifier(caseName(name, integration.source_type), integration.source_type);
  const database = integration.source_type === 'snowflake' ? integration.connection.database : null;
  const namespace = [...(database ? [database] : []), schema].map(q).join('.');
  const runner = await resolveRunner(integration, await hostRunners());
  try {
    await runner.run(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  } finally {
    await runner.close?.();
  }
}

// Opt-in measurement behind the limits table in docs/agentic-state.md. Each phase of a run is a
// process of its own, so its peak memory is its own: the first stops the run part way, the
// second resumes and finishes it, and the third opens the finished run again.
describe.skipIf(!enabled)('row store at large run sizes', () => {
  for (const store of stores) {
    for (const shape of shapes) {
      it.each(sizes)(
        `${store} ${shape}: %s assignments`,
        async (assignments) => {
          const directory = mkdtempSync(join(tmpdir(), 'row-limits-'));
          const prefix = env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA ?? 'bench';
          const schema = `${prefix}_limits_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
          try {
            const phases: Partial<Record<RowLimitsPhase, RowLimitsPhaseResult>> = {};
            for (const name of ['run', 'resume', 'reopen'] as const) {
              phases[name] = await phase({
                store,
                shape,
                assignments,
                phase: name,
                directory,
                schema,
                stopAt: Math.round(assignments * stopShare),
                publish,
                payload,
                output: join(directory, `${name}.json`),
              });
              expect(phases[name]!.failure).toBeUndefined();
            }
            const line = JSON.stringify({ store, shape, assignments, publish, payload, ...phases });
            process.stdout.write(`BENCH ${line}\n`);
            if (env.CHECKPOINT_BENCHMARK_OUTPUT) {
              appendFileSync(env.CHECKPOINT_BENCHMARK_OUTPUT, `${line}\n`);
            }
          } finally {
            rmSync(directory, { recursive: true, force: true });
            await dropSchema(store, schema);
          }
        },
        7_200_000
      );
    }
  }
});
