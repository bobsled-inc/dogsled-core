/**
 * Shared base class for PostgreSQL-compatible warehouse clients.
 *
 * Both PostgreSQL and Redshift use the `pg` driver with identical pool
 * management, execution, and config parsing logic. Only the dialect name
 * and introspection queries differ.
 */

import { createRequire } from 'node:module';
import { assertDriverVersion } from '@bobsled-inc/connections';

import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
  Dialect,
} from './warehouse-client.js';
import { MAX_STATEMENT_TIMEOUT_MS } from './warehouse-constants.js';

// ---------------------------------------------------------------------------
// Shared configuration types
// ---------------------------------------------------------------------------

export interface PgPasswordAuth {
  type: 'password';
  username: string;
  password: string;
}

export interface PgIamAuth {
  type: 'iam';
  username: string;
  token: string;
}

export interface PgSslConfig {
  mode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  caCert?: string; // PEM-encoded
}

export interface PgCompatibleConfig {
  host: string;
  port: number;
  database: string;
  /**
   * Optional default schema. When set, the client issues
   * `SET search_path TO "<schema>", public` on every session so unqualified
   * table names in user-authored SQL resolve against it. When omitted, the
   * server-side default (usually the user's role search_path) applies — the
   * same contract @bobsled-inc/connections's postgres runner offers.
   */
  schema?: string;
  auth: PgPasswordAuth | PgIamAuth;
  ssl?: PgSslConfig;
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

/** Connection pool idle timeout (ms). */
const IDLE_TIMEOUT_MS = 30_000;

/** Connection timeout (ms). */
const CONNECTION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal driver types (avoiding direct import of pg types at module level)
// ---------------------------------------------------------------------------

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgClientLike {
  query(
    textOrConfig: string | { text: string; values?: unknown[]; rowMode?: string },
    values?: unknown[]
  ): Promise<PgQueryResultLike>;
  release(): void;
}

interface PgQueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  fields: Array<{ name: string; dataTypeID: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSslConfig(
  ssl: PgSslConfig | undefined
): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!ssl || ssl.mode === 'disable') {
    return false;
  }

  const shouldVerify = ssl.mode === 'verify-ca' || ssl.mode === 'verify-full';

  return {
    rejectUnauthorized: shouldVerify,
    ...(ssl.caCert ? { ca: ssl.caCert } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export function parsePgCompatibleConfig(
  raw: Record<string, unknown>,
  label: string
): PgCompatibleConfig {
  const host = requireString(raw, 'host', label);
  const port = requireNumber(raw, 'port', label);
  const database = requireString(raw, 'database', label);
  // `schema` is intentionally optional here: the YAML/Zod connection
  // schema marks it optional ("Model Spec models can override at the model level"),
  // and the runtime previously crashed when it was omitted. Coerce empty
  // strings to undefined so an explicit `schema: ""` in YAML behaves the
  // same as omitting the field — otherwise `configureSession` would emit
  // `SET search_path TO "", public` and confuse Postgres.
  const rawSchema = optionalString(raw, 'schema', label);
  const schema = rawSchema === '' ? undefined : rawSchema;
  const maxConnections = optionalNumber(raw, 'max_connections', label);

  // Auth
  const authRaw = raw['auth'];
  if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
    throw new Error(`${label}: "auth" must be an object`);
  }
  const authObj = authRaw as Record<string, unknown>;
  const authType = requireString(authObj, 'type', label);

  let auth: PgCompatibleConfig['auth'];
  if (authType === 'password') {
    auth = {
      type: 'password',
      username: requireString(authObj, 'username', label),
      password: requireString(authObj, 'password', label),
    };
  } else if (authType === 'iam') {
    auth = {
      type: 'iam',
      username: requireString(authObj, 'username', label),
      token: requireString(authObj, 'token', label),
    };
  } else {
    throw new Error(`${label}: unsupported auth type "${authType}" (expected "password" or "iam")`);
  }

  // SSL (optional)
  let ssl: PgSslConfig | undefined;
  const sslRaw = raw['ssl'];
  if (sslRaw && typeof sslRaw === 'object' && !Array.isArray(sslRaw)) {
    const sslObj = sslRaw as Record<string, unknown>;
    const mode = requireString(sslObj, 'mode', label);
    const validModes = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
    if (!validModes.includes(mode)) {
      throw new Error(
        `${label}: unsupported ssl.mode "${mode}" (expected one of: ${validModes.join(', ')})`
      );
    }
    ssl = {
      mode: mode as PgSslConfig['mode'],
      caCert: optionalString(sslObj, 'caCert', label),
    };
  }

  const statementTimeoutMs = optionalNumber(raw, 'statement_timeout_ms', label);
  if (statementTimeoutMs !== undefined) {
    if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
      throw new Error(`${label}: "statement_timeout_ms" must be a positive integer`);
    }
    if (statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
      throw new Error(
        `${label}: "statement_timeout_ms" must not exceed ${MAX_STATEMENT_TIMEOUT_MS} (24h)`
      );
    }
  }

  return { host, port, database, schema, auth, ssl, maxConnections, statementTimeoutMs };
}

function requireString(obj: Record<string, unknown>, key: string, label: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`${label}: "${key}" is required and must be a non-empty string`);
  }
  return val;
}

function requireNumber(obj: Record<string, unknown>, key: string, label: string): number {
  const val = obj[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`${label}: "${key}" is required and must be a finite number`);
  }
  return val;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'string') {
    throw new Error(`${label}: "${key}" must be a string if provided`);
  }
  return val;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  label: string
): number | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`${label}: "${key}" must be a finite number if provided`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class PgCompatibleWarehouseClient implements WarehouseClient {
  abstract readonly dialect: Dialect;
  private pool: PgPoolLike | null = null;
  protected readonly config: PgCompatibleConfig;

  constructor(rawConfig: Record<string, unknown>, configLabel: string) {
    this.config = parsePgCompatibleConfig(rawConfig, configLabel);
  }

  private async configureSession(client: PgClientLike): Promise<void> {
    // Only override search_path when the user explicitly set a default schema.
    // Without this guard, an omitted `schema` previously threw at parse time;
    // omitting it now leaves the server-side default in place, matching the
    // contract exposed by @bobsled-inc/connections's postgres runner.
    if (this.config.schema) {
      const escapedSchema = `"${this.config.schema.replace(/"/g, '""')}"`;
      await client.query(`SET search_path TO ${escapedSchema}, public`);
    }

    if (this.config.statementTimeoutMs != null) {
      const timeoutMs = this.config.statementTimeoutMs;
      await client.query(`SET statement_timeout = ${timeoutMs}`);
    }
  }

  // -----------------------------------------------------------------------
  // Pool management
  // -----------------------------------------------------------------------

  private async getPool(): Promise<PgPoolLike> {
    if (this.pool) {
      return this.pool;
    }

    assertDriverVersion('pg', '8.4.0', createRequire(import.meta.url));
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;

    const sslConfig = buildSslConfig(this.config.ssl);

    const poolConfig: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      max: this.config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
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
    if (sslConfig !== false) {
      poolConfig['ssl'] = sslConfig;
    }

    this.pool = new Pool(poolConfig) as PgPoolLike;

    this.pool.on('error', (err: unknown) => {
      // Log but swallow unexpected pool errors to avoid crashing the process.
      // Errors on individual queries are handled in execute().
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pg-pool] unexpected error: ${message}\n`);
    });

    return this.pool;
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
    const client = await pool.connect();
    const cursorName = '_dogsled_cursor';
    let inTransaction = false;
    let cursorOpen = false;

    try {
      await this.configureSession(client);

      // Use a server-side cursor to stream results in batches, avoiding
      // loading the entire result set into memory. Requires a transaction.
      // Cursor name is static — safe because each execute() acquires its own
      // connection from the pool, and PG cursors are connection-scoped.
      await client.query('BEGIN READ ONLY');
      inTransaction = true;

      // DECLARE requires the query to be inlined (cannot use $N params
      // directly). We use a prepared statement wrapper to keep params safe.
      if (params && params.length > 0) {
        // Create a prepared statement, then declare a cursor for it
        await client.query({
          text: `DECLARE ${cursorName} CURSOR FOR ${sql}`,
          values: params,
        });
      } else {
        await client.query(`DECLARE ${cursorName} CURSOR FOR ${sql}`);
      }
      cursorOpen = true;

      const maxRows = opts?.maxRows;
      let emitted = 0;

      while (true) {
        const result = await client.query(`FETCH ${BATCH_SIZE} FROM ${cursorName}`);
        const rows = result.rows;
        if (rows.length === 0) break;

        if (maxRows !== undefined) {
          const remaining = maxRows - emitted;
          const batch = remaining < rows.length ? rows.slice(0, remaining) : rows;
          yield batch;
          emitted += batch.length;
          if (emitted >= maxRows) break;
        } else {
          yield rows;
        }
      }
      await client.query(`CLOSE ${cursorName}`);
      cursorOpen = false;
      await client.query('COMMIT');
      inTransaction = false;
    } finally {
      if (cursorOpen) {
        try {
          await client.query(`CLOSE ${cursorName}`);
        } catch {
          // ignore cursor cleanup errors on early termination
        }
      }
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors during cleanup
        }
      }
      client.release();
    }
  }

  async queryRows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      await this.configureSession(client);
      const result = await client.query({
        text: sql,
        ...(params && params.length > 0 ? { values: params } : {}),
      });
      return result.rows;
    } finally {
      client.release();
    }
  }

  async advanceReplicationSlot(slotName: string, lsn: string): Promise<string> {
    const rows = await this.queryRows(
      'SELECT end_lsn::text AS end_lsn FROM pg_replication_slot_advance($1, $2::pg_lsn)',
      [slotName, lsn]
    );
    const advancedLsn = rows[0]?.['end_lsn'];
    if (typeof advancedLsn !== 'string' || advancedLsn.length === 0) {
      throw new Error(`Failed to advance replication slot "${slotName}" to ${lsn}`);
    }
    return advancedLsn;
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
  // introspect — subclasses provide dialect-specific queries
  // -----------------------------------------------------------------------

  abstract introspect(database: string, schema: string): Promise<TableDiscovery[]>;

  /** Helper for subclass introspect methods to process row results into TableDiscovery. */
  protected processIntrospectionRows(
    rows: Record<string, unknown>[],
    database: string,
    schema: string,
    tables: Map<string, TableDiscovery>
  ): void {
    for (const row of rows) {
      const tableName = String(row['table_name'] ?? '');
      let table = tables.get(tableName);
      if (!table) {
        table = { tableName, schema, database, columns: [] };
        tables.set(tableName, table);
      }

      const column: ColumnDiscovery = {
        name: String(row['column_name'] ?? ''),
        sourceType: String(row['data_type'] ?? ''),
        nullable: row['is_nullable'] === true,
        isPrimaryKey: row['is_primary_key'] === true,
        ...(row['comment'] ? { comment: String(row['comment']) } : {}),
      };
      table.columns.push(column);
    }
  }

  // -----------------------------------------------------------------------
  // close — drain the pool
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
