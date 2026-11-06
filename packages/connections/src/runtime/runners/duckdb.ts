/**
 * Built-in DuckDB runner.
 *
 * DuckDB is the CI-friendly runner — no credentials required, so it serves
 * as the reference implementation with real driver, real SQL execution, and
 * real tests. Snowflake, BigQuery, Postgres, and Databricks runners follow
 * the same shape but dynamic-import their drivers lazily so the package
 * does not pay the install cost when a user's project never touches them.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import type { DuckDbAuth } from '../../schemas/duckdb.js';
import type { DuckDbIntegration } from '../../schemas/integration.js';
import { runCancellable } from '../cancellation.js';
import type {
  SqlExecOptions,
  SqlParams,
  SqlRunnerModule,
  SqlRunResult,
  UnloadOptions,
  UnloadResult,
} from '../types.js';

/**
 * A minimal DuckDB interface covering what the runner actually uses. Declared
 * here rather than imported from `@duckdb/node-api` so the module compiles
 * even when the driver is absent — the type is structural, and the real
 * driver's exported objects satisfy it.
 */
interface DuckDbInstanceLike {
  connect(): Promise<DuckDbConnectionLike>;
  closeSync?(): void;
}
interface DuckDbInstanceConfig {
  access_mode?: 'READ_ONLY' | 'READ_WRITE' | 'AUTOMATIC';
  enable_external_access?: 'false';
  autoload_known_extensions?: 'false';
  autoinstall_known_extensions?: 'false';
  lock_configuration?: 'true';
}
interface DuckDbConnectionLike {
  run(sql: string): Promise<DuckDbResultLike>;
  runAndReadAll?(sql: string): Promise<DuckDbResultLike>;
  prepare?(sql: string): Promise<DuckDbPreparedStatementLike> | DuckDbPreparedStatementLike;
  /**
   * Interrupts the query currently executing on this connection.
   * `DuckDBConnection.interrupt(): void` — see
   * `@duckdb/node-api/lib/DuckDBConnection.d.ts`. Optional here because the
   * structural type must keep compiling against older driver builds.
   */
  interrupt?(): void;
  closeSync?(): void;
  disconnectSync?(): void;
}
interface DuckDbPreparedStatementLike {
  bind(values: readonly unknown[], types?: readonly unknown[]): void;
  runAndReadAll(): Promise<DuckDbResultLike>;
}
interface DuckDbResultLike {
  rowCount?: number | bigint;
  getRowObjects?(): Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
}

interface DuckDbDriverLike {
  DuckDBInstance: {
    create(path: string, config?: DuckDbInstanceConfig): Promise<DuckDbInstanceLike>;
  };
  DOUBLE?: unknown;
}

async function loadDuckDb(): Promise<DuckDbDriverLike> {
  try {
    return (await import('@duckdb/node-api')) as unknown as DuckDbDriverLike;
  } catch (err) {
    throw new CommandError(
      '@duckdb/node-api is required for the built-in DuckDB runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

/**
 * The driver binds every whole JS number as a 32-bit integer and silently wraps anything
 * larger, so 3000000000 is stored as -1294967296. Send other safe integers as bigint, which
 * it binds exactly, and whole numbers beyond that as doubles, which is what they are.
 */
function boundParams(
  params: readonly unknown[],
  driver: DuckDbDriverLike
): { values: unknown[]; types: unknown[] } {
  const types: unknown[] = [];
  const values = params.map((value, index) => {
    if (typeof value !== 'number' || Math.round(value) !== value) return value;
    if (value >= -2147483648 && value <= 2147483647) return value;
    if (Number.isSafeInteger(value)) return BigInt(value);
    types[index] = driver.DOUBLE;
    return value;
  });
  return { values, types };
}

function dbPathFromAuth(auth: DuckDbAuth): string {
  return auth.type === 'memory' ? ':memory:' : auth.path;
}

/**
 * Whether the optional DuckDB driver can be loaded here. A missing package and a
 * native binding that fails to load are both reported as unavailable.
 */
export async function isDuckDbAvailable(): Promise<boolean> {
  try {
    await loadDuckDb();
    return true;
  } catch {
    return false;
  }
}

function escapeDuckDbString(value: string): string {
  return value.replace(/'/g, "''");
}

function usesHttpFs(uri: string): boolean {
  return /^(s3|gs|gcs|azure):\/\//i.test(uri);
}

function isLocalUri(uri: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri);
}

function parquetUri(targetUri: string): string {
  if (/\.parquet$/i.test(targetUri)) return targetUri;
  return `${targetUri.replace(/\/+$/, '')}/part-00000.parquet`;
}

/** No access to other files, the network or extensions, and no statement can turn it back on. */
const ISOLATED_CONFIG: DuckDbInstanceConfig = {
  enable_external_access: 'false',
  autoload_known_extensions: 'false',
  autoinstall_known_extensions: 'false',
  lock_configuration: 'true',
};

export interface DuckDbRunnerOptions {
  /** For a file that holds only data: a view stored in it cannot reach anything outside it. */
  isolated?: boolean;
}

/**
 * Construct a DuckDB runner from an integration. The returned module:
 *   - runs DDL / DML through `run()`
 *   - can read rows via `query()` (used by Model Spec for `seed diff` etc.)
 *   - releases the connection via `close()`
 *
 * In-memory integrations are ephemeral — every `buildDuckDbRunner` call
 * creates a fresh database. File-backed integrations share persistent state
 * across calls pointing at the same path.
 */
export async function buildDuckDbRunner(
  integration: DuckDbIntegration,
  options: DuckDbRunnerOptions = {}
): Promise<SqlRunnerModule> {
  const driver = await loadDuckDb();
  const dbPath = dbPathFromAuth(integration.auth);
  const readOnly = integration.auth.type === 'file' && integration.auth.read_only === true;
  // `DuckDBInstance.create()` opens (and creates) the database file but does NOT
  // create missing parent directories — opening e.g. `./data/x.duckdb` when
  // `./data` does not exist throws "IO Error: Cannot open file". Ensure the
  // parent dir exists for writable file-backed databases. Read-only opens are
  // left to fail if the path is absent (we do not fabricate a directory for a
  // read that is meant to find an existing database).
  if (integration.auth.type === 'file' && !readOnly) {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
  }
  const config: DuckDbInstanceConfig = {
    ...(readOnly ? { access_mode: 'READ_ONLY' } : {}),
    ...(options.isolated ? ISOLATED_CONFIG : {}),
  };
  const instance = await driver.DuckDBInstance.create(
    dbPath,
    Object.keys(config).length ? config : undefined
  );
  const connection = await instance.connect();

  // `interrupt()` cancels whatever is executing on this connection, so the
  // canceller can be registered before the statement is dispatched — there is
  // no per-statement handle to wait for.
  const withInterrupt = <T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T> =>
    runCancellable(signal, (register) => {
      register(() => {
        if (typeof connection.interrupt !== 'function') {
          throw new Error('The installed DuckDB driver does not expose interrupt().');
        }
        connection.interrupt();
      });
      return start();
    });

  const run = async (sql: string, options?: SqlExecOptions): Promise<SqlRunResult> => {
    const result = await withInterrupt(options?.signal, () => connection.run(sql));
    const rc = result.rowCount;
    if (typeof rc === 'bigint') {
      if (rc > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CommandError(
          `DuckDB returned rowCount=${rc.toString()} which exceeds Number.MAX_SAFE_INTEGER; ` +
            'refusing to narrow silently. Run a COUNT query to read the value as bigint.',
          1
        );
      }
      return { rowCount: Number(rc) };
    }
    return { rowCount: rc };
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): Promise<TRow[]> => {
    if (params !== undefined) {
      if (!Array.isArray(params)) {
        throw new CommandError('DuckDB runner only supports positional SQL bindings.', 2);
      }
      if (!connection.prepare) {
        throw new CommandError(
          'DuckDB driver does not expose prepare(); upgrade @duckdb/node-api for parameterized queries.',
          1
        );
      }
      const statement = await connection.prepare(sql);
      const bound = boundParams(params, driver);
      statement.bind(bound.values, bound.types);
      const result = await withInterrupt(options?.signal, () => statement.runAndReadAll());
      if (!result.getRowObjects) {
        throw new CommandError(
          'DuckDB driver returned a result without getRowObjects(); upgrade @duckdb/node-api.',
          1
        );
      }
      const rows = await result.getRowObjects();
      return rows as TRow[];
    }

    const readFn = connection.runAndReadAll ?? connection.run;
    const result = await withInterrupt(options?.signal, () => readFn.call(connection, sql));
    if (!result.getRowObjects) {
      throw new CommandError(
        'DuckDB driver returned a result without getRowObjects(); upgrade @duckdb/node-api.',
        1
      );
    }
    const rows = await result.getRowObjects();
    return rows as TRow[];
  };

  const close = async (): Promise<void> => {
    // Run each cleanup independently so a failure in one step does not prevent
    // the others — the driver's teardown should always release the native handle.
    //
    // Closing the INSTANCE (not just the connection) is what flushes DuckDB's
    // checkpoint to a file-backed database and releases the file lock. The
    // runner owns a fresh `DuckDBInstance.create()` (not the shared `fromCache`
    // pool), so closing it here is safe. Without it the instance lingers until
    // GC, so a fresh instance opened on the same file by a later phase (e.g.
    // entity-graph resolve apply → cluster) can race the not-yet-durable writes
    // and read a stale catalog ("Table with name ... does not exist").
    const errors: unknown[] = [];
    try {
      connection.closeSync?.();
    } catch (err) {
      errors.push(err);
    }
    try {
      connection.disconnectSync?.();
    } catch (err) {
      errors.push(err);
    }
    try {
      instance.closeSync?.();
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  };

  const unload = async (
    sql: string,
    targetUri: string,
    opts: UnloadOptions
  ): Promise<UnloadResult> => {
    if (opts.format !== 'parquet') {
      throw new CommandError(`DuckDB unload supports only parquet format, got ${opts.format}.`, 2);
    }
    const uri = parquetUri(targetUri);
    const exec = opts.signal ? { signal: opts.signal } : undefined;
    if (usesHttpFs(uri)) {
      if (exec) {
        await run('INSTALL httpfs', exec);
        await run('LOAD httpfs', exec);
      } else {
        await run('INSTALL httpfs');
        await run('LOAD httpfs');
      }
    } else if (isLocalUri(uri)) {
      await fs.mkdir(path.dirname(uri), { recursive: true });
    }
    const copySql = `COPY (${sql}) TO '${escapeDuckDbString(uri)}' (FORMAT PARQUET, OVERWRITE TRUE)`;
    const result = exec ? await run(copySql, exec) : await run(copySql);
    return {
      uris: [uri],
      rowCount: result.rowCount ?? 0,
    };
  };

  return { run, query, unload, supportsBindings: true, close };
}
