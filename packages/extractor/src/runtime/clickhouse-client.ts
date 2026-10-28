/**
 * Standalone ClickHouse client for the extractor (HTTP interface via `@clickhouse/client`).
 * The SDK is loaded dynamically so the extractor builds without it installed.
 */

import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
} from './warehouse-client.js';
import { createSafeHttpAgent } from '../framework/core/ssrf.js';
import { MAX_STATEMENT_TIMEOUT_MS } from './warehouse-constants.js';

export interface ClickHouseSourceSslConfig {
  mode: 'disable' | 'require';
  caCert?: string;
}

export interface ClickHouseSourceConfig {
  host: string;
  port: number;
  database: string;
  auth: { type: 'password'; username: string; password: string };
  ssl?: ClickHouseSourceSslConfig;
  statementTimeoutMs?: number;
}

const BATCH_SIZE = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface ClickHouseRowLike {
  json<T = Record<string, unknown>>(): T;
}

interface ClickHouseResultSetLike {
  stream(): AsyncIterable<ClickHouseRowLike[]>;
}

interface ClickHouseClientLike {
  query(params: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
  }): Promise<ClickHouseResultSetLike>;
  close(): Promise<void>;
}

interface ClickHouseModuleLike {
  createClient(options: Record<string, unknown>): ClickHouseClientLike;
}

export class ClickHouseWarehouseClient implements WarehouseClient {
  readonly dialect = 'clickhouse' as const;
  private client: ClickHouseClientLike | null = null;
  private readonly config: ClickHouseSourceConfig;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseClickHouseConfig(rawConfig);
  }

  private async getClient(): Promise<ClickHouseClientLike> {
    if (this.client) return this.client;

    let mod: ClickHouseModuleLike;
    try {
      const moduleName = '@clickhouse/client';
      mod = (await import(/* webpackIgnore: true */ moduleName)) as ClickHouseModuleLike;
    } catch {
      throw new Error(
        '@clickhouse/client package is not installed. Add it to dependencies: pnpm add @clickhouse/client'
      );
    }

    const useTls = this.config.ssl !== undefined && this.config.ssl.mode !== 'disable';
    const options: Record<string, unknown> = {
      url: `${useTls ? 'https' : 'http'}://${this.config.host}:${this.config.port}`,
      database: this.config.database,
      username: this.config.auth.username,
      password: this.config.auth.password,
      request_timeout: REQUEST_TIMEOUT_MS,
      http_agent: createSafeHttpAgent(useTls, this.config.ssl?.caCert),
    };
    if (this.config.statementTimeoutMs !== undefined) {
      options['clickhouse_settings'] = {
        max_execution_time: Math.ceil(this.config.statementTimeoutMs / 1000),
      };
    }
    if (useTls && this.config.ssl?.caCert) {
      options['tls'] = { ca_cert: Buffer.from(this.config.ssl.caCert) };
    }

    this.client = mod.createClient(options);
    return this.client;
  }

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const client = await this.getClient();
    const resultSet = await client.query({
      query: sql,
      format: 'JSONEachRow',
      query_params: toNamedParams(params ?? []),
    });
    const maxRows = opts?.maxRows;
    let emitted = 0;
    let batch: Record<string, unknown>[] = [];

    outer: for await (const rows of resultSet.stream()) {
      for (const row of rows) {
        if (maxRows !== undefined && emitted + batch.length >= maxRows) break outer;
        batch.push(row.json<Record<string, unknown>>());
        if (batch.length >= BATCH_SIZE) {
          yield batch;
          emitted += batch.length;
          batch = [];
        }
      }
    }
    if (batch.length > 0) yield batch;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      for await (const _batch of this.execute('SELECT 1 AS connected')) {
        // Consume the first batch to force the request to complete.
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // ClickHouse has no schema level; accept schema for interface compatibility.
    const targetDb = schema || database || this.config.database;
    const sql =
      'SELECT table AS table_name, name AS column_name, type AS data_type, ' +
      'is_in_primary_key, comment FROM system.columns ' +
      'WHERE database = {p1:String} ORDER BY table, position';
    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql, [targetDb])) {
      for (const row of batch) {
        const tableName = String(row['table_name'] ?? '');
        let table = tables.get(tableName);
        if (!table) {
          table = { tableName, schema: targetDb, database: targetDb, columns: [] };
          tables.set(tableName, table);
        }

        const dataType = String(row['data_type'] ?? '');
        const column: ColumnDiscovery = {
          name: String(row['column_name'] ?? ''),
          sourceType: dataType,
          nullable: dataType.startsWith('Nullable('),
          // Sorting/primary-key membership is a useful key hint, not a uniqueness guarantee.
          isPrimaryKey: Number(row['is_in_primary_key']) === 1,
          ...(row['comment'] && String(row['comment']).length > 0
            ? { comment: String(row['comment']) }
            : {}),
        };
        table.columns.push(column);
      }
    }

    return Array.from(tables.values());
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

/** Convert positional params to the `{p<n>:String}` placeholders emitted by the query builder. */
function toNamedParams(params: unknown[]): Record<string, unknown> {
  return Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
}

function parseClickHouseConfig(raw: Record<string, unknown>): ClickHouseSourceConfig {
  const host = requireString(raw, 'host');
  const port = optionalNumber(raw, 'port') ?? 8123;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('ClickHouseConfig: "port" must be a positive integer <= 65535');
  }
  const database = requireString(raw, 'database');
  const authRaw = raw['auth'];
  if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
    throw new Error('ClickHouseConfig: "auth" must be an object');
  }
  const authObj = authRaw as Record<string, unknown>;
  if (requireString(authObj, 'type') !== 'password') {
    throw new Error('ClickHouseConfig: unsupported auth type (expected "password")');
  }
  const auth = {
    type: 'password' as const,
    username: requireString(authObj, 'username'),
    password: requireString(authObj, 'password'),
  };

  let ssl: ClickHouseSourceSslConfig | undefined;
  const sslRaw = raw['ssl'];
  if (sslRaw !== undefined && sslRaw !== null) {
    if (typeof sslRaw !== 'object' || Array.isArray(sslRaw)) {
      throw new Error('ClickHouseConfig: "ssl" must be an object');
    }
    const sslObj = sslRaw as Record<string, unknown>;
    const mode = requireString(sslObj, 'mode');
    if (mode !== 'disable' && mode !== 'require') {
      throw new Error(
        `ClickHouseConfig: unsupported ssl.mode "${mode}" (expected disable or require)`
      );
    }
    ssl = {
      mode,
      caCert: optionalString(sslObj, 'caCert') ?? optionalString(sslObj, 'ca_cert'),
    };
  }

  const statementTimeoutMs = optionalNumber(raw, 'statement_timeout_ms');
  if (statementTimeoutMs !== undefined) {
    if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
      throw new Error('ClickHouseConfig: "statement_timeout_ms" must be a positive integer');
    }
    if (statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
      throw new Error(
        `ClickHouseConfig: "statement_timeout_ms" must be <= ${MAX_STATEMENT_TIMEOUT_MS}`
      );
    }
  }

  return { host, port, database, auth, ssl, statementTimeoutMs };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ClickHouseConfig: "${key}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`ClickHouseConfig: "${key}" must be a string if provided`);
  }
  return value;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ClickHouseConfig: "${key}" must be a finite number if provided`);
  }
  return value;
}
