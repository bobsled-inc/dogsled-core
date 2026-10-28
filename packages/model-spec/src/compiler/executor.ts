/**
 * SQL execution with a generic runner interface.
 *
 * Independent of the host application's API — accepts any function that can
 * execute SQL and optionally return a row count.
 */

import { isCancellationError, type SqlExecOptions } from '@bobsled-inc/connections';

import { redactMatchKeySecret } from './expr/functions-cleaning.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SqlStatement {
  modelName: string;
  sql: string;
  /** Model dependencies (model names this statement depends on). */
  deps?: string[];
  /** Error message fragments that should be treated as benign/idempotent for this statement. */
  ignoreErrorPatterns?: string[];
}

export interface ModelExecutionResult {
  modelName: string;
  /**
   * `cancelled` is only reachable when the caller opts into cancellation by
   * passing a signal (see {@link ExecuteOptions.signal}). Existing consumers
   * that never pass one can never observe it, which is why widening this union
   * is additive rather than a breaking change.
   *
   * It is deliberately distinct from `failed`: a cancelled statement carries no
   * warehouse diagnostic, must not be reported as an error, and must not
   * advance run state.
   */
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  error?: string;
  /** Native failure for library callers; omitted from serialized results. */
  readonly cause?: unknown;
  rowsAffected?: number;
  exitCode?: number;
}

/**
 * A function that executes a SQL string and optionally returns row count.
 *
 * `options` is optional on both sides of the contract: existing callers keep
 * calling `runner(sql)`, and an existing `(sql) => Promise<...>` implementation
 * (including a user-supplied `--runner ./r.js` module) still satisfies the type.
 */
export type SqlRunner = (sql: string, options?: SqlExecOptions) => Promise<{ rowCount?: number }>;

export interface ExecuteCallbacks {
  onInfo?: (msg: string) => void;
  onError?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
}

/** A per-model guard failure returned by {@link ExecuteOptions.beforeModel}. */
export interface ModelGuardFailure {
  error: string;
  exitCode?: number;
}

export interface ExecuteOptions extends ExecuteCallbacks {
  /**
   * Cooperative cancellation. Checked before every statement is dispatched and
   * forwarded to the runner so the DRIVER cancels the in-flight operation. Once
   * it aborts, no further statement begins and every not-yet-executed statement
   * is reported `cancelled`.
   */
  signal?: AbortSignal;
  /**
   * Optional per-model guard. It is awaited once, immediately before a model's
   * first statement is dispatched and after its upstream models have run, so it
   * can validate SQL that reads relations created earlier in the same run.
   * Returning a failure fails the model without dispatching any of its
   * statements; dependents are then skipped like any other failure. A
   * cancellation error thrown by the guard stops the run.
   */
  beforeModel?: (modelName: string) => Promise<ModelGuardFailure | undefined>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute SQL statements in order with per-model fail-fast.
 *
 * When a model fails, all downstream dependents are marked as skipped.
 *
 * When `options.signal` aborts, execution stops at the current statement and
 * every statement that had not yet started is reported `cancelled`. Nothing
 * after the abort is dispatched, and no cancelled statement is ever reported as
 * a success — that is what keeps the caller from advancing run state for work
 * the warehouse did not finish.
 */
export async function executeSqlStatements(
  statements: SqlStatement[],
  runner: SqlRunner,
  options?: ExecuteOptions
): Promise<ModelExecutionResult[]> {
  const callbacks = options;
  const signal = options?.signal;
  const failedModels = new Set<string>();
  const guardedModels = new Set<string>();
  const guardFailedModels = new Set<string>();
  const results: ModelExecutionResult[] = [];

  /** Report every statement from `startIndex` onward as cancelled. */
  const cancelRemaining = (startIndex: number, reason: string): void => {
    for (const stmt of statements.slice(startIndex)) {
      results.push({ modelName: stmt.modelName, status: 'cancelled', error: reason });
    }
  };

  for (const [index, stmt] of statements.entries()) {
    // Cancellation is checked BEFORE dispatch so an abort that lands between
    // two statements never starts the next one.
    if (signal?.aborted) {
      callbacks?.onInfo?.(`Cancelled before ${stmt.modelName}; no further statements will run.`);
      cancelRemaining(index, 'Cancelled before execution started.');
      return results;
    }

    // Check if any dependency failed → skip this model
    const failedDep = stmt.deps?.find((dep) => failedModels.has(dep.toLowerCase()));
    if (failedDep) {
      callbacks?.onInfo?.(`Skipping ${stmt.modelName} (upstream "${failedDep}" failed)`);
      results.push({
        modelName: stmt.modelName,
        status: 'skipped',
        error: `Skipped: upstream "${failedDep}" failed`,
      });
      failedModels.add(stmt.modelName.toLowerCase());
      continue;
    }

    const modelKey = stmt.modelName.toLowerCase();
    // A model that failed its guard has already been reported once; none of
    // its remaining statements may be dispatched.
    if (guardFailedModels.has(modelKey)) continue;
    if (options?.beforeModel && !guardedModels.has(modelKey)) {
      guardedModels.add(modelKey);
      let failure: ModelGuardFailure | undefined;
      try {
        failure = await options.beforeModel(stmt.modelName);
      } catch (error: unknown) {
        if (isCancellationError(error, signal)) {
          callbacks?.onInfo?.(
            `Cancelled before ${stmt.modelName}; no further statements will run.`
          );
          cancelRemaining(index, 'Cancelled before execution started.');
          return results;
        }
        failure = {
          error: redactMatchKeySecret(error instanceof Error ? error.message : 'Unknown error'),
        };
      }
      if (signal?.aborted) {
        callbacks?.onInfo?.(`Cancelled before ${stmt.modelName}; no further statements will run.`);
        cancelRemaining(index, 'Cancelled before execution started.');
        return results;
      }
      if (failure) {
        callbacks?.onError?.(`${stmt.modelName}: ${failure.error}`);
        failedModels.add(modelKey);
        guardFailedModels.add(modelKey);
        results.push({
          modelName: stmt.modelName,
          status: 'failed',
          error: failure.error,
          ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
        });
        continue;
      }
    }

    callbacks?.onInfo?.(`Executing ${stmt.modelName}...`);

    try {
      // Preserve the original call arity when the caller opted out of
      // cancellation, so a custom runner (or a test double) sees exactly the
      // single-argument call it always has.
      const result = signal ? await runner(stmt.sql, { signal }) : await runner(stmt.sql);
      // Host-registered runners are allowed to keep their legacy `(sql)`
      // implementation and ignore the options parameter. If one resolves after
      // the caller aborted, do not turn that late resolution into successful
      // state — cancellation won the public execution contract.
      if (signal?.aborted) {
        callbacks?.onInfo?.(`${stmt.modelName}: cancelled before completion was observed.`);
        cancelRemaining(index, 'Cancelled before statement completion was observed.');
        return results;
      }
      callbacks?.onSuccess?.(`${stmt.modelName}: executed.`);
      results.push({
        modelName: stmt.modelName,
        status: 'success',
        rowsAffected: result.rowCount,
      });
    } catch (error: unknown) {
      // A cancelled statement is not a failure: it carries no warehouse
      // diagnostic and must not mark dependents as "upstream failed". Stop
      // here and report the rest as cancelled too.
      if (isCancellationError(error, signal)) {
        callbacks?.onInfo?.(`${stmt.modelName}: cancelled in flight.`);
        cancelRemaining(index, 'Cancelled while the statement was in flight.');
        return results;
      }
      // Redact any materialized DOGSLED_MATCH_KEY_SECRET literal a driver may
      // have echoed from the failing statement before it reaches logs/results.
      const message = redactMatchKeySecret(
        error instanceof Error ? error.message : 'Unknown error'
      );
      const messageLower = message.toLowerCase();
      const ignoredPattern = stmt.ignoreErrorPatterns?.find((pattern) => {
        const fragment = pattern.trim().toLowerCase();
        return fragment.length > 0 && messageLower.includes(fragment);
      });
      if (ignoredPattern) {
        callbacks?.onInfo?.(
          `${stmt.modelName}: ignored idempotent error matching "${ignoredPattern}"`
        );
        results.push({
          modelName: stmt.modelName,
          status: 'success',
        });
        continue;
      }
      callbacks?.onError?.(`${stmt.modelName}: execution failed — ${message}`);
      failedModels.add(stmt.modelName.toLowerCase());
      results.push({
        modelName: stmt.modelName,
        status: 'failed',
        error: message,
      });
    }
  }

  return results;
}
