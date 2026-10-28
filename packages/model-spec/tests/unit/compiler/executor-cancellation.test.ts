/**
 * Cooperative cancellation at the statement-execution boundary.
 *
 * These assert the two invariants the run-state contract depends on: nothing
 * starts after the abort, and a cancelled statement is never reported as a
 * success (nor as a failure that would mark dependents "upstream failed").
 */

import { SqlCancelledError } from '@bobsled-inc/connections';
import { describe, expect, it, vi } from 'vitest';

import {
  executeSqlStatements,
  type SqlExecOptions,
  type SqlStatement,
} from '../../../src/compiler/index.js';

const statements: SqlStatement[] = [
  { modelName: 'first', sql: 'CREATE VIEW first AS SELECT 1' },
  { modelName: 'second', sql: 'CREATE VIEW second AS SELECT 2' },
  { modelName: 'third', sql: 'CREATE VIEW third AS SELECT 3' },
];

describe('executeSqlStatements cancellation', () => {
  it('runs nothing when the signal is already aborted', async () => {
    const runner = vi.fn(async () => ({ rowCount: 0 }));
    const controller = new AbortController();
    controller.abort();

    const results = await executeSqlStatements(statements, runner, {
      signal: controller.signal,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('stops before the next statement when the abort lands between statements', async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => ({ rowCount: 0 }));

    const results = await executeSqlStatements(statements, runner, {
      signal: controller.signal,
      // Success is emitted only after the awaited runner completed and the
      // post-await abort guard passed, so aborting here is genuinely BETWEEN
      // statements rather than inside a legacy runner before it returns.
      onSuccess: (message) => {
        if (message.includes('first')) controller.abort();
      },
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('CREATE VIEW first AS SELECT 1', {
      signal: controller.signal,
    });
    expect(results.map((r) => [r.modelName, r.status])).toEqual([
      ['first', 'success'],
      ['second', 'cancelled'],
      ['third', 'cancelled'],
    ]);
  });

  it('does not report a legacy runner success that resolves after abort', async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => {
      controller.abort();
      return { rowCount: 1 };
    });

    const results = await executeSqlStatements(statements, runner, {
      signal: controller.signal,
    });

    expect(results.map((result) => result.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('forwards the SAME signal instance to the runner so the driver can observe it', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const runner = vi.fn(async (_sql: string, options?: SqlExecOptions) => {
      seen.push(options?.signal);
      return { rowCount: 0 };
    });

    await executeSqlStatements([statements[0]!], runner, { signal: controller.signal });

    expect(seen).toEqual([controller.signal]);
  });

  it('reports a runner-raised cancellation as cancelled, not failed', async () => {
    const controller = new AbortController();
    const runner = vi.fn(async (sql: string) => {
      if (sql.includes('first')) {
        controller.abort();
        throw new SqlCancelledError('cancelled in flight');
      }
      return { rowCount: 0 };
    });

    const results = await executeSqlStatements(statements, runner, {
      signal: controller.signal,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    // A cancelled statement carries no warehouse diagnostic.
    expect(results.every((r) => !/failed|error/i.test(r.error ?? ''))).toBe(true);
  });

  it('leaves normal execution untouched — no signal, no extra argument, no cancelled status', async () => {
    const runner = vi.fn(async () => ({ rowCount: 7 }));

    const results = await executeSqlStatements(statements, runner);

    expect(runner).toHaveBeenCalledTimes(3);
    // Called with exactly one argument, as before this contract existed.
    for (const call of runner.mock.calls) expect(call).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(['success', 'success', 'success']);
    expect(results.every((r) => r.rowsAffected === 7)).toBe(true);
  });

  it('still marks dependents skipped (not cancelled) on an ordinary failure', async () => {
    const runner = vi.fn(async (sql: string) => {
      if (sql.includes('first')) throw new Error('boom');
      return { rowCount: 0 };
    });

    const results = await executeSqlStatements(
      [statements[0]!, { modelName: 'second', sql: 'x', deps: ['first'] }],
      runner
    );

    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped']);
  });
});
