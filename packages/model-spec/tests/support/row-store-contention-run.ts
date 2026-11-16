/**
 * One benchmark run on a shared store. Every statement is timed at the runner boundary, every
 * model call is timed at the executor, and every start command is timed from when the coordinator
 * sent it, so a run reports how long each call waited for its start to be durable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CustomRunnerRegistry,
  type IntegrationFile,
  type RunnerFactoryContext,
  type SqlQueryRunner,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { executeAgenticRun } from '../../src/agentic/run.js';
import type {
  AgenticCheckpointCommand,
  AgenticStateSession,
  AgenticStateStore,
} from '../../src/agentic/state.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { createWarehouseCheckpointStore } from '../../src/agentic/warehouse-state.js';
import { benchmarkWorkload } from './agentic-benchmark.js';

export interface ContentionRunOptions {
  /** The row store, or the store it replaces, for a before and after on one account. */
  store: 'rows' | 'warehouse';
  schema: string;
  run: string;
  assignments: number;
  modelMs: number;
  /** Model calls in flight. Default 1. */
  concurrency?: number;
  /** Commit the waiting starts and finishes together. Row store only. */
  groupCommit?: boolean;
}
export interface ContentionCall {
  /** Milliseconds on this process's monotonic clock, comparable only within one run. */
  issuedAt: number | null;
  calledAt: number;
  returnedAt: number;
}
export interface ContentionRunResult {
  /** Milliseconds per statement, by kind. */
  samples: Record<string, number[]>;
  /** Header updates that set a revision, which is what commits commands. */
  commits: number;
  calls: ContentionCall[];
  /** Epoch milliseconds, comparable across processes. */
  startedAt: number;
  finishedAt: number;
  failure?: string;
}

const kindOf = (sql: string): string => {
  if (/^\s*UPDATE\b[^;]*__bobsled_agentic_runs/i.test(sql)) return 'header_update';
  if (/^\s*INSERT\b[^;]*__bobsled_agentic_rows/i.test(sql)) return 'row_insert';
  return /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? 'other';
};
const isCommit = (sql: string): boolean =>
  /^\s*UPDATE\b[^;]*__bobsled_agentic_runs[^;]*\bSET\s+"?revision"?\s*=/i.test(sql);

/** A registry that times every statement of runners made by `base`. */
export function timedRunners(
  sourceType: IntegrationFile['source_type'],
  authType: string,
  base: (integration: IntegrationFile, context: RunnerFactoryContext) => Promise<SqlRunnerModule>,
  result: Pick<ContentionRunResult, 'samples' | 'commits'>
): CustomRunnerRegistry {
  const measure = async <T>(sql: string, statement: () => Promise<T>): Promise<T> => {
    const kind = kindOf(sql);
    if (isCommit(sql)) result.commits++;
    const started = performance.now();
    try {
      return await statement();
    } finally {
      (result.samples[kind] ??= []).push(performance.now() - started);
    }
  };
  const registry = new CustomRunnerRegistry();
  registry.register(sourceType, authType, async (integration, context) => {
    const runner = await base(integration, context);
    return {
      ...runner,
      run: (...args: Parameters<SqlRunnerModule['run']>) =>
        measure(args[0], () => runner.run(...args)),
      query: (...args: Parameters<SqlQueryRunner>) =>
        measure(args[0], () => runner.query!(...args)),
    };
  });
  return registry;
}

/** Notes when each start command leaves the coordinator, singly or in a group. */
function recordingStore(store: AgenticStateStore, issued: Map<string, number>): AgenticStateStore {
  const note = (command: AgenticCheckpointCommand) => {
    if (command.type === 'start_attempt') issued.set(command.attempt_id, performance.now());
  };
  return {
    ...store,
    async acquire(key) {
      const session = await store.acquire(key);
      const recorded: AgenticStateSession = {
        ...(session.ownershipLost ? { ownershipLost: session.ownershipLost } : {}),
        read: () => session.read(),
        create: (snapshot) => session.create(snapshot),
        checkpoint: (command) => {
          note(command);
          return session.checkpoint(command);
        },
        release: () => session.release(),
      };
      const many = session.checkpointMany;
      if (many) {
        recorded.checkpointMany = (commands) => {
          commands.forEach(note);
          return many(commands);
        };
      }
      return recorded;
    },
  };
}

export async function runContention(
  options: ContentionRunOptions,
  integration: IntegrationFile,
  base: (integration: IntegrationFile, context: RunnerFactoryContext) => Promise<SqlRunnerModule>
): Promise<ContentionRunResult> {
  const result: ContentionRunResult = {
    samples: {},
    commits: 0,
    calls: [],
    startedAt: 0,
    finishedAt: 0,
  };
  const customRunners = timedRunners(integration.source_type, integration.auth.type, base, result);
  const workload = benchmarkWorkload(options.assignments, 'map');
  workload.host.concurrency = options.concurrency ?? 1;
  const execute = workload.host.executeAgent!;
  const issued = new Map<string, number>();
  workload.host.executeAgent = async (request) => {
    const calledAt = performance.now();
    try {
      if (options.modelMs) await delay(options.modelMs, undefined, { signal: request.signal });
      return await execute(request);
    } finally {
      result.calls.push({
        issuedAt: issued.get(request.assignment.attempt_id) ?? null,
        calledAt,
        returnedAt: performance.now(),
      });
    }
  };
  const store =
    options.store === 'rows'
      ? createWarehouseRowStore(integration, {
          schema: options.schema,
          customRunners,
          ...(options.groupCommit ? { groupCommit: true } : {}),
        })
      : createWarehouseCheckpointStore(integration, { schema: options.schema, customRunners });
  const directory = mkdtempSync(join(tmpdir(), 'row-contention-'));
  result.startedAt = Date.now();
  try {
    await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: directory,
      stateStore: recordingStore(store, issued),
      run: { id: options.run, mode: 'start' },
    });
  } catch (error) {
    const { code, reason } = error as { code?: string; reason?: string };
    result.failure = [code ?? 'failed', reason].filter(Boolean).join(' ');
  } finally {
    result.finishedAt = Date.now();
    rmSync(directory, { recursive: true, force: true });
  }
  return result;
}
