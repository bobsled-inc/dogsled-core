/**
 * Runtime types shared by built-in and custom runners.
 *
 * Structurally compatible with `@bobsled-inc/model-spec`'s `SqlRunnerModule`
 * shape so that `resolveRunner()`'s return value can be handed straight to
 * the Model Spec compiler without adaptation.
 */

/** Result of a DDL / DML `SqlRunner.run` call — row count is optional. */
export interface SqlRunResult {
  rowCount?: number;
}

/**
 * Per-statement execution options.
 *
 * Threaded as a trailing OPTIONAL parameter on every runner function so both
 * sides of the contract stay source-compatible: existing callers keep calling
 * `run(sql)`, and an existing `(sql) => Promise<...>` implementation still
 * satisfies the type (TypeScript allows an implementation to declare fewer
 * parameters than its signature).
 */
export interface SqlExecOptions {
  /**
   * Cooperative cancellation. An already-aborted signal prevents the statement
   * from being sent at all; an abort mid-statement makes the runner ask the
   * DRIVER to cancel the active operation (`interrupt()` / `job.cancel()` /
   * `statement.cancel()` / `operation.cancel()` / `pg_cancel_backend`) and
   * settle with a `SqlCancelledError`. See `runtime/cancellation.ts`.
   *
   * Custom runners registered by a host are not required to honour this — they
   * simply keep their pre-existing behaviour when they ignore the parameter.
   */
  signal?: AbortSignal;
}

/** DDL / DML runner — returns optional row count. */
export type SqlRunner = (sql: string, options?: SqlExecOptions) => Promise<SqlRunResult>;

/** Warehouse-native SQL validator. Implementations should not execute the SQL. */
export type SqlDryRunner = (sql: string, options?: SqlExecOptions) => Promise<void>;

/** Query runner — returns rows as record objects. Optional on `SqlRunnerModule`. */
export type SqlQueryRow = Record<string, unknown>;
export type SqlParamValue = string | number | boolean | bigint | Date | null;
export type SqlParams = ReadonlyArray<SqlParamValue> | Readonly<Record<string, SqlParamValue>>;
export type SqlQueryRunner<TRow extends SqlQueryRow = SqlQueryRow> = (
  sql: string,
  params?: SqlParams,
  options?: SqlExecOptions
) => Promise<TRow[]>;
export type SqlStreamRowsRunner<TRow extends SqlQueryRow = SqlQueryRow> = (
  sql: string,
  params?: SqlParams,
  options?: SqlExecOptions
) => AsyncIterable<TRow>;

export interface UnloadOptions {
  format: 'parquet';
  /** Cooperative cancellation for the UNLOAD/EXPORT statement. See {@link SqlExecOptions}. */
  signal?: AbortSignal;
}

export interface UnloadResult {
  uris: string[];
  rowCount: number;
  bytes?: number;
}

export type SqlUnloader = (
  sql: string,
  targetUri: string,
  opts: UnloadOptions
) => Promise<UnloadResult>;

/**
 * Concrete runner handed back to Model Spec. `close()` is optional — embedded
 * runners (DuckDB in-memory) may have nothing to clean up.
 */
export interface SqlRunnerModule {
  run: SqlRunner;
  dryRun?: SqlDryRunner;
  query?: SqlQueryRunner;
  streamQueryRows?: SqlStreamRowsRunner;
  unload?: SqlUnloader;
  supportsBindings?: boolean;
  close?: () => Promise<void>;
}
