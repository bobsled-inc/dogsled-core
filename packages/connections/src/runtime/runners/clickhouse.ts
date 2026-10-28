/**
 * Built-in ClickHouse runner.
 *
 * Auth variants: `password`.
 *
 * Speaks the HTTP interface through `@clickhouse/client` (8123 plain, 8443 for
 * TLS / ClickHouse Cloud). The driver is a pure-JS HTTP client, so there is no
 * native binding to build, and it is imported dynamically so this module
 * compiles and loads without the optional peer installed.
 */

import { randomUUID } from 'node:crypto';

import { CommandError } from '@bobsled-inc/protocol';

import type { ClickHouseIntegration } from '../../schemas/integration.js';
import { runCancellable } from '../cancellation.js';
import type { SqlExecOptions, SqlParams, SqlRunnerModule, SqlRunResult } from '../types.js';

// ---------------------------------------------------------------------------
// Structural driver interface — compiles without `@clickhouse/client` installed
// ---------------------------------------------------------------------------

interface ClickHouseQueryParams {
  query: string;
  format?: string;
  query_id?: string;
  query_params?: Record<string, unknown>;
  abort_signal?: AbortSignal;
  clickhouse_settings?: Record<string, unknown>;
}

interface ClickHouseResultSet {
  json<TRow>(): Promise<TRow[]>;
}

interface ClickHouseClientLike {
  query(params: ClickHouseQueryParams): Promise<ClickHouseResultSet>;
  command(params: ClickHouseQueryParams): Promise<{ query_id?: string }>;
  close(): Promise<void>;
}

interface ClickHouseModule {
  createClient(config: Record<string, unknown>): ClickHouseClientLike;
}

// ---------------------------------------------------------------------------
// Driver loader
// ---------------------------------------------------------------------------

async function loadClickHouse(): Promise<ClickHouseModule> {
  try {
    return (await import('@clickhouse/client')) as unknown as ClickHouseModule;
  } catch (err) {
    throw new CommandError(
      '@clickhouse/client is required for the built-in ClickHouse runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * ClickHouse binds by NAME (`{p1:String}`), not by ordinal, so a positional
 * array is mapped onto `p1..pN` — the same convention the extractor's query
 * builder emits. A record is passed through unchanged so callers that already
 * name their placeholders keep those names.
 */
function toQueryParams(params: SqlParams | undefined): Record<string, unknown> | undefined {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) {
    return Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
  }
  return { ...(params as Readonly<Record<string, unknown>>) };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildClickHouseRunnerOptions {
  /** Override the ClickHouse client instance (for tests). */
  client?: ClickHouseClientLike;
}

/**
 * A ClickHouse Cloud service that has scaled to zero has to wake before it
 * answers, which the driver's 30s default request timeout can easily outlast on
 * a first connection. 60s covers a cold start without hanging a caller.
 */
const COLD_START_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The client aborts the HTTP request after `request_timeout` regardless of what
 * the server was told, so a statement timeout longer than it would never be
 * reached — the query would die client-side first. Keep the request window at
 * least as long as the statement is allowed to run, plus headroom for the
 * round trip.
 */
function requestTimeoutMs(statementTimeoutMs: number | undefined): number {
  if (statementTimeoutMs === undefined) return COLD_START_REQUEST_TIMEOUT_MS;
  return Math.max(COLD_START_REQUEST_TIMEOUT_MS, statementTimeoutMs + 10_000);
}

/**
 * Translate a validated integration into `createClient` options.
 *
 * Exported so the transport decisions it encodes — scheme selection, the
 * seconds-granularity timeout, the passwordless default — are testable without
 * a live server or the optional driver installed.
 */
export function buildClickHouseClientConfig(
  integration: ClickHouseIntegration
): Record<string, unknown> {
  const { connection, auth } = integration;
  // TLS unless explicitly disabled. ClickHouse Cloud is HTTPS-only, so a
  // forgotten `ssl` block should still reach it rather than silently
  // attempting plain HTTP and sending credentials in the clear.
  const useTls = connection.ssl?.mode !== 'disable';
  // One setting to get right instead of two: Cloud terminates TLS on 8443 and
  // a plain server listens on 8123, so the port follows the scheme unless the
  // connection names one.
  const port = connection.port ?? (useTls ? 8443 : 8123);
  const config: Record<string, unknown> = {
    url: `${useTls ? 'https' : 'http'}://${connection.host!}:${port}`,
    database: connection.database,
    username: auth.user!,
    // ClickHouse permits a passwordless user; the driver expects a string.
    password: auth.password ?? '',
    request_timeout: requestTimeoutMs(connection.statement_timeout_ms),
  };

  if (connection.statement_timeout_ms !== undefined) {
    // max_execution_time is expressed in seconds, so a sub-second timeout
    // rounds up rather than truncating to "no limit".
    config['clickhouse_settings'] = {
      max_execution_time: Math.ceil(connection.statement_timeout_ms / 1000),
    };
  }
  if (useTls && connection.ssl?.ca_cert) {
    config['tls'] = { ca_cert: Buffer.from(connection.ssl.ca_cert) };
  }

  return config;
}

export async function buildClickHouseRunner(
  integration: ClickHouseIntegration,
  options?: BuildClickHouseRunnerOptions
): Promise<SqlRunnerModule> {
  let client: ClickHouseClientLike;

  if (options?.client) {
    client = options.client;
  } else {
    const mod = await loadClickHouse();
    client = mod.createClient(buildClickHouseClientConfig(integration));
  }

  /**
   * Stop a statement that is already in flight.
   *
   * Aborting the HTTP request alone is not sufficient: ClickHouse only reliably
   * abandons work on client disconnect for readonly queries, so an interrupted
   * write could otherwise keep running on the server after the caller has given
   * up. `KILL QUERY` travels on a separate request and addresses the statement
   * by the `query_id` minted below, which makes cancellation explicit.
   */
  const killQuery = async (queryId: string): Promise<void> => {
    await client.command({
      query: 'KILL QUERY WHERE query_id = {kill_target:String} ASYNC',
      query_params: { kill_target: queryId },
    });
  };

  const run = async (sql: string, execOptions?: SqlExecOptions): Promise<SqlRunResult> => {
    const queryId = randomUUID();
    await runCancellable(execOptions?.signal, (register) => {
      register(() => killQuery(queryId));
      return client.command({
        query: sql,
        query_id: queryId,
        abort_signal: execOptions?.signal,
      });
    });
    // The HTTP interface reports no affected-row count for DDL/DML, so the
    // optional `rowCount` is deliberately omitted rather than guessed.
    return {};
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    execOptions?: SqlExecOptions
  ): Promise<TRow[]> => {
    const queryId = randomUUID();
    const queryParams = toQueryParams(params);
    const resultSet = await runCancellable(execOptions?.signal, (register) => {
      register(() => killQuery(queryId));
      return client.query({
        query: sql,
        format: 'JSONEachRow',
        query_id: queryId,
        ...(queryParams ? { query_params: queryParams } : {}),
        abort_signal: execOptions?.signal,
      });
    });
    return resultSet.json<TRow>();
  };

  const close = async (): Promise<void> => {
    await client.close();
  };

  return { run, query, supportsBindings: true, close };
}
