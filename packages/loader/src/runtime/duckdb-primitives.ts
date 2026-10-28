import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { ColumnType, SchemaColumn } from '@bobsled-inc/protocol';

/** Default timeout for DuckDB statements (5 minutes). */
export const DUCKDB_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * DI interfaces for DuckDB database and connection.
 *
 * These wrap the underlying `@duckdb/node-api` types with a narrower,
 * Promise-based surface so test mocks only need to implement a few methods
 * and production code does not need to thread the native DuckDB value
 * converters through the rest of the loader.
 */
export interface DuckDbConnectionLike {
  all(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
  interrupt?(): void;
  run(sql: string): Promise<void>;
}

export interface DuckDbDatabaseLike {
  close(): Promise<void>;
  connect(): Promise<DuckDbConnectionLike>;
}

/**
 * Open a DuckDB database at the given path (or ':memory:') and return a
 * DI-compatible handle. The underlying `DuckDBInstance` is created
 * asynchronously by the upstream driver.
 */
export async function openDuckDb(dbPath: string): Promise<DuckDbDatabaseLike> {
  // Lazy-load the native binding so importing this module (and the loader
  // barrels that reach it) does not eagerly resolve `@duckdb/node-api`. The
  // driver is only needed when a database is actually opened.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  return wrapInstance(instance);
}

function wrapInstance(instance: DuckDBInstance): DuckDbDatabaseLike {
  return {
    async connect(): Promise<DuckDbConnectionLike> {
      const conn = await instance.connect();
      return wrapConnection(conn);
    },
    async close(): Promise<void> {
      instance.closeSync();
    },
  };
}

function wrapConnection(conn: DuckDBConnection): DuckDbConnectionLike {
  return {
    async run(sql: string): Promise<void> {
      await conn.run(sql);
    },
    async all(sql: string): Promise<Record<string, unknown>[]> {
      const reader = await conn.runAndReadAll(sql);
      // `getRowObjectsJS()` returns JS built-ins (bigint for BIGINT, Date for
      // TIMESTAMP, number for DOUBLE, etc.) which matches the shape the rest
      // of the loader has historically consumed from the old `duckdb` package.
      return reader.getRowObjectsJS() as Record<string, unknown>[];
    },
    async close(): Promise<void> {
      conn.disconnectSync();
    },
  };
}

/**
 * Run a DuckDB statement with a timeout.
 *
 * Note: DuckDB's Node.js API does not support cancelling in-flight queries.
 * On timeout, the promise rejects but the underlying operation continues.
 * The stale callback is harmless (promise already settled), and DuckDB
 * serializes operations on a connection so there is no interference risk.
 */
export function runStatement(
  conn: DuckDbConnectionLike,
  sql: string,
  timeoutMs: number = DUCKDB_STATEMENT_TIMEOUT_MS
): Promise<void> {
  return withTimeout(
    conn.run(sql),
    timeoutMs,
    () => `DuckDB statement timed out after ${timeoutMs}ms: ${sql.slice(0, 200)}`
  );
}

export function allRows(
  conn: DuckDbConnectionLike,
  sql: string,
  timeoutMs: number = DUCKDB_STATEMENT_TIMEOUT_MS
): Promise<Record<string, unknown>[]> {
  return withTimeout(
    conn.all(sql),
    timeoutMs,
    () => `DuckDB query timed out after ${timeoutMs}ms: ${sql.slice(0, 200)}`
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message()));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function closeConnection(conn: DuckDbConnectionLike): Promise<void> {
  return conn.close();
}

export function closeDatabase(db: DuckDbDatabaseLike): Promise<void> {
  return db.close();
}

/** Close a DuckDB connection and database, preserving the first error encountered. */
export async function closeDuckDbResources(
  conn: DuckDbConnectionLike | null,
  db: DuckDbDatabaseLike | null
): Promise<void> {
  let closeError: unknown;

  if (conn) {
    try {
      await conn.close();
    } catch (error) {
      closeError = error;
    }
  }

  if (db) {
    try {
      await db.close();
    } catch (error) {
      if (closeError === undefined) {
        closeError = error;
      }
    }
  }

  if (closeError !== undefined) {
    throw closeError;
  }
}

/** Escape a value for use inside a DuckDB single-quoted string literal.
 *  DuckDB uses SQL-standard escaping: single quotes are doubled, backslashes are literal. */
export function escapeSqlString(value: string): string {
  return value.replaceAll('\0', '').replaceAll("'", "''");
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * DuckDB's `read_json(..., columns = {...})` accepts type annotations most
 * reliably as string literals inside the struct literal.
 */
export function quoteDuckDbTypeLiteral(typeName: string): string {
  return `'${typeName.replaceAll("'", "''")}'`;
}

export function mapDuckDbType(column: ColumnType | SchemaColumn): string {
  const type = typeof column === 'string' ? column : column.type;
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'string':
    case 'array':
    case 'object':
      return 'VARCHAR';
    case 'vector':
      // Always LIST (`FLOAT[]`), never fixed-size ARRAY (`FLOAT[N]`). DuckDB's
      // ARRAY → Parquet encoder over-materializes null rows: for a NULL row in
      // an ARRAY(N) column it writes N element slots with def=0/rep=1, which
      // BigQuery rejects as malformed when `parquetOptions.enableListInference`
      // is on. LIST encodes the null row as a single def-level marker. The
      // dimension is still enforced upstream by the embedder schema.
      return 'FLOAT[]';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

/** Regex matching valid DuckDB memory-limit values (e.g. "512MB", "2.5GiB"). */
export const MEMORY_LIMIT_PATTERN = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i;

/** Build a SQL column definition string for a Dogsled protocol schema column. */
export function buildColumnDef(col: SchemaColumn): string {
  return `${quoteIdentifier(col.name)} ${mapDuckDbType(col)}`;
}
