/**
 * Shared DuckDB engine for lakehouse format extraction (Iceberg, Delta).
 *
 * Wraps `@duckdb/node-api` with a narrow surface (run / queryAll / describe)
 * for use by Iceberg and Delta clients. The old callback-based `duckdb` package
 * required hand-rolled Promise wrappers; the new API is already Promise-native,
 * so this file is mostly thin adapters plus storage-credential helpers.
 */

import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import { escapeSqlString } from './sql-escape.js';

import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

// ---------------------------------------------------------------------------
// Resolved storage auth (env vars already resolved to values)
// ---------------------------------------------------------------------------

export type ResolvedStorageAuth =
  | {
      type: 'aws_credentials';
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
      region: string;
    }
  | { type: 'aws_iam'; region: string }
  | { type: 'gcp_hmac'; access_key_id: string; secret_access_key: string }
  | { type: 'gcp_service_account'; service_account_key: string }
  | { type: 'vended'; credentials: Record<string, string> };

// ---------------------------------------------------------------------------
// Thin wrappers around the native API
// ---------------------------------------------------------------------------

async function runStatement(conn: DuckDBConnection, sql: string): Promise<void> {
  await conn.run(sql);
}

async function queryAll(conn: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}

/** Valid discriminant values for `ResolvedStorageAuth.type`. Shared across lakehouse clients. */
export const VALID_STORAGE_TYPES = [
  'aws_credentials',
  'aws_iam',
  'gcp_hmac',
  'gcp_service_account',
  'vended',
] as const;

/**
 * Validate storage auth object: checks discriminant type AND required fields per variant.
 * Throws with a clear message if validation fails.
 */
export function validateStorageAuth(storage: unknown, label: string): ResolvedStorageAuth {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
    throw new Error(`${label}: "storage" must be an object`);
  }
  const obj = storage as Record<string, unknown>;
  const storageType = obj['type'];
  if (
    typeof storageType !== 'string' ||
    !(VALID_STORAGE_TYPES as readonly string[]).includes(storageType)
  ) {
    throw new Error(`${label}: "storage.type" must be one of: ${VALID_STORAGE_TYPES.join(', ')}`);
  }
  switch (storageType) {
    case 'aws_credentials':
      if (
        typeof obj['access_key_id'] !== 'string' ||
        typeof obj['secret_access_key'] !== 'string' ||
        typeof obj['region'] !== 'string'
      ) {
        throw new Error(
          `${label}: aws_credentials requires access_key_id, secret_access_key, and region`
        );
      }
      break;
    case 'aws_iam':
      if (typeof obj['region'] !== 'string') {
        throw new Error(`${label}: aws_iam requires region`);
      }
      break;
    case 'gcp_hmac':
      if (
        typeof obj['access_key_id'] !== 'string' ||
        typeof obj['secret_access_key'] !== 'string'
      ) {
        throw new Error(`${label}: gcp_hmac requires access_key_id and secret_access_key`);
      }
      break;
    case 'gcp_service_account':
      if (typeof obj['service_account_key'] !== 'string') {
        throw new Error(`${label}: gcp_service_account requires service_account_key`);
      }
      break;
    case 'vended':
      if (!obj['credentials'] || typeof obj['credentials'] !== 'object') {
        throw new Error(`${label}: vended requires credentials object`);
      }
      break;
  }
  return storage as ResolvedStorageAuth;
}

export { escapeSqlString } from './sql-escape.js';

// ---------------------------------------------------------------------------
// Column info from DESCRIBE
// ---------------------------------------------------------------------------

export interface DuckDbColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_EXTENSION_NAME = /^[a-z_][a-z0-9_]*$/i;

/** Allowlist of valid DuckDB storage settings to prevent SET injection. */
const VALID_STORAGE_SETTINGS = new Set([
  's3_access_key_id',
  's3_secret_access_key',
  's3_session_token',
  's3_region',
  's3_endpoint',
  'gcs.oauth2.token',
]);

/** Allowlist of safe TVF shapes for DESCRIBE queries. */
const SAFE_TVF_RE = /^(iceberg_scan|delta_scan|read_parquet)\('[^']*(?:''[^']*)*'\)$/;

// ---------------------------------------------------------------------------
// DuckDB Engine
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10_000;

export class DuckDbEngine {
  private readonly instance: DuckDBInstance;
  private readonly conn: DuckDBConnection;
  private gcpKeyTempFile: string | null = null;
  private previousGoogleAppCreds: string | undefined = undefined;
  /** Once true, only SELECT/DESCRIBE/EXPLAIN/PRAGMA queries are accepted. */
  private finalizedReadOnly = false;

  private constructor(instance: DuckDBInstance, conn: DuckDBConnection) {
    this.instance = instance;
    this.conn = conn;
  }

  /**
   * Create a new engine. The underlying DuckDB driver opens databases and
   * connections asynchronously, so construction is a static async factory.
   *
   * If `connect()` fails after the instance is open, we close the instance
   * synchronously before rethrowing so the native handle is not leaked.
   */
  static async create(): Promise<DuckDbEngine> {
    // Lazy-load the native binding so importing this module does not eagerly
    // resolve `@duckdb/node-api`. The driver is only needed when an engine is
    // actually instantiated (lakehouse format extraction).
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    try {
      const conn = await instance.connect();
      return new DuckDbEngine(instance, conn);
    } catch (error) {
      try {
        instance.closeSync();
      } catch {
        // best-effort cleanup; preserve the original connect error
      }
      throw error;
    }
  }

  /**
   * Install and load DuckDB extensions (e.g. 'iceberg', 'delta', 'httpfs').
   */
  async initExtensions(extensions: string[]): Promise<void> {
    for (const ext of extensions) {
      if (!VALID_EXTENSION_NAME.test(ext)) {
        throw new Error(`Invalid DuckDB extension name: ${ext}`);
      }
      await runStatement(this.conn, `INSTALL ${ext}`);
      await runStatement(this.conn, `LOAD ${ext}`);
    }
  }

  /**
   * Switch the engine into read-only mode.
   *
   * Historically this ran `SET access_mode = 'read_only'` on the connection.
   * The underlying `@duckdb/node-api` (DuckDB 1.4+) no longer permits changing
   * `access_mode` at runtime — it must be set when opening the instance.
   * Since INSTALL/LOAD and SET statements must run first, we cannot open in
   * read-only mode either.
   *
   * Instead, we enforce read-only at the JS layer: `run`, `queryAll`,
   * `query`, and `describe` check `finalizedReadOnly` and reject SQL that
   * isn't a plain read (SELECT / DESCRIBE / EXPLAIN / PRAGMA / WITH). This
   * is defense-in-depth on top of `SAFE_TVF_RE` and the short-lived,
   * in-memory, non-user-SQL-exposed nature of the engine.
   */
  async finalizeReadOnly(): Promise<void> {
    this.finalizedReadOnly = true;
  }

  /**
   * Throw if the engine is finalized read-only and `sql` is not a pure read.
   *
   * Prefix matching alone is insufficient — we also reject statement-splitting
   * (e.g. `SELECT 1; INSTALL httpfs`) and `WITH ... DELETE` / `WITH ... UPDATE`
   * CTEs that end in a write.
   */
  assertReadOnlySql(sql: string): void {
    if (!this.finalizedReadOnly) {
      return;
    }
    // Strip comments, string literals, and quoted identifiers before keyword
    // scanning so that benign data/identifier text (e.g. `SELECT 'update'`)
    // doesn't trigger the write-CTE guard.
    const normalized = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"]|"")*"/g, '""');
    const isReadPrefix = /^\s*(select|describe|explain|pragma|with)\b/i.test(normalized);
    const hasMultipleStatements = /;\s*\S/.test(normalized);
    // Only flag as write-CTE when a DML verb follows a closed CTE definition
    // at the top level (i.e., after a `)`), not when it appears inside one.
    const isWriteCte =
      /^\s*with\b/i.test(normalized) && /\)\s*(insert|update|delete|merge)\b/i.test(normalized);
    if (!isReadPrefix || hasMultipleStatements || isWriteCte) {
      throw new CommandError(
        'DuckDB engine is finalized read-only; only single SELECT/DESCRIBE/EXPLAIN/PRAGMA/WITH-SELECT statements are permitted'
      );
    }
  }

  /**
   * Configure storage credentials for S3/GCS access.
   */
  async configureStorage(auth: ResolvedStorageAuth): Promise<void> {
    // Wrap credential-setting statements to prevent leaking secrets in error messages
    const setSecret = async (setting: string, value: string): Promise<void> => {
      if (!VALID_STORAGE_SETTINGS.has(setting)) {
        throw new Error(`Unrecognized DuckDB storage setting: ${setting}`);
      }
      try {
        await runStatement(this.conn, `SET ${setting}='${escapeSqlString(value)}'`);
      } catch {
        throw new Error(`Failed to configure DuckDB storage setting: ${setting}`);
      }
    };

    switch (auth.type) {
      case 'aws_credentials':
        await setSecret('s3_access_key_id', auth.access_key_id);
        await setSecret('s3_secret_access_key', auth.secret_access_key);
        if (auth.session_token) {
          await setSecret('s3_session_token', auth.session_token);
        }
        await setSecret('s3_region', auth.region);
        break;

      case 'aws_iam':
        await setSecret('s3_region', auth.region);
        break;

      case 'gcp_hmac':
        await setSecret('s3_endpoint', 'storage.googleapis.com');
        await setSecret('s3_access_key_id', auth.access_key_id);
        await setSecret('s3_secret_access_key', auth.secret_access_key);
        break;

      case 'gcp_service_account': {
        // DuckDB's gcs extension reads credentials via GOOGLE_APPLICATION_CREDENTIALS.
        // Write the service account JSON key to a temp file and set the env var so
        // that the gcs extension picks it up when loaded.
        if (!auth.service_account_key || auth.service_account_key.trim().length === 0) {
          throw new Error('gcp_service_account requires a non-empty service_account_key');
        }

        const tempDir = mkdtempSync(join(tmpdir(), 'duckdb-gcs-'));
        const keyFilePath = join(tempDir, 'service-account.json');
        writeFileSync(keyFilePath, auth.service_account_key, { mode: 0o600 });

        this.gcpKeyTempFile = keyFilePath;
        this.previousGoogleAppCreds = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
        process.env['GOOGLE_APPLICATION_CREDENTIALS'] = keyFilePath;

        await this.initExtensions(['gcs']);
        break;
      }

      case 'vended': {
        // REST catalog vended credentials — map Iceberg config keys to DuckDB settings
        const creds = auth.credentials;
        if (creds['s3.access-key-id']) {
          await setSecret('s3_access_key_id', creds['s3.access-key-id']);
        }
        if (creds['s3.secret-access-key']) {
          await setSecret('s3_secret_access_key', creds['s3.secret-access-key']);
        }
        if (creds['s3.session-token']) {
          await setSecret('s3_session_token', creds['s3.session-token']);
        }
        if (creds['s3.region']) {
          await setSecret('s3_region', creds['s3.region']);
        }
        if (creds['gcs.oauth2.token']) {
          await this.initExtensions(['gcs']);
          await setSecret('gcs.oauth2.token', creds['gcs.oauth2.token']);
        }
        break;
      }
    }
  }

  /**
   * Execute a SQL query and return all rows.
   */
  async queryAll(sql: string): Promise<Record<string, unknown>[]> {
    this.assertReadOnlySql(sql);
    return queryAll(this.conn, sql);
  }

  /**
   * Execute a SQL query and yield results in batches.
   *
   * `runAndReadAll()` materializes every result row in JavaScript before it
   * returns. File sources can contain millions of rows, so use DuckDB's
   * streaming result API here and only retain one bounded batch at a time.
   *
   * A consumer that stops early closes this generator. Interrupting the
   * connection in that case releases the native query before the next
   * statement is run.
   */
  async *query(sql: string, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>[]> {
    this.assertReadOnlySql(sql);
    signal?.throwIfAborted();

    let completed = false;
    const onAbort = (): void => {
      // DuckDB's native stream has no per-result cancel method. Interrupting
      // the connection wakes a pending fetch and the catch below translates
      // that native error back to the caller's abort reason.
      try {
        this.conn.interrupt();
      } catch {
        // The connection may already be closing; the signal still causes the
        // next check to throw and the normal close path will finish cleanup.
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.conn.stream(sql);
      let batch: Record<string, unknown>[] = [];

      for await (const rows of result.yieldRowObjectJs()) {
        signal?.throwIfAborted();
        for (const row of rows) {
          batch.push(row as Record<string, unknown>);
          if (batch.length >= BATCH_SIZE) {
            yield batch;
            batch = [];
          }
        }
      }

      // An interrupt can make the native iterator finish without surfacing
      // its implementation-specific error. Check once more before exposing
      // the final partial batch so cancellation cannot look like success.
      signal?.throwIfAborted();
      if (batch.length > 0) {
        yield batch;
      }
      signal?.throwIfAborted();
      completed = true;
    } catch (error) {
      // The native interrupt error is implementation-specific. Preserve the
      // caller's AbortSignal reason as the stable cancellation contract.
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!completed) {
        try {
          this.conn.interrupt();
        } catch {
          // Best effort: the connection may already have completed or closed.
        }
      }
    }
  }

  /**
   * Describe the columns returned by a table-valued function or query expression.
   */
  async describe(tvf: string): Promise<DuckDbColumnInfo[]> {
    if (!SAFE_TVF_RE.test(tvf)) {
      throw new CommandError(
        `Unsafe TVF expression: only iceberg_scan(), delta_scan(), or read_parquet() are permitted`
      );
    }
    // `DESCRIBE SELECT ...` is safe under the read-only guard; no need to
    // assert separately.
    const rows = await queryAll(this.conn, `DESCRIBE SELECT * FROM ${tvf}`);
    return rows.map((row) => ({
      name: String(row['column_name'] ?? row['Field'] ?? ''),
      type: String(row['column_type'] ?? row['Type'] ?? ''),
      nullable: String(row['null'] ?? row['Null'] ?? 'YES') === 'YES',
    }));
  }

  /**
   * Execute a statement with no result (e.g. SET, INSTALL).
   */
  async run(sql: string): Promise<void> {
    this.assertReadOnlySql(sql);
    return runStatement(this.conn, sql);
  }

  /**
   * Close the connection and database.
   *
   * Both close paths are attempted. If either throws, the first error wins
   * (symmetric with the loader's `closeDuckDbResources`) so we don't lose the
   * root cause if the secondary close also fails.
   */
  async close(): Promise<void> {
    let firstError: unknown;

    try {
      this.conn.disconnectSync();
    } catch (error) {
      firstError = error;
    }

    try {
      this.instance.closeSync();
    } catch (error) {
      if (firstError === undefined) {
        firstError = error;
      }
    }

    // Clean up GCP service account temp file and restore env var. Best-effort —
    // never allowed to mask the close errors above.
    if (this.gcpKeyTempFile) {
      try {
        unlinkSync(this.gcpKeyTempFile);
      } catch {
        // Best-effort cleanup — temp dir will be purged by OS
      }
      if (this.previousGoogleAppCreds !== undefined) {
        process.env['GOOGLE_APPLICATION_CREDENTIALS'] = this.previousGoogleAppCreds;
      } else {
        delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      }
      this.gcpKeyTempFile = null;
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
