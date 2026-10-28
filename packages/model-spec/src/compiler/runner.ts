/**
 * Public SQL runner contracts for CLI execution and query-backed commands.
 *
 * `SqlDryRunner` is sourced from `@bobsled-inc/connections` so the dry-run
 * primitive has one definition across the monorepo. `SqlRunnerModule` here
 * remains a deliberately narrower shape than the connections module — this is
 * the contract `--runner ./r.js` imports honour, and the extra fields on the
 * connections variant (`streamQueryRows`, `unload`, `supportsBindings`) are
 * built-in-runner concerns that user-provided modules need not implement.
 */

import type { SqlDryRunner, SqlExecOptions, SqlParams } from '@bobsled-inc/connections';

import type { SqlRunner } from './executor.js';

export type { SqlDryRunner, SqlExecOptions };

export interface SqlQueryRow {
  [columnName: string]: unknown;
}

/**
 * Query-capable companion contract used by review export and similar commands.
 *
 * `params` and `options` are optional and positioned to match the connections
 * variant, so a built-in runner module drops straight into this narrower shape.
 * A user-supplied `--runner ./r.js` exporting `query(sql)` still satisfies the
 * type — it simply declares fewer parameters and ignores cancellation.
 */
export type SqlQueryRunner<TRow extends SqlQueryRow = SqlQueryRow> = (
  sql: string,
  params?: SqlParams,
  options?: SqlExecOptions
) => Promise<TRow[]>;

/** Public module shape accepted by CLI `--runner` imports. */
export interface SqlRunnerModule {
  run: SqlRunner;
  dryRun?: SqlDryRunner;
  query?: SqlQueryRunner;
  /**
   * Optional cleanup hook. CLI commands that hold long-lived runner
   * resources (PG/SF/BQ pools, DuckDB connections) must call `close?.()`
   * in a try/finally so the process can exit cleanly. Documented in
   * `packages/model-spec/AGENTS.md` and the `SqlRunner` contract below.
   */
  close?: () => Promise<void>;
}
