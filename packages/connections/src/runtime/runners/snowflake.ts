import { quoteWarehouseLiteral } from '@bobsled-inc/protocol';
/**
 * Built-in Snowflake runner.
 *
 * Auth variants: `pat`, `rsa_key`, `oauth`.
 * `sledhouse_oidc` is custom-only — no built-in runner ships for it.
 *
 * The driver (`snowflake-sdk`) is CJS-only, so we load it via `createRequire`.
 */

import * as dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { CommandError } from '@bobsled-inc/protocol';
import { Agent, fetch as undiciFetch } from 'undici';

import type { SnowflakeIntegration } from '../../schemas/integration.js';
import { runCancellable, SqlCancelledError, throwIfCancelled } from '../cancellation.js';
import {
  RefreshableTokenSource,
  isInvalidCredentialsError,
  type BigQueryAccessToken,
  type BigQueryTokenProvider,
} from '../refreshable-token.js';
import { assertDriverVersion } from '../driver-version.js';
import { validateQueryTag } from '../query-tag.js';
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
// Structural driver interface — compiles without `snowflake-sdk` installed
// ---------------------------------------------------------------------------

interface SnowflakeSdkStatement {
  getNumUpdatedRows?(): number | undefined;
  streamRows?(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
  /**
   * Asks the server to abort this statement — the only way to stop a Snowflake
   * warehouse mid-query. `RowStatement.cancel(callback?: StatementCallback): void`
   * — see `snowflake-sdk/dist/index.d.ts`. Optional here because the structural
   * type must keep compiling against older driver builds.
   */
  cancel?(callback?: (err: unknown) => void): void;
}

interface SnowflakeSdkConnection {
  connect(callback: (err: Error | undefined) => void): unknown;
  execute(options: {
    sqlText: string;
    binds?: Array<string | number | boolean | null>;
    complete: (
      err: Error | undefined,
      stmt: SnowflakeSdkStatement,
      rows?: Record<string, unknown>[]
    ) => void;
  }): SnowflakeSdkStatement;
  destroy(callback: (err: Error | undefined) => void): unknown;
}

interface SnowflakeSdkModule {
  createConnection(config: Record<string, unknown>): SnowflakeSdkConnection;
}

// ---------------------------------------------------------------------------
// OAuth token fetcher (mirrors packages/loader/src/runtime/oauth-token-fetcher.ts)
// ---------------------------------------------------------------------------

interface OAuthTokenResult {
  accessToken: string;
  /**
   * Unix timestamp (seconds) when the token expires. Optional — when absent the
   * runner assumes a conservative 1-hour TTL so the proactive refresh still
   * engages on long-running tasks.
   */
  expiresAt?: number;
}

type OAuthTokenFetcher = (opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}) => Promise<OAuthTokenResult>;

// ---------------------------------------------------------------------------
// Driver loader
// ---------------------------------------------------------------------------

function loadSnowflakeSdk(): SnowflakeSdkModule {
  const require = createRequire(import.meta.url);
  assertDriverVersion('snowflake-sdk', '3.4.0', require);
  try {
    return require('snowflake-sdk') as SnowflakeSdkModule;
  } catch (err) {
    throw new CommandError(
      'snowflake-sdk is required for the built-in Snowflake runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Promise wrappers
// ---------------------------------------------------------------------------

function connectAsync(raw: SnowflakeSdkConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    raw.connect((err) => (err ? reject(err) : resolve()));
  });
}

function cancelStatementAsync(statement: SnowflakeSdkStatement | undefined): Promise<void> {
  if (typeof statement?.cancel !== 'function') {
    return Promise.reject(
      new Error('The installed Snowflake driver does not expose RowStatement.cancel().')
    );
  }
  return new Promise<void>((resolve, reject) => {
    statement.cancel!((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function executeAsync(
  raw: SnowflakeSdkConnection,
  sqlText: string,
  options?: SqlExecOptions,
  binds?: Array<string | number | boolean | null>
): Promise<{ rows: Record<string, unknown>[]; affectedRows: number }> {
  return runCancellable(options?.signal, (register) => {
    let statement: SnowflakeSdkStatement | undefined;
    const settled = new Promise<{ rows: Record<string, unknown>[]; affectedRows: number }>(
      (resolve, reject) => {
        statement = raw.execute({
          sqlText,
          ...(binds === undefined ? {} : { binds }),
          complete: (err, stmt, rows) => {
            if (err) return reject(err);
            const fetched = rows ?? [];
            const affected =
              typeof stmt.getNumUpdatedRows === 'function'
                ? (stmt.getNumUpdatedRows() ?? fetched.length)
                : fetched.length;
            resolve({ rows: fetched, affectedRows: affected });
          },
        });
      }
    );
    // `execute()` hands back the statement SYNCHRONOUSLY (the result arrives
    // later via `complete`), so registration lands in the same tick the
    // statement was dispatched — no create-then-abort gap to worry about.
    register(() => cancelStatementAsync(statement));
    return settled;
  });
}

function destroyAsync(raw: SnowflakeSdkConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    raw.destroy((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Auth → driver config
// ---------------------------------------------------------------------------

async function resolveOAuthToken(
  auth: { client_id: string; client_secret: string; token_url: string },
  fetcher?: OAuthTokenFetcher
): Promise<BigQueryAccessToken> {
  const result = fetcher
    ? await fetcher({
        tokenUrl: auth.token_url,
        clientId: auth.client_id,
        clientSecret: auth.client_secret,
      })
    : await fetchOAuthTokenDefault(auth.token_url, auth.client_id, auth.client_secret);
  // Default to a conservative 1-hour horizon when the IdP omits expiry so the
  // proactive refresh still engages before the session token actually lapses.
  const expiresAt = result.expiresAt ?? Math.floor(Date.now() / 1000) + 3_600;
  return { accessToken: result.accessToken, expiresAt };
}

/**
 * SSRF guard for the OAuth token endpoint. The token URL is operator-supplied
 * YAML, which means a malicious or misconfigured value like
 * `https://169.254.169.254/...` (cloud metadata service) or
 * `https://internal-redis/...` would POST the OAuth client credentials to an
 * attacker-reachable internal endpoint. Mirror the extractor's approach
 * (`packages/extractor/src/framework/core/shared.ts:isPrivateHost`) without
 * importing across package boundaries. Operators that genuinely need an
 * internal token endpoint can set DOGSLED_ALLOW_PRIVATE_OAUTH_HOSTS=1.
 */
const CLOUD_METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
const ALWAYS_BLOCKED_IPV4 = new BlockList();
const ALWAYS_BLOCKED_IPV6 = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

ALWAYS_BLOCKED_IPV4.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED_IPV4.addAddress('100.100.100.200', 'ipv4');
ALWAYS_BLOCKED_IPV6.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED_IPV6.addAddress('fd00:ec2::254', 'ipv6');

export function isPrivateOauthHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, '');
  const bareHost = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  // Cloud-metadata service hostnames (GCP/Azure DNS-based); AWS is IP-based.
  if (CLOUD_METADATA_HOSTNAMES.has(bareHost)) return true;
  const family = isIP(bareHost);
  if (
    (family === 4 && ALWAYS_BLOCKED_IPV4.check(bareHost, 'ipv4')) ||
    (family === 6 && ALWAYS_BLOCKED_IPV6.check(bareHost, 'ipv6'))
  ) {
    return true;
  }
  if (process.env['DOGSLED_ALLOW_PRIVATE_OAUTH_HOSTS'] === '1') return false;
  if (bareHost === 'localhost') return true;
  if (family === 4) return NON_PUBLIC_IPV4.check(bareHost, 'ipv4');
  if (family === 6) return NON_PUBLIC_IPV6.check(bareHost, 'ipv6');
  return false;
}

const safeOAuthLookup: LookupFunction = (hostname, options, callback) => {
  void dns
    .lookup(hostname, { all: true, verbatim: true })
    .then((answers) => {
      for (const { address } of answers) {
        if (isPrivateOauthHost(address)) {
          throw new Error(
            `OAuth token hostname "${hostname}" resolves to private address ${address}.`
          );
        }
      }
      const requestedFamily =
        typeof options === 'object' && typeof options.family === 'number' ? options.family : 0;
      const compatible =
        requestedFamily === 4 || requestedFamily === 6
          ? answers.filter(({ family }) => family === requestedFamily)
          : answers;
      if (compatible.length === 0) {
        const error = new Error(
          `OAuth token hostname "${hostname}" has no address for family ${requestedFamily}.`
        ) as NodeJS.ErrnoException;
        error.code = 'ENOTFOUND';
        callback(error, '');
      } else if (typeof options === 'object' && options.all) {
        callback(null, compatible);
      } else {
        const selected = compatible[0]!;
        callback(null, selected.address, selected.family);
      }
    })
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)), '');
    });
};

const safeOAuthDispatcher = new Agent({ connect: { lookup: safeOAuthLookup } });
const originalGlobalFetch = globalThis.fetch;

export async function safeOAuthFetch(url: string, init: RequestInit): Promise<Response> {
  if (process.env['VITEST'] === 'true' && globalThis.fetch !== originalGlobalFetch) {
    return globalThis.fetch(url, init);
  }
  return (await undiciFetch(url, {
    ...init,
    dispatcher: safeOAuthDispatcher,
  } as never)) as unknown as Response;
}

/**
 * Minimal OAuth 2.0 client_credentials grant — mirrors the loader's
 * `oauth-token-fetcher.ts` without taking a dep on the loader package.
 */
async function fetchOAuthTokenDefault(
  tokenUrl: string,
  clientId: string,
  clientSecret: string
): Promise<OAuthTokenResult> {
  const url = new URL(tokenUrl);
  if (url.protocol !== 'https:') {
    throw new CommandError(
      `OAuth token URL must use https://; refusing to send credentials over cleartext to ${tokenUrl}`,
      1
    );
  }
  if (isPrivateOauthHost(url.hostname)) {
    throw new CommandError(
      `OAuth token URL points to a private/loopback host (${url.hostname}); refusing to send credentials. ` +
        `Set DOGSLED_ALLOW_PRIVATE_OAUTH_HOSTS=1 to override (e.g. internal IdP behind VPN).`,
      1
    );
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
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
    // AbortError from our own timeout is opaque; surface it as a clear,
    // actionable CommandError instead of leaking AbortError to the caller.
    // All other network/TLS/DNS errors are also normalized to CommandError so
    // operators get a consistent exit-code surface (not raw TypeError /
    // DOMException leaking from fetch).
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CommandError(`OAuth token request to ${tokenUrl} timed out after 30s.`, 1);
    }
    throw new CommandError(
      `OAuth token fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    const text = await response.text().catch(() => '');
    throw new CommandError(
      `OAuth token request failed with status ${response.status}: ${text || '<no body>'}`,
      1
    );
  }
  const parsed = (await response.json()) as { access_token?: string; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string') {
    throw new CommandError('OAuth token response is missing access_token', 1);
  }
  // `expires_in` is seconds-from-now per RFC 6749; convert to an absolute Unix
  // second so the proactive refresh can compare against a stable clock.
  const expiresAt =
    typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? Math.floor(Date.now() / 1000) + parsed.expires_in
      : undefined;
  return expiresAt === undefined
    ? { accessToken: parsed.access_token }
    : { accessToken: parsed.access_token, expiresAt };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * How long `streamQueryRows` waits for the SDK's `complete` callback to
 * settle after the row stream ends or the consumer breaks early. Caps the
 * deadlock window when a driver bug never invokes `complete()`. 30s is
 * the same budget the OAuth fetch uses.
 */
const STREAM_COMPLETE_DRAIN_MS = 30_000;

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

export interface BuildSnowflakeRunnerOptions {
  /** Override the OAuth token fetcher (for tests). */
  oauthTokenFetcher?: OAuthTokenFetcher;
  /** Override the SDK module (for tests). */
  sdk?: SnowflakeSdkModule;
  /**
   * Pipeline-resolved effective warehouse for this session. When set, it
   * overrides `connection.warehouse`. Threaded from the runner factory
   * context (`resolveRunner({ warehouse })`). One per run — warehouse
   * selection is pipeline-grained only.
   */
  warehouse?: string;
  /** Trusted per-run metadata applied as Snowflake's session `QUERY_TAG`. */
  queryTag?: string;
  /**
   * Refreshable managed-credential provider. When set, the session authenticates
   * with the short-lived OAuth token this returns and re-mints + reconnects
   * mid-run — proactively (within the skew window of `expiresAt`) and reactively
   * (on an auth-lapse error). Takes precedence over the integration's static
   * auth. Built from the same `credentials_token_command` command-string
   * contract the loader uses (not the loader's destination config field).
   */
  tokenProvider?: BigQueryTokenProvider;
  /** Clock override for the refresh skew window (tests). Unix seconds. */
  now?: () => number;
  /** Override the proactive-refresh skew (tests). Seconds before expiry. */
  skewSeconds?: number;
}

export interface SnowflakeRunnerModule extends SqlRunnerModule {
  streamQueryRows(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): AsyncIterable<SqlQueryRow>;
}

/**
 * Resolve a pipeline warehouse selector for Dogsled's built-in Snowflake runner.
 * Custom runners receive the stable selector unchanged through their factory
 * context; only the built-in adapter translates a declared ID to the physical
 * session warehouse.
 */
export function resolveSnowflakeWarehouseOverride(
  connection: SnowflakeIntegration['connection'],
  selector: string | undefined
): string | undefined {
  if (selector === undefined) return connection.warehouse;
  if (connection.warehouses === undefined) return selector;

  const warehouse = connection.warehouses[selector];
  if (warehouse !== undefined) return warehouse;
  throw new CommandError(
    `Snowflake warehouse selector "${selector}" must name a configured warehouses key. ` +
      `Available selectors: ${Object.keys(connection.warehouses).join(', ')}.`,
    2
  );
}

export async function buildSnowflakeRunner(
  integration: SnowflakeIntegration,
  options?: BuildSnowflakeRunnerOptions
): Promise<SnowflakeRunnerModule> {
  const sdk = options?.sdk ?? loadSnowflakeSdk();
  const { connection, auth } = integration;
  const queryTag = validateQueryTag(options?.queryTag);

  // Static (non-token) session config. Token-bearing fields are layered on at
  // connect time (see `buildConfig`) so a mid-run refresh can rebuild the
  // session with a fresh token without re-deriving the rest.
  const base: Record<string, unknown> = {
    account: connection.account_identifier,
    username: connection.user,
    // Pipeline-resolved session warehouse wins over the connection default.
    // This is the only warehouse seam — the dynamic-table DDL `WAREHOUSE`
    // clause (a separate concept) flows through `targetWarehouse` untouched.
    warehouse: resolveSnowflakeWarehouseOverride(connection, options?.warehouse),
    database: connection.database,
    schema: connection.schema,
    role: connection.role,
    ...(queryTag === undefined ? {} : { queryTag }),
    // Preserve precision/timezone/semi-structured fidelity by asking the driver
    // to return these types as strings. Without this, NUMBER columns lose
    // precision above 15 digits via IEEE-754, TIMESTAMP_TZ loses its offset
    // via JS Date coercion, and VARIANT comes back as a stringified-then-
    // reparsed object. Stringified values flow through the cross-warehouse
    // staging path unchanged and are CAST back to the appropriate destination
    // type on ingest.
    fetchAsString: ['Number', 'Date', 'JSON'],
  };

  // A managed `tokenProvider` (orchestrator-minted, short-lived) overrides the
  // integration's static auth. pat/rsa_key fields are only baked in when no
  // managed provider is supplied — those sessions have no token horizon.
  if (!options?.tokenProvider) {
    if (auth.type === 'pat') {
      Object.assign(base, { password: auth.token });
    } else if (auth.type === 'rsa_key') {
      Object.assign(base, {
        authenticator: 'SNOWFLAKE_JWT',
        privateKeyPath: auth.private_key_path,
        privateKeyPass: auth.private_key_passphrase,
      });
    }
  }

  // Source of the short-lived OAuth session token: managed provider wins, else
  // the integration's client_credentials grant. Undefined for pat/rsa_key — no
  // token horizon, so refresh stays a no-op and those paths are unchanged.
  const tokenProvider: BigQueryTokenProvider | undefined = options?.tokenProvider
    ? options.tokenProvider
    : auth.type === 'oauth'
      ? () =>
          resolveOAuthToken(
            {
              client_id: auth.client_id!,
              client_secret: auth.client_secret!,
              token_url: auth.token_url,
            },
            options?.oauthTokenFetcher
          )
      : undefined;

  const tokenSource = tokenProvider
    ? new RefreshableTokenSource(tokenProvider, {
        ...(options?.now ? { now: options.now } : {}),
        ...(options?.skewSeconds !== undefined ? { skewSeconds: options.skewSeconds } : {}),
      })
    : undefined;

  let currentToken: BigQueryAccessToken | undefined;

  function buildConfig(accessToken: string | undefined): Record<string, unknown> {
    return accessToken === undefined
      ? base
      : { ...base, authenticator: 'OAUTH', token: accessToken };
  }

  let raw: SnowflakeSdkConnection;
  if (tokenSource) {
    currentToken = await tokenSource.getAccessToken();
  }
  raw = sdk.createConnection(buildConfig(currentToken?.accessToken));
  await connectAsync(raw);

  // Re-mint a fresh token and swap in a new connection, destroying the old one.
  // The access token authenticates the session at connect time, so a refresh
  // requires a reconnect (there is no in-place token rotation in snowflake-sdk).
  async function reconnect(fresh: BigQueryAccessToken): Promise<void> {
    const previous = raw;
    const next = sdk.createConnection(buildConfig(fresh.accessToken));
    await connectAsync(next);
    raw = next;
    currentToken = fresh;
    try {
      await destroyAsync(previous);
    } catch {
      // best-effort — the replacement session is already live; a failed close on
      // the stale handle must not fail the task.
    }
  }

  // Proactive refresh: when within the skew window of the session token's
  // expiry, re-mint + reconnect before the next statement. No-op for
  // pat/rsa_key and while the token is comfortably valid.
  async function refreshConnectionIfNeeded(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    if (!tokenSource || !currentToken || !tokenSource.isExpiring(currentToken)) {
      return;
    }
    const token = await tokenSource.getAccessToken(true);
    throwIfCancelled(signal);
    await reconnect(token);
    throwIfCancelled(signal);
  }

  // Reactive backstop: a token can lapse between the skew check and the request
  // landing. On an auth-lapse error force a fresh token + reconnect and retry
  // the op exactly once. Transparent pass-through for non-token sessions.
  //
  // `retrySafe` gates the REACTIVE retry: a statement can apply side effects
  // before the client observes the auth/session error, so re-running it would
  // double them. Only read-only statements (`query` / `LIST`) opt in;
  // side-effecting `run` / `COPY INTO` rely on the proactive refresh that
  // already ran before the statement (same safety boundary the streaming path
  // documents). When `retrySafe` is false this is a plain pass-through.
  async function withAuthRetry<T>(
    op: () => Promise<T>,
    retrySafe: boolean,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfCancelled(signal);
    if (!tokenSource || !retrySafe) return op();
    try {
      return await op();
    } catch (error) {
      if (!isInvalidCredentialsError(error)) throw error;
      const token = await tokenSource.getAccessToken(true);
      throwIfCancelled(signal);
      await reconnect(token);
      throwIfCancelled(signal);
      return op();
    }
  }

  const run = async (sql: string, options?: SqlExecOptions): Promise<SqlRunResult> => {
    // Side-effecting (DDL/DML): proactive refresh only — never reactive-retry.
    await refreshConnectionIfNeeded(options?.signal);
    throwIfCancelled(options?.signal);
    const { affectedRows } = await executeAsync(raw, sql, options);
    if (typeof affectedRows === 'number' && Number.isFinite(affectedRows)) {
      return { rowCount: affectedRows };
    }
    return {};
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): Promise<TRow[]> => {
    const binds = positionalBindings(params);
    await refreshConnectionIfNeeded(options?.signal);
    return withAuthRetry(
      async () => {
        const { rows } = await executeAsync(raw, sql, options, binds);
        return rows as TRow[];
      },
      // Bound queries can contain writes; do not replay them after an auth error.
      binds === undefined,
      options?.signal
    );
  };

  const close = async (): Promise<void> => {
    await destroyAsync(raw);
  };

  const streamQueryRows = async function* (
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): AsyncIterable<SqlQueryRow> {
    const binds = positionalBindings(params);

    // Pre-flight guard: an already-aborted signal must not dispatch the
    // statement at all. The per-step `runCancellable` calls below can only guard
    // the awaits that happen once the cursor is already open.
    throwIfCancelled(options?.signal);

    // Proactive refresh only for the streaming path: re-mint + reconnect before
    // opening the cursor when the session token is within the skew window. A
    // reactive mid-stream reconnect would mean re-running the statement (double
    // billing / double side effects), so the skew window is the guard here —
    // long EG candidate-retrieval scans start on a freshly-refreshed session.
    await refreshConnectionIfNeeded(options?.signal);
    throwIfCancelled(options?.signal);

    // Capture rows from the SDK's `complete` callback so the fallback path can
    // yield them without executing the SQL a second time (which would double
    // billing and double any side effects for non-idempotent statements).
    let resolveRows: (rows: Record<string, unknown>[]) => void = () => {};
    let rejectRows: (error: Error) => void = () => {};
    const rowsPromise = new Promise<Record<string, unknown>[]>((resolve, reject) => {
      resolveRows = resolve;
      rejectRows = reject;
    });

    const statement = raw.execute({
      sqlText: sql,
      ...(binds === undefined ? {} : { binds }),
      complete: (err, _stmt, rows) => {
        if (err) {
          rejectRows(err);
          return;
        }
        resolveRows(rows ?? []);
      },
    });
    // Every await from here on runs under `runCancellable` with the same
    // statement-level canceller, so an abort while the consumer is waiting for
    // the next chunk asks Snowflake to abort the statement rather than merely
    // abandoning a socket that keeps the warehouse busy.
    const activeStream = { destroy: undefined as (() => void) | undefined };
    const cancelActiveStatement = async (): Promise<void> => {
      const acknowledgement = cancelStatementAsync(statement);
      // Some SDK versions acknowledge statement cancellation without
      // settling a stalled Node stream. Destroying the local stream is the
      // settlement half of the contract; without it the public cancellation
      // promise could wait forever after the server accepted the cancel.
      activeStream.destroy?.();
      await acknowledgement;
    };
    const step = async <T>(start: () => Promise<T>): Promise<T> => {
      if (options?.signal?.aborted) {
        // The statement handle outlives each individual stream await. If abort
        // lands between two awaits, `runCancellable`'s normal pre-flight guard
        // quite correctly refuses to START a new operation — but this statement
        // already exists, so cancel and settle one final driver read explicitly.
        const settlement = Promise.resolve().then(start);
        const results = await Promise.allSettled([settlement, cancelActiveStatement()]);
        const cancelFailure = results[1]?.status === 'rejected' ? results[1].reason : undefined;
        throw new SqlCancelledError('SQL execution cancelled between Snowflake stream reads.', {
          cause: cancelFailure ?? options.signal.reason,
        });
      }
      return runCancellable(options?.signal, (register) => {
        register(cancelActiveStatement);
        return start();
      });
    };

    if (typeof statement.streamRows !== 'function') {
      const rows = await step(() => rowsPromise);
      for (const row of rows) yield row;
      return;
    }

    // The streamRows() output is the primary data channel; the `complete`
    // callback signals statement-level errors that surface AFTER the stream
    // ends cleanly (Snowflake auth lapse mid-statement can flush a partial
    // result and then call complete(err)). Capture the callback rejection so
    // we can re-raise it once stream iteration completes — without this the
    // consumer sees a clean EOF and silently underreports rows.
    let callbackError: Error | undefined;
    const observed = rowsPromise.then(
      () => undefined,
      (err: unknown) => {
        callbackError = err instanceof Error ? err : new Error(String(err));
        return undefined;
      }
    );
    const stream = statement.streamRows();
    const destroyableStream = stream as NodeJS.ReadableStream & {
      destroyed?: boolean;
      destroy?: (error?: Error) => void;
    };
    activeStream.destroy = () => {
      if (destroyableStream.destroyed !== true) {
        destroyableStream.destroy?.(new Error('Snowflake row stream cancelled.'));
      }
    };
    // Driven as an explicit iterator rather than `for await` so each advance can
    // be raced against the abort signal — a `for await` await is not
    // interruptible, so a cancel during a long fetch would otherwise not land
    // until the next row happened to arrive.
    const iterator = (stream as AsyncIterable<SqlQueryRow>)[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      for (;;) {
        const next = await step(() => iterator.next());
        if (next.done === true) {
          exhausted = true;
          break;
        }
        yield next.value;
      }
    } finally {
      // If iteration ended early (deadline trigger, cancellation, upstream
      // error, generator return), destroy the source stream so the
      // SDK stops buffering rows we'll never read — without this the unread
      // result set leaks until the underlying socket closes.
      if (!exhausted) {
        try {
          destroyableStream.destroy?.();
        } catch {
          // best-effort — about to throw the original break reason anyway
        }
      }
      // Drain the observation so the callback has fully settled before we
      // return; `observed` never rejects (we mapped the rejection into
      // `callbackError`). Cap the wait so a hung driver (complete() never
      // fires) can't deadlock the consumer.
      await Promise.race([
        observed,
        new Promise<void>((resolve) => setTimeout(resolve, STREAM_COMPLETE_DRAIN_MS).unref?.()),
      ]);
    }
    if (callbackError) throw callbackError;
  };

  const unload = async (
    sql: string,
    targetUri: string,
    opts: UnloadOptions
  ): Promise<UnloadResult> => {
    if (opts.format !== 'parquet') {
      throw new CommandError(
        `Snowflake unload supports only parquet format, got ${opts.format}.`,
        2
      );
    }
    await refreshConnectionIfNeeded();
    const escapedUri = quoteWarehouseLiteral(targetUri);
    const exec = opts.signal ? { signal: opts.signal } : undefined;
    // COPY INTO unloads files (side effect) — proactive refresh only, no reactive
    // retry. LIST is read-only, so it may reactive-retry.
    const copyResult = await executeAsync(
      raw,
      `COPY INTO ${escapedUri} FROM (${sql}) FILE_FORMAT = (TYPE = PARQUET) HEADER = TRUE OVERWRITE = TRUE`,
      exec
    );
    const listResult = await withAuthRetry(
      () => executeAsync(raw, `LIST ${escapedUri}`, exec),
      true,
      opts.signal
    );
    const listedUris = listResult.rows
      .map((row) => row['name'] ?? row['NAME'])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const rowCount = copyResult.rows.reduce(
      (sum, row) => sum + rowNumber(row, ['rows_unloaded', 'ROWS_UNLOADED', 'row_count']),
      0
    );
    const bytes = copyResult.rows.reduce(
      (sum, row) => sum + rowNumber(row, ['bytes_unloaded', 'BYTES_UNLOADED', 'bytes']),
      0
    );
    return {
      uris: listedUris.length > 0 ? listedUris : [targetUri],
      rowCount,
      ...(bytes > 0 ? { bytes } : {}),
    };
  };

  return { run, query, streamQueryRows, unload, supportsBindings: true, close };
}
