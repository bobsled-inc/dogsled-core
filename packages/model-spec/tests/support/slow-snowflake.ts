/**
 * Snowflake's timing on the emulator, so that a benchmark there has the shape a real account
 * showed: every statement takes about half a second, updates of one table run one at a time, and
 * inserts into one table commit one at a time. The figures are fitted to the one-account sample in
 * docs/checkpoint-transport-benchmark.md ("Row store header tables"). This predicts what a change
 * does on Snowflake. It does not prove it: only a real account does.
 *
 * The emulator already queues `UPDATE` and `DELETE` behind a lock per table, and holds that lock
 * for `lockHoldMs` after the statement. This adds the time around each statement, and a second
 * queue per table for inserts.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  CustomRunnerRegistry,
  type SqlQueryRunner,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import type { SnowflakeEmulator } from './snowflake-emulator.js';

export interface SnowflakeLatency {
  /** Before an `UPDATE` or `DELETE` reaches its table lock, and how long it then holds it. */
  updateMs: number;
  updateLockMs: number;
  /** Before an `INSERT` commits, and how long its commit holds the table from other inserts. */
  insertMs: number;
  insertCommitMs: number;
  readMs: number;
  /** Before an `EXECUTE IMMEDIATE` script runs. Its own `UPDATE` holds the guard lock as above. */
  scriptMs: number;
  /** Table setup and anything else. */
  otherMs: number;
  /**
   * Spread of the time outside the table queues, as the standard deviation of a log-normal factor
   * whose median is 1. Zero gives every statement its median time. Real statements have a tail:
   * their p95 was about twice their median in the sample, so a real run is slower than the
   * medians alone predict. The queues keep their mean time, which is what a busy table sustains.
   */
  tail?: number;
}

/**
 * One run alone: a header update about 550 ms, a row insert about 532 ms, a read about 290 ms, a
 * setup statement about 234 ms and the first-row script about 1,631 ms. Shared: updates of one
 * table about 2.2 a second, and inserts into the rows table about 4.5 a second with 16 runs.
 */
export const snowflakeSampleLatency: SnowflakeLatency = {
  updateMs: 100,
  updateLockMs: 450,
  insertMs: 310,
  insertCommitMs: 222,
  readMs: 290,
  scriptMs: 1_150,
  otherMs: 234,
};

export type StatementKind =
  | 'header_commit'
  | 'header_update'
  | 'row_insert'
  | 'insert'
  | 'update'
  | 'read'
  | 'script'
  | 'other';

/** What a statement is, for both the latency model and the counts a benchmark reports. A header
 * commit is the fenced update that sets a revision; other header updates claim, renew or release. */
export function statementKind(sql: string): StatementKind {
  if (/^\s*UPDATE\b[^;]*__DOGSLED_AGENTIC_RUNS/i.test(sql)) {
    return /SET\s+"REVISION"\s*=/i.test(sql) ? 'header_commit' : 'header_update';
  }
  if (/^\s*INSERT\b[^;]*__DOGSLED_AGENTIC_ROWS/i.test(sql)) return 'row_insert';
  if (/^\s*INSERT\b/i.test(sql)) return 'insert';
  if (/^\s*(UPDATE|DELETE)\b/i.test(sql)) return 'update';
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return 'read';
  if (/^\s*EXECUTE\s+IMMEDIATE\b/i.test(sql)) return 'script';
  return 'other';
}

const insertTable = (sql: string): string =>
  /^\s*INSERT\s+INTO\s+((?:"[^"]+"\.?)+)/i.exec(sql)?.[1] ?? 'unknown';

export interface SlowSnowflake {
  /** Registers runners that reach the emulator through the latency model. */
  customRunners: CustomRunnerRegistry;
  /** Statements sent, by kind, and how long each took as its caller saw it. */
  samples: Partial<Record<StatementKind, number[]>>;
  reset(): void;
}

export function slowSnowflake(
  emulator: SnowflakeEmulator,
  latency: SnowflakeLatency = snowflakeSampleLatency
): SlowSnowflake {
  const base = emulator.customRunners.get('snowflake', 'pat');
  if (!base) throw new Error('The emulator registers no Snowflake runner');
  emulator.lockHoldMs = latency.updateLockMs;
  // One commit at a time per table, shared by every runner, as the account's tables are.
  const commits = new Map<string, Promise<unknown>>();
  const commitInsert = <T>(sql: string, statement: () => Promise<T>): Promise<T> => {
    const table = insertTable(sql);
    const turn = (commits.get(table) ?? Promise.resolve()).then(async () => {
      try {
        return await statement();
      } finally {
        await delay(latency.insertCommitMs);
      }
    });
    commits.set(
      table,
      turn.catch(() => {})
    );
    return turn;
  };
  const slow: SlowSnowflake = {
    customRunners: new CustomRunnerRegistry(),
    samples: {},
    reset: () => {
      slow.samples = {};
    },
  };
  // Box-Muller: a standard normal draw from two uniform ones.
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const outside = (ms: number) => delay(latency.tail ? ms * Math.exp(latency.tail * normal()) : ms);
  const timed = async <T>(sql: string, statement: () => Promise<T>): Promise<T> => {
    const kind = statementKind(sql);
    const started = performance.now();
    try {
      switch (kind) {
        case 'header_commit':
        case 'header_update':
        case 'update':
          await outside(latency.updateMs);
          return await statement();
        case 'row_insert':
        case 'insert':
          await outside(latency.insertMs);
          return await commitInsert(sql, statement);
        case 'read':
          await outside(latency.readMs);
          return await statement();
        case 'script':
          await outside(latency.scriptMs);
          return await statement();
        default:
          await outside(latency.otherMs);
          return await statement();
      }
    } finally {
      (slow.samples[kind] ??= []).push(performance.now() - started);
    }
  };
  slow.customRunners.register('snowflake', 'pat', async (integration, context) => {
    const runner: SqlRunnerModule = await base(integration, context);
    const query = runner.query!;
    // The caller's arguments as they came, so the emulator sees the call shape the store sends.
    return {
      ...runner,
      run: (...args: Parameters<SqlRunnerModule['run']>) =>
        timed(args[0], () => runner.run(...args)),
      query: (...args: Parameters<SqlQueryRunner>) => timed(args[0], () => query(...args)),
    } as SqlRunnerModule;
  });
  return slow;
}
