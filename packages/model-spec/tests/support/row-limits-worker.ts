/**
 * One phase of a large run on a row store, in a process of its own so that its peak memory is the
 * phase's own. `run` starts a run and stops it once most of its assignments are done, `resume`
 * finishes it in a new process, as after a crash, and `reopen` opens the finished run again.
 * The model call is synthetic and returns at once, so every figure is store and coordinator
 * overhead.
 */
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  CustomRunnerRegistry,
  resolveRunner,
  type IntegrationFile,
  type SqlQueryRunner,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { createDefaultAgenticStateStore } from '../../src/agentic/default-state.js';
import { createDuckDbCheckpointStore } from '../../src/agentic/duckdb-state.js';
import { createLocalAgenticStateStore } from '../../src/agentic/local-state.js';
import type { AgenticPublisher } from '../../src/agentic/publication.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import type {
  AgenticCheckpointCommand,
  AgenticRunSnapshot,
  AgenticStateStore,
} from '../../src/agentic/state.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { createWarehouseCheckpointStore } from '../../src/agentic/warehouse-state.js';
import { benchmarkWorkload, type BenchmarkShape } from './agentic-benchmark.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from './row-store-integrations.js';

export type RowLimitsStore =
  | 'duckdb-run-file'
  | 'duckdb-shared'
  | 'postgres-rows'
  | 'snowflake-rows'
  /** The stores the row store replaces, which keep the default limits. */
  | 'file'
  | 'postgres-warehouse';
export type RowLimitsPhase = 'run' | 'resume' | 'reopen';
export interface RowLimitsWorkerOptions {
  store: RowLimitsStore;
  shape: BenchmarkShape;
  assignments: number;
  phase: RowLimitsPhase;
  /** The project directory, shared by the phases of one run. */
  directory: string;
  /** The schema of a shared-table store, shared by the phases of one run. */
  schema: string;
  /** Model calls that `run` makes before its executor stops the run. */
  stopAt: number;
  /** Publish through a publisher that writes nothing, to time what publication costs the run. */
  publish?: boolean;
  /** `benchmarkWorkload`'s payload size: smaller makes each assignment larger. Default 1000. */
  payload?: number;
  output: string;
}
export interface RowLimitsPhaseResult {
  phase: RowLimitsPhase;
  totalMs: number;
  /** From the start of the phase to its first model call. */
  firstCallMs: number | null;
  /** From the end of the last model call to the end of the phase. */
  afterLastCallMs: number | null;
  calls: number;
  /** Session time by method, and for checkpoints by command type: count and total ms. */
  sessions: Record<string, { count: number; ms: number }>;
  /** Start and finish of one attempt, in the session, over the last quarter of the phase. */
  lateCheckpointMs: { p50: number; p95: number } | null;
  /** Time between model calls over the last quarter of the phase, which includes the
   * coordinator's own work. */
  lateGapMs: { p50: number; p95: number } | null;
  /** Statements sent, on warehouses only: DuckDB has no runner hook. */
  statements: number | null;
  /** The longest the event loop was blocked, which a lease heartbeat has to outlast. */
  maxBlockMs: number;
  peakHeapMiB: number;
  /** Heap still held once the phase is over and only its last snapshot is kept, after a
   * collection: what one open run of this size holds. Null without --expose-gc. */
  retainedHeapMiB: number | null;
  peakRssMiB: number;
  maxRssMiB: number;
  baseRssMiB: number;
  snapshot: { bytes: number; values: number; work: number } | null;
  failure?: string;
}

const mib = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const round = (value: number) => Math.round(value * 100) / 100;
function percentiles(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  return { p50: round(at(0.5)), p95: round(at(0.95)) };
}
function countValues(value: unknown): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    count++;
    if (item !== null && typeof item === 'object') pending.push(...Object.values(item));
  }
  return count;
}

const options = JSON.parse(process.argv[2]!) as RowLimitsWorkerOptions;
let statements = 0;

/** Confirms every publication at once, so only the coordinator and the store take time. */
const publisher: AgenticPublisher = {
  preflight: async () => {},
  claim: async () => ({ version: 0, fence: 'fence' }),
  prepare: async (_context, identity) => ({
    identity,
    expected_version: 0,
    stage: `stage_${identity.operation_id}`,
  }),
  inspect: async () => null,
  commit: async (intent) => ({ intent, committed_version: 1 }),
  close: async () => {},
};

async function openStore(): Promise<AgenticStateStore> {
  const counting = async (integration: IntegrationFile) => {
    const host = await hostRunners();
    const customRunners = new CustomRunnerRegistry();
    customRunners.register(
      integration.source_type,
      integration.auth.type,
      async (base, context) => {
        const runner: SqlRunnerModule = await resolveRunner(base, { ...context, ...host });
        return {
          ...runner,
          run: (...args: Parameters<SqlRunnerModule['run']>) => {
            statements++;
            return runner.run(...args);
          },
          query: (...args: Parameters<SqlQueryRunner>) => {
            statements++;
            return runner.query!(...args);
          },
        };
      }
    );
    return options.store === 'postgres-warehouse'
      ? createWarehouseCheckpointStore(integration, { schema: options.schema, customRunners })
      : createWarehouseRowStore(integration, {
          schema: options.schema,
          retentionMs: 86_400_000,
          customRunners,
        });
  };
  switch (options.store) {
    case 'file':
      return createLocalAgenticStateStore(options.directory);
    case 'duckdb-run-file':
      return createDefaultAgenticStateStore(options.directory);
    case 'duckdb-shared':
      return createDuckDbCheckpointStore(
        {
          spec_version: '1',
          type: 'integration',
          name: 'state',
          source_type: 'duckdb',
          connection: {},
          auth: { type: 'file', path: `${options.directory}/state.duckdb`, read_only: false },
        },
        { schema: options.schema }
      );
    case 'postgres-rows':
    case 'postgres-warehouse':
      return counting(postgresIntegration());
    case 'snowflake-rows':
      return counting((await snowflakeIntegration())!);
  }
}

const collect = (globalThis as { gc?: () => void }).gc;

async function main(): Promise<void> {
  collect?.();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const baseRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  let peakRss = baseRss;
  const sample = () => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  };
  const sampler = setInterval(sample, 20);
  const baseHeap = process.memoryUsage().heapUsed;
  const sessions: Record<string, { count: number; ms: number }> = {};
  const attemptMs: number[] = [];
  let startMs: number | undefined;
  let last: AgenticRunSnapshot | null = null;
  const timed = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await call();
    } finally {
      const ms = performance.now() - started;
      const entry = (sessions[name] ??= { count: 0, ms: 0 });
      entry.count++;
      entry.ms += ms;
      if (name === 'start_attempt') startMs = ms;
      if (name === 'finish_attempt' && startMs !== undefined) attemptMs.push(startMs + ms);
      sample();
    }
  };
  const base = await openStore();
  // Keeps the store's own declaration: a wrapper that dropped it would get the default limits.
  const store: AgenticStateStore = {
    ...base,
    async acquire(key) {
      const session = await timed('acquire', () => base.acquire(key));
      const keep = (value: AgenticRunSnapshot | null) => (last = value ?? last);
      return {
        ...(session.ownershipLost ? { ownershipLost: session.ownershipLost } : {}),
        ...(session.limits ? { limits: session.limits } : {}),
        read: () => timed('read', async () => keep(await session.read())),
        create: (value) => timed('create', async () => keep(await session.create(value))!),
        checkpoint: (command: AgenticCheckpointCommand) =>
          timed(command.type, async () => keep(await session.checkpoint(command))!),
        release: () => timed('release', () => session.release()),
      };
    },
  };
  const workload = benchmarkWorkload(options.assignments, options.shape, options.payload ?? 1000);
  const execute = workload.host.executeAgent!;
  const calls: number[] = [];
  const ends: number[] = [];
  workload.host.executeAgent = async (request) => {
    if (options.phase === 'run' && calls.length >= options.stopAt) {
      throw new Error('The benchmark stops the run here.');
    }
    calls.push(performance.now());
    try {
      return await execute(request);
    } finally {
      ends.push(performance.now());
    }
  };
  const started = performance.now();
  loop.enable();
  let failure: string | undefined;
  try {
    await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: options.directory,
      stateStore: store,
      run: { id: 'large', mode: options.phase === 'run' ? 'start' : 'resume' },
      ...(options.publish ? { publisher } : {}),
    });
  } catch (error) {
    if (options.phase !== 'run') {
      const { code, reason, message } = error as {
        code?: string;
        reason?: string;
        message?: string;
      };
      failure = [code ?? 'failed', reason, message].filter(Boolean).join(' ');
    }
  }
  const finished = performance.now();
  loop.disable();
  clearInterval(sampler);
  sample();
  collect?.();
  const retained = collect ? process.memoryUsage().heapUsed - baseHeap : null;
  const lateFrom = Math.floor(calls.length * 0.75);
  const gaps = calls.slice(lateFrom + 1).map((time, index) => time - calls[lateFrom + index]!);
  const snapshot = last as AgenticRunSnapshot | null;
  const result: RowLimitsPhaseResult = {
    phase: options.phase,
    totalMs: Math.round(finished - started),
    firstCallMs: calls.length ? Math.round(calls[0]! - started) : null,
    afterLastCallMs: ends.length ? Math.round(finished - ends.at(-1)!) : null,
    calls: calls.length,
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([name, { count, ms }]) => [name, { count, ms: Math.round(ms) }])
    ),
    lateCheckpointMs: percentiles(attemptMs.slice(Math.floor(attemptMs.length * 0.75))),
    lateGapMs: percentiles(gaps),
    statements:
      options.store.startsWith('postgres') || options.store.startsWith('snowflake')
        ? statements
        : null,
    maxBlockMs: Math.round(loop.max / 1e6),
    peakHeapMiB: mib(peakHeap - baseHeap),
    retainedHeapMiB: retained === null ? null : mib(retained),
    peakRssMiB: mib(peakRss),
    maxRssMiB: mib(process.resourceUsage().maxRSS * 1024),
    baseRssMiB: mib(baseRss),
    snapshot: snapshot
      ? {
          bytes: Buffer.byteLength(JSON.stringify(snapshot)),
          values: countValues(snapshot),
          work: snapshot.work.length,
        }
      : null,
    ...(failure ? { failure } : {}),
  };
  writeFileSync(options.output, JSON.stringify(result));
}

await main();
