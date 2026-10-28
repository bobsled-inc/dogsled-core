/**
 * Standalone MySQL client for the extractor.
 *
 * No existing MySQL code in the codebase — new implementation.
 * Uses `mysql2` driver with connection pooling and streaming.
 * Must NOT import from app/ — fully standalone.
 *
 * The `mysql2` package is loaded via dynamic `import()` to avoid errors
 * when the package is not installed.
 */

import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
} from './warehouse-client.js';
import { MAX_STATEMENT_TIMEOUT_MS } from './warehouse-constants.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MysqlPasswordAuth {
  type: 'password';
  username: string;
  password: string;
}

export interface MysqlIamAuth {
  type: 'iam';
  username: string;
  token: string;
}

export interface MysqlSslConfig {
  mode: 'disable' | 'require' | 'verify-ca' | 'verify-identity';
  caCert?: string; // PEM-encoded
}

export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  auth: MysqlPasswordAuth | MysqlIamAuth;
  ssl?: MysqlSslConfig;
  maxConnections?: number;
  statementTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of rows per yielded batch from execute(). */
const BATCH_SIZE = 10_000;

/** Default maximum pool connections. */
const DEFAULT_MAX_CONNECTIONS = 5;

/** Connection timeout (ms). */
const CONNECTION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal driver types (avoiding direct import of mysql2 types at module level)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a mysql2 promise pool.
 * The dynamic import returns the real pool which satisfies this interface.
 */
interface Mysql2PoolLike {
  getConnection(): Promise<Mysql2ConnectionLike>;
  execute(sql: string, params?: unknown[]): Promise<[Mysql2RowsResult, unknown]>;
  end(): Promise<void>;
}

interface Mysql2ConnectionLike {
  execute(sql: string, params?: unknown[]): Promise<[Mysql2RowsResult, unknown]>;
  connection: {
    query(sql: string, params?: unknown[]): Mysql2QueryLike;
  };
  release(): void;
}

type Mysql2RowsResult = Record<string, unknown>[];

interface Mysql2QueryLike {
  stream(opts?: { highWaterMark?: number }): AsyncIterable<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build SSL configuration for the mysql2 driver based on our config.
 */
function buildMysqlSslConfig(
  ssl: MysqlSslConfig | undefined
): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!ssl || ssl.mode === 'disable') {
    return false;
  }

  const shouldVerify = ssl.mode === 'verify-ca' || ssl.mode === 'verify-identity';

  return {
    rejectUnauthorized: shouldVerify,
    ...(ssl.caCert ? { ca: ssl.caCert } : {}),
  };
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class MysqlWarehouseClient implements WarehouseClient {
  readonly dialect = 'mysql' as const;
  private pool: Mysql2PoolLike | null = null;
  private readonly config: MysqlConfig;
  private maxExecutionTimeSupported = true;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseMysqlConfig(rawConfig);
  }

  // -----------------------------------------------------------------------
  // Pool management
  // -----------------------------------------------------------------------

  private async getPool(): Promise<Mysql2PoolLike> {
    if (this.pool) {
      return this.pool;
    }

    let mysql2: { createPool: (config: Record<string, unknown>) => Mysql2PoolLike };
    try {
      // Dynamic import — mysql2 may not be installed at compile time.
      // The module specifier is constructed at runtime to avoid TS2307.
      const moduleName = 'mysql2/promise';
      mysql2 = await import(/* webpackIgnore: true */ moduleName);
    } catch {
      throw new Error(
        'mysql2 package is not installed. Add mysql2 to dependencies: pnpm add mysql2'
      );
    }

    const poolConfig: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      connectionLimit: this.config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      connectTimeout: CONNECTION_TIMEOUT_MS,
      // Return rows as plain objects (default for mysql2/promise)
      rowsAsArray: false,
    };

    // Auth
    if (this.config.auth.type === 'password') {
      poolConfig['user'] = this.config.auth.username;
      poolConfig['password'] = this.config.auth.password;
    } else {
      // IAM auth uses the token as the password
      poolConfig['user'] = this.config.auth.username;
      poolConfig['password'] = this.config.auth.token;
    }

    // SSL
    const sslConfig = buildMysqlSslConfig(this.config.ssl);
    if (sslConfig !== false) {
      poolConfig['ssl'] = sslConfig;
    }

    this.pool = mysql2.createPool(poolConfig);

    return this.pool;
  }

  // -----------------------------------------------------------------------
  // Session configuration
  // -----------------------------------------------------------------------

  /**
   * Configure session-level settings on a connection:
   * - READ ONLY transaction mode for defense-in-depth
   * - Statement timeout via MAX_EXECUTION_TIME (MySQL 5.7.8+)
   */
  private async configureSession(connection: Mysql2ConnectionLike): Promise<void> {
    await connection.execute('SET SESSION TRANSACTION READ ONLY');

    if (this.config.statementTimeoutMs && this.maxExecutionTimeSupported) {
      try {
        await connection.execute(
          `SET SESSION MAX_EXECUTION_TIME = ${Math.floor(this.config.statementTimeoutMs)}`
        );
      } catch (err: unknown) {
        // MAX_EXECUTION_TIME is MySQL 5.7.8+ only; disable for unsupported versions.
        // MySQL error 1193 = "Unknown system variable". Re-throw other errors.
        const code =
          err && typeof err === 'object' && 'errno' in err
            ? (err as { errno: number }).errno
            : undefined;
        if (code === 1193) {
          this.maxExecutionTimeSupported = false;
        } else {
          throw err;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // execute — AsyncGenerator yielding row batches
  // -----------------------------------------------------------------------

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();

    try {
      await this.configureSession(connection);
      // Attempt streaming via the underlying connection's query().stream()
      // mysql2 streaming is available on the non-promise connection object
      let useStreaming = false;
      try {
        // Test if the streaming interface is available
        if (connection.connection && typeof connection.connection.query === 'function') {
          useStreaming = true;
        }
      } catch {
        // Fall back to non-streaming
      }

      if (useStreaming) {
        yield* this.executeStreaming(connection, sql, params ?? [], opts);
      } else {
        yield* this.executeFallback(connection, sql, params ?? [], opts);
      }
    } finally {
      connection.release();
    }
  }

  /**
   * Streaming execution using mysql2's query().stream().
   */
  private async *executeStreaming(
    connection: Mysql2ConnectionLike,
    sql: string,
    params: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const stream = connection.connection.query(sql, params).stream({
      highWaterMark: BATCH_SIZE,
    });

    const maxRows = opts?.maxRows;
    let emittedRows = 0;
    let batch: Record<string, unknown>[] = [];

    for await (const row of stream) {
      if (maxRows !== undefined && emittedRows >= maxRows) {
        break;
      }

      batch.push(row as Record<string, unknown>);

      if (batch.length >= BATCH_SIZE) {
        // Trim batch to maxRows if needed
        if (maxRows !== undefined && emittedRows + batch.length > maxRows) {
          batch = batch.slice(0, maxRows - emittedRows);
        }
        yield batch;
        emittedRows += batch.length;
        batch = [];
      }
    }

    // Yield remaining rows
    if (batch.length > 0) {
      if (maxRows !== undefined && emittedRows + batch.length > maxRows) {
        batch = batch.slice(0, maxRows - emittedRows);
      }
      if (batch.length > 0) {
        yield batch;
      }
    }
  }

  /**
   * Fallback: full query execution with in-memory chunking.
   */
  private async *executeFallback(
    connection: Mysql2ConnectionLike,
    sql: string,
    params: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const [rows] = await connection.execute(sql, params);
    const maxRows = opts?.maxRows;
    const totalRows = maxRows !== undefined ? Math.min(rows.length, maxRows) : rows.length;

    let offset = 0;
    while (offset < totalRows) {
      const end = Math.min(offset + BATCH_SIZE, totalRows);
      const batch = rows.slice(offset, end);
      if (batch.length > 0) {
        yield batch;
      }
      offset = end;
    }
  }

  // -----------------------------------------------------------------------
  // testConnection
  // -----------------------------------------------------------------------

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      for await (const _batch of this.execute('SELECT 1 AS connected')) {
        // consume first batch
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  // -----------------------------------------------------------------------
  // introspect — INFORMATION_SCHEMA-based discovery
  // -----------------------------------------------------------------------

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // MySQL doesn't have schemas like PostgreSQL; the "schema" parameter
    // maps to the database name. We use the database parameter for
    // INFORMATION_SCHEMA queries. The schema parameter is accepted for
    // interface compatibility but we use database for the actual query.
    const targetDb = schema || database;

    const sql = `
      SELECT
        c.TABLE_NAME AS table_name,
        c.COLUMN_NAME AS column_name,
        c.COLUMN_TYPE AS data_type,
        c.IS_NULLABLE AS is_nullable,
        c.COLUMN_COMMENT AS comment,
        CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT kcu2.TABLE_SCHEMA, kcu2.TABLE_NAME, kcu2.COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
        JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          ON tc.CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME
          AND tc.TABLE_SCHEMA = kcu2.TABLE_SCHEMA
          AND tc.TABLE_NAME = kcu2.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) kcu ON kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND kcu.TABLE_NAME = c.TABLE_NAME
        AND kcu.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = ?
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql, [targetDb])) {
      for (const row of batch) {
        const tableName = String(row['table_name'] ?? '');
        let table = tables.get(tableName);
        if (!table) {
          table = { tableName, schema: targetDb, database, columns: [] };
          tables.set(tableName, table);
        }

        const column: ColumnDiscovery = {
          name: String(row['column_name'] ?? ''),
          sourceType: String(row['data_type'] ?? ''),
          nullable: String(row['is_nullable']) === 'YES',
          isPrimaryKey: String(row['is_primary_key']) === 'YES',
          ...(row['comment'] && String(row['comment']).length > 0
            ? { comment: String(row['comment']) }
            : {}),
        };
        table.columns.push(column);
      }
    }

    return Array.from(tables.values());
  }

  // -----------------------------------------------------------------------
  // close — end the pool
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function parseMysqlConfig(raw: Record<string, unknown>): MysqlConfig {
  const host = requireString(raw, 'host');
  const port = requireNumber(raw, 'port');
  const database = requireString(raw, 'database');
  const maxConnections = optionalNumber(raw, 'max_connections');

  // Auth
  const authRaw = raw['auth'];
  if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
    throw new Error('MysqlConfig: "auth" must be an object');
  }
  const authObj = authRaw as Record<string, unknown>;
  const authType = requireString(authObj, 'type');

  let auth: MysqlConfig['auth'];
  if (authType === 'password') {
    auth = {
      type: 'password',
      username: requireString(authObj, 'username'),
      password: requireString(authObj, 'password'),
    };
  } else if (authType === 'iam') {
    auth = {
      type: 'iam',
      username: requireString(authObj, 'username'),
      token: requireString(authObj, 'token'),
    };
  } else {
    throw new Error(
      `MysqlConfig: unsupported auth type "${authType}" (expected "password" or "iam")`
    );
  }

  // SSL (optional)
  let ssl: MysqlSslConfig | undefined;
  const sslRaw = raw['ssl'];
  if (sslRaw && typeof sslRaw === 'object' && !Array.isArray(sslRaw)) {
    const sslObj = sslRaw as Record<string, unknown>;
    const mode = requireString(sslObj, 'mode');
    const validModes = ['disable', 'require', 'verify-ca', 'verify-identity'];
    if (!validModes.includes(mode)) {
      throw new Error(
        `MysqlConfig: unsupported ssl.mode "${mode}" (expected one of: ${validModes.join(', ')})`
      );
    }
    ssl = {
      mode: mode as MysqlSslConfig['mode'],
      caCert: optionalString(sslObj, 'caCert'),
    };
  }

  const statementTimeoutMs = optionalNumber(raw, 'statement_timeout_ms');
  if (statementTimeoutMs !== undefined) {
    if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
      throw new Error('MysqlConfig: "statement_timeout_ms" must be a positive integer');
    }
    if (statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
      throw new Error(
        `MysqlConfig: "statement_timeout_ms" must not exceed ${MAX_STATEMENT_TIMEOUT_MS} (24h)`
      );
    }
  }

  return { host, port, database, auth, ssl, maxConnections, statementTimeoutMs };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`MysqlConfig: "${key}" is required and must be a non-empty string`);
  }
  return val;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`MysqlConfig: "${key}" is required and must be a finite number`);
  }
  return val;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'string') {
    throw new Error(`MysqlConfig: "${key}" must be a string if provided`);
  }
  return val;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`MysqlConfig: "${key}" must be a finite number if provided`);
  }
  return val;
}
