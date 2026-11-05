import { quoteWarehouseLiteral, quoteWarehouseIdentifier } from '@bobsled-inc/protocol';
import { assertDriverVersion } from '../driver-version.js';
import { createRequire } from 'node:module';
/**
 * Built-in Databricks runner.
 *
 * Auth variants: `pat`, `oauth_m2m`.
 *
 * The driver (`@databricks/sql`) supports ESM dynamic import.
 */

import { CommandError } from '@bobsled-inc/protocol';

import type { DatabricksIntegration } from '../../schemas/integration.js';
import { isPrivateOauthHost, safeOAuthFetch } from './snowflake.js';
import { runCancellable, SqlCancelledError } from '../cancellation.js';
import type {
  SqlExecOptions,
  SqlParams,
  SqlQueryRow,
  SqlRunnerModule,
  SqlRunResult,
  UnloadOptions,
  UnloadResult,
} from '../types.js';

import { positionalBindings } from '../positional-bindings.js';

// ---------------------------------------------------------------------------
// Structural driver interface — compiles without @databricks/sql installed
// ---------------------------------------------------------------------------

interface DatabricksOperationLike {
  fetchAll(): Promise<Record<string, unknown>[]>;
  hasMoreRows?(): Promise<boolean>;
  fetchChunk?(opts: { maxRows: number }): Promise<Record<string, unknown>[]>;
  /**
   * Asks the warehouse to abort this operation — this is what stops the cluster
   * working after the caller aborts. `IOperation.cancel(): Promise<Status>` — see
   * `@databricks/sql/dist/contracts/IOperation.d.ts`. Optional here because the
   * structural type must keep compiling against older driver builds.
   */
  cancel?(): Promise<unknown>;
  close(): Promise<void>;
}

async function cancelDatabricksOperation(operation: DatabricksOperationLike): Promise<void> {
  if (typeof operation.cancel !== 'function') {
    throw new Error('The installed Databricks driver does not expose IOperation.cancel().');
  }
  await operation.cancel();
}

interface DatabricksSessionLike {
  executeStatement(
    sql: string,
    options?: { ordinalParameters: Array<string | number | boolean | null> }
  ): Promise<DatabricksOperationLike>;
  close(): Promise<void>;
}

interface DatabricksConnectionLike {
  openSession(): Promise<DatabricksSessionLike>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Driver loader
// ---------------------------------------------------------------------------

async function loadDatabricksClient(
  host: string,
  httpPath: string,
  token: string
): Promise<DatabricksConnectionLike> {
  assertDriverVersion('@databricks/sql', '2.0.0', createRequire(import.meta.url));
  try {
    const { DBSQLClient } = await import('@databricks/sql');
    const client = new DBSQLClient();
    const connection = await (
      client as unknown as {
        connect(opts: {
          host: string;
          path: string;
          token: string;
        }): Promise<DatabricksConnectionLike>;
      }
    ).connect({ host, path: httpPath, token });
    return connection as unknown as DatabricksConnectionLike;
  } catch (err) {
    throw new CommandError(
      '@databricks/sql is required for the built-in Databricks runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// OAuth M2M token fetcher
// ---------------------------------------------------------------------------

export async function fetchDatabricksOAuthToken(
  host: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  // Databricks OAuth M2M uses the workspace's built-in OAuth endpoint. Construct
  // the URL from a parsed hostname rather than string interpolation so a YAML
  // value like `evil.example.com#@victim.cloud.databricks.com` cannot redirect
  // the credential POST to an attacker-controlled origin.
  const tokenUrl = buildDatabricksTokenUrl(host);
  const tokenHostname = new URL(tokenUrl).hostname;
  if (isPrivateOauthHost(tokenHostname)) {
    throw new CommandError(
      `Databricks OAuth token URL resolves to a private/loopback host (${tokenHostname}); refusing to send credentials.`,
      1
    );
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'all-apis',
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await safeOAuthFetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CommandError(
        `Databricks OAuth token request to ${tokenUrl} timed out after 30s.`,
        1
      );
    }
    // Normalize all other network/TLS/DNS errors to CommandError so operators
    // get a consistent exit-code surface (not raw TypeError / DOMException).
    throw new CommandError(
      `Databricks OAuth token fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new CommandError(
      `Databricks OAuth token request failed with status ${response.status}.`,
      1
    );
  }
  const parsed = (await readDatabricksTokenResponse(response)) as { access_token?: string };
  if (typeof parsed.access_token !== 'string') {
    throw new CommandError('Databricks OAuth token response is missing access_token', 1);
  }
  return parsed.access_token;
}

const MAX_DATABRICKS_TOKEN_RESPONSE_BYTES = 1024 * 1024;

async function readDatabricksTokenResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isSafeInteger(declaredLength) &&
    declaredLength > MAX_DATABRICKS_TOKEN_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new CommandError('Databricks OAuth token response exceeds the 1 MiB limit.', 1);
  }
  if (!response.body) {
    throw new CommandError('Databricks OAuth token response is empty.', 1);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DATABRICKS_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CommandError('Databricks OAuth token response exceeds the 1 MiB limit.', 1);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CommandError('Databricks OAuth token response is not valid JSON.', 1);
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildDatabricksRunnerOptions {
  /** Override the Databricks connection (for tests). */
  connection?: DatabricksConnectionLike;
  /** Override the OAuth token fetcher (for tests). */
  oauthTokenFetcher?: (host: string, clientId: string, clientSecret: string) => Promise<string>;
  /** Server-side limit for each statement in this session. */
  statementTimeoutMs?: number | undefined;
}

export interface DatabricksRunnerModule extends SqlRunnerModule {
  streamQueryRows(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): AsyncIterable<SqlQueryRow>;
}

export function buildDatabricksTokenUrl(host: string): string {
  if (host.length === 0) {
    throw new CommandError('Databricks workspace host is empty; cannot be parsed.', 2);
  }
  // Reject any value containing characters that change the URL's authority
  // (`@`, `?`, `#`, `/`, `\`, whitespace, control). A bare ip:port host is
  // allowed only if it parses with no userinfo and no path.
  if (/[@?#/\\\s\x00-\x1f]/.test(host)) {
    throw new CommandError(
      `Databricks workspace host "${host}" contains illegal characters; must be a bare hostname.`,
      2
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/oidc/v1/token`);
  } catch {
    throw new CommandError(
      `Databricks workspace host "${host}" cannot be parsed as an HTTPS URL.`,
      2
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === ''
  ) {
    throw new CommandError(
      `Databricks workspace host "${host}" must be a bare HTTPS hostname with no userinfo.`,
      2
    );
  }
  return parsed.toString();
}

function sanitizeDatabricksHost(rawWorkspaceUrl: string): string {
  const stripped = rawWorkspaceUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Force a parse to surface obvious junk early; reuse the token-URL guards.
  buildDatabricksTokenUrl(stripped);
  return stripped;
}

function quoteDatabricksString(value: string): string {
  return quoteWarehouseLiteral(value);
}

function rowNumber(row: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

export async function buildDatabricksRunner(
  integration: DatabricksIntegration,
  options?: BuildDatabricksRunnerOptions
): Promise<DatabricksRunnerModule> {
  const { connection: connConfig, auth } = integration;
  if (!connConfig.workspace_url) {
    throw new CommandError('Databricks integration is missing connection.workspace_url.', 2);
  }
  if (!connConfig.http_path) {
    throw new CommandError('Databricks integration is missing connection.http_path.', 2);
  }
  const host = sanitizeDatabricksHost(connConfig.workspace_url);
  const httpPath = connConfig.http_path;

  let dbConnection: DatabricksConnectionLike;

  if (options?.connection) {
    dbConnection = options.connection;
  } else {
    let token: string;
    if (auth.type === 'pat') {
      token = auth.token!;
    } else {
      // oauth_m2m
      const fetcher = options?.oauthTokenFetcher ?? fetchDatabricksOAuthToken;
      token = await fetcher(host, auth.client_id!, auth.client_secret!);
    }
    dbConnection = await loadDatabricksClient(host, httpPath, token);
  }

  const session = await dbConnection.openSession();

  // Set catalog and schema if configured
  if (connConfig.catalog) {
    const op = await session.executeStatement(
      `USE CATALOG ${quoteWarehouseIdentifier(connConfig.catalog, 'databricks')}`
    );
    await op.close();
  }
  if (connConfig.schema) {
    const op = await session.executeStatement(
      `USE SCHEMA ${quoteWarehouseIdentifier(connConfig.schema, 'databricks')}`
    );
    await op.close();
  }

  if (options?.statementTimeoutMs !== undefined) {
    const seconds = Math.ceil(options.statementTimeoutMs / 1000);
    const op = await session.executeStatement(`SET STATEMENT_TIMEOUT = ${seconds}`);
    await op.close();
  }

  // `executeStatement` resolves to the operation, and the operation is the only
  // cancellable handle — so the canceller can only be registered once the
  // statement has been submitted. Creation and the result fetch therefore share
  // ONE `runCancellable` scope: `register` fires the canceller immediately when
  // the signal has already aborted, closing the create-then-abort race (abort
  // landing between the pre-flight guard and the operation existing).
  const run = async (sql: string, options?: SqlExecOptions): Promise<SqlRunResult> => {
    return runCancellable(options?.signal, async (register) => {
      const operation = await session.executeStatement(sql);
      register(() => cancelDatabricksOperation(operation));
      try {
        const rows = await operation.fetchAll();
        // Databricks doesn't reliably expose affected row counts;
        // return the fetched row count as a best-effort approximation.
        return { rowCount: rows.length };
      } finally {
        await operation.close();
      }
    });
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): Promise<TRow[]> => {
    const binds = positionalBindings(params);
    return runCancellable(options?.signal, async (register) => {
      const operation = await (binds === undefined
        ? session.executeStatement(sql)
        : session.executeStatement(sql, { ordinalParameters: binds }));
      register(() => cancelDatabricksOperation(operation));
      try {
        const rows = await operation.fetchAll();
        return rows as TRow[];
      } finally {
        await operation.close();
      }
    });
  };

  const close = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await session.close();
    } catch (err) {
      errors.push(err);
    }
    try {
      await dbConnection.close();
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  };

  const streamQueryRows = async function* (
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): AsyncIterable<SqlQueryRow> {
    const binds = positionalBindings(params);
    const operation = await runCancellable(options?.signal, async (register) => {
      const created = await (binds === undefined
        ? session.executeStatement(sql)
        : session.executeStatement(sql, { ordinalParameters: binds }));
      register(async () => {
        try {
          await cancelDatabricksOperation(created);
        } catch (error) {
          await created.close().catch(() => undefined);
          throw error;
        }
      });
      return created;
    });
    // Each chunk fetch is raced against the abort signal under the same
    // operation-level canceller, so an abort while the consumer waits on the
    // next chunk aborts the warehouse operation instead of leaving it running.
    const cancelOperation = async (): Promise<void> => {
      await cancelDatabricksOperation(operation);
    };
    const step = async <T>(start: () => Promise<T>): Promise<T> => {
      if (options?.signal?.aborted) {
        // The abort landed between reads, so there is no read promise to
        // settle. Cancel the existing operation without starting another
        // hasMoreRows()/fetchChunk() call whose result would be discarded.
        const [cancelResult] = await Promise.allSettled([cancelOperation()]);
        const cancelFailure = cancelResult?.status === 'rejected' ? cancelResult.reason : undefined;
        throw new SqlCancelledError('SQL execution cancelled between Databricks stream reads.', {
          cause: cancelFailure ?? options.signal.reason,
        });
      }
      return runCancellable(options?.signal, (register) => {
        register(async () => {
          await cancelOperation();
        });
        return start();
      });
    };
    try {
      // Captured as consts so the `typeof` narrowing survives into the `step`
      // closures below.
      const hasMoreRows = operation.hasMoreRows;
      const fetchChunk = operation.fetchChunk;
      if (typeof hasMoreRows !== 'function' || typeof fetchChunk !== 'function') {
        const rows = await step(() => operation.fetchAll());
        for (const row of rows) yield row;
        return;
      }

      while (await step(() => hasMoreRows.call(operation))) {
        const chunk = await step(() => fetchChunk.call(operation, { maxRows: 10_000 }));
        for (const row of chunk) yield row;
      }
    } finally {
      await operation.close();
    }
  };

  const unload = async (
    sql: string,
    targetUri: string,
    opts: UnloadOptions
  ): Promise<UnloadResult> => {
    if (opts.format !== 'parquet') {
      throw new CommandError(
        `Databricks unload supports only parquet format, got ${opts.format}.`,
        2
      );
    }
    const exportSql = `INSERT OVERWRITE DIRECTORY ${quoteDatabricksString(targetUri)} USING PARQUET ${sql}`;
    // Preserve the original call arity on the no-signal path — consumers and
    // tests assert call shape.
    const rows = opts.signal
      ? await query(exportSql, undefined, { signal: opts.signal })
      : await query(exportSql);
    const rowCount = rows.reduce(
      (sum, row) => sum + rowNumber(row, ['rows_written', 'num_rows', 'row_count']),
      0
    );
    const bytes = rows.reduce(
      (sum, row) => sum + rowNumber(row, ['bytes_written', 'num_output_bytes', 'bytes']),
      0
    );
    return {
      uris: [targetUri],
      rowCount,
      ...(bytes > 0 ? { bytes } : {}),
    };
  };

  return { run, query, streamQueryRows, unload, supportsBindings: true, close };
}
