import { assertDriverVersion } from '../driver-version.js';
import { createRequire } from 'node:module';
/**
 * Built-in BigQuery runner.
 *
 * Auth variants: `adc`, `wif`, `service_account`.
 *
 * The driver (`@google-cloud/bigquery`) supports ESM dynamic import.
 */

import { CommandError } from '@bobsled-inc/protocol';

import type { BigQueryIntegration } from '../../schemas/integration.js';
import { runCancellable, throwIfCancelled } from '../cancellation.js';
import {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  isInvalidCredentialsError,
  type BigQueryTokenProvider,
} from '../refreshable-token.js';
import type {
  SqlExecOptions,
  SqlParams,
  SqlRunnerModule,
  SqlRunResult,
  UnloadOptions,
  UnloadResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Structural driver interface — compiles without @google-cloud/bigquery
// ---------------------------------------------------------------------------

interface BigQueryJobLike {
  getQueryResults(): Promise<[Record<string, unknown>[], ...unknown[]]>;
  /**
   * Requests server-side cancellation of the running job — this is what stops
   * BigQuery burning slots after the caller aborts. `Job.cancel(): Promise<CancelResponse>`
   * — see `@google-cloud/bigquery/build/src/job.d.ts`. Optional here because the
   * structural type must keep compiling against older driver builds.
   */
  cancel?(): Promise<unknown>;
  metadata?: {
    statistics?: { query?: { numDmlAffectedRows?: string; totalBytesProcessed?: string } };
  };
}

async function cancelBigQueryJob(job: BigQueryJobLike): Promise<void> {
  if (typeof job.cancel !== 'function') {
    throw new Error('The installed BigQuery driver does not expose Job.cancel().');
  }
  await job.cancel();
}

interface BigQueryClientLike {
  createQueryJob(options: {
    query: string;
    location?: string;
    jobTimeoutMs?: number;
    params?: SqlParams;
    parameterMode?: 'positional' | 'named';
    dryRun?: boolean;
    useQueryCache?: boolean;
  }): Promise<[BigQueryJobLike, ...unknown[]]>;
}

// ---------------------------------------------------------------------------
// Driver loader
// ---------------------------------------------------------------------------

async function loadBigQuery(
  projectId: string | undefined,
  location: string | undefined,
  credentials: Record<string, unknown> | undefined,
  keyFilename: string | undefined,
  authClient: unknown | undefined
): Promise<BigQueryClientLike> {
  assertDriverVersion('@google-cloud/bigquery', '8.1.1', createRequire(import.meta.url));
  try {
    const mod = await import('@google-cloud/bigquery');
    return new mod.BigQuery({
      projectId,
      location,
      // Preserve INT64 precision above 2^53 by surfacing as string. Without
      // this the driver coerces to JS number and silently truncates. The
      // cross-warehouse staging path forwards the raw string to the
      // destination CAST. NUMERIC/BIGNUMERIC come through as Big.js
      // instances by default; downstream consumers should detect and
      // serialize via .toString() rather than recursing as a plain object.
      wrapIntegers: { integerTypeCastFunction: (v: unknown) => String(v) },
      // Auth precedence: refreshable `authClient` (managed token) > static
      // service-account `credentials` > `keyFilename` > ADC/WIF. The
      // refreshable client re-mints the token per request, so it must win.
      ...(authClient
        ? { authClient }
        : credentials
          ? { credentials }
          : keyFilename
            ? { keyFilename }
            : {}),
    } as Record<string, unknown>) as BigQueryClientLike;
  } catch (err) {
    throw new CommandError(
      '@google-cloud/bigquery is required for the built-in BigQuery runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildBigQueryRunnerOptions {
  /** Override the BigQuery client (for tests). */
  client?: BigQueryClientLike;
  /**
   * Refreshable managed-credential provider. When set, the runner authenticates
   * with a custom google-auth `AuthClient` (built over a
   * {@link RefreshableTokenSource}) that re-mints the orchestrator's short-lived
   * token proactively (5-min skew before expiry, per request) and reactively
   * (force-refresh + single retry on a 401). Takes precedence over the
   * integration's static credentials. Absent a provider, behaviour is unchanged.
   */
  tokenProvider?: BigQueryTokenProvider;
  /** Clock override for the refresh skew window (tests). Unix seconds. */
  now?: () => number;
  /** Override the proactive-refresh skew (tests). Seconds before expiry. */
  skewSeconds?: number;
  /** Server-side limit for each job this runner submits. BigQuery has no session setting. */
  statementTimeoutMs?: number | undefined;
  /**
   * Override the BigQuery client constructor (tests). Receives the refreshable
   * `authClient` the runner built from `tokenProvider`, so a test can observe
   * that the proactively-refreshing credential is actually wired into client
   * construction (the real SDK consults it per request via `getRequestHeaders`).
   */
  loadClient?: typeof loadBigQuery;
}

function escapeBigQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function unloadUriPattern(targetUri: string): string {
  if (targetUri.includes('*') || targetUri.endsWith('.parquet')) return targetUri;
  return `${targetUri.replace(/\/+$/, '')}/*.parquet`;
}

export async function buildBigQueryRunner(
  integration: BigQueryIntegration,
  options?: BuildBigQueryRunnerOptions
): Promise<SqlRunnerModule> {
  const { connection, auth } = integration;
  const projectId = connection.project_id ?? connection.project_ids?.[0];
  const location = connection.default_location ?? connection.location;

  let credentials: Record<string, unknown> | undefined;
  let keyFilename: string | undefined;

  if (auth.type === 'service_account' && auth.credentials) {
    // credentials can be a JSON string (parsed) or a file path
    try {
      credentials = JSON.parse(auth.credentials) as Record<string, unknown>;
    } catch {
      // Not valid JSON — treat as a file path
      keyFilename = auth.credentials;
    }
  } else if (auth.type === 'wif' && auth.service_account_email) {
    // WIF uses ADC with impersonation — no explicit credentials needed,
    // but the service_account_email is used for impersonation context.
    // The Google SDK picks up WIF config from environment automatically.
  }
  // auth.type === 'adc' — no credentials needed, SDK uses ADC

  // Refreshable managed credentials: wrap the provider in a custom google-auth
  // AuthClient that re-mints proactively (per request) and is force-refreshed
  // reactively by `authRetry` below on a 401. Built once and shared by the
  // single BigQuery client for the run's lifetime.
  const tokenSource = options?.tokenProvider
    ? new RefreshableTokenSource(options.tokenProvider, {
        ...(options.now ? { now: options.now } : {}),
        ...(options.skewSeconds !== undefined ? { skewSeconds: options.skewSeconds } : {}),
      })
    : undefined;
  let authClient: unknown;
  if (tokenSource) {
    const { OAuth2Client } = await import('google-auth-library');
    authClient = createRefreshableAuthClient({ tokenSource, OAuth2Client });
  }

  const jobLimit =
    options?.statementTimeoutMs === undefined
      ? {}
      : { jobTimeoutMs: Math.ceil(options.statementTimeoutMs) };

  const loadClient = options?.loadClient ?? loadBigQuery;
  const client =
    options?.client ??
    (await loadClient(projectId, location, credentials, keyFilename, authClient));

  /**
   * Reactive auth backstop: if an operation fails with a 401 / "Invalid
   * Credentials" and a refreshable token source is configured, force a token
   * refresh and retry the operation exactly once. Transparent pass-through when
   * no token source is set (static SA-key / ADC / WIF paths unchanged).
   * Proactive refresh (the main fix) happens inside the AuthClient's per-request
   * `getRequestHeaders()`; this covers the narrow window where a token expires
   * between the skew check and the request landing.
   */
  const authRetry = async <T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    throwIfCancelled(signal);
    if (!tokenSource) return op();
    try {
      return await op();
    } catch (error) {
      if (!isInvalidCredentialsError(error)) throw error;
      await tokenSource.getToken(true);
      throwIfCancelled(signal);
      return op();
    }
  };

  // Job CREATION and result POLLING are wrapped in `authRetry` SEPARATELY, never
  // as one unit: `createQueryJob` SUBMITS the SQL, so retrying a poll that
  // failed on a 401 must NOT re-enter creation — that would resubmit a DML /
  // EXPORT a second time. Refreshing auth and re-polling the same job handle is
  // safe and is what the loader's BigQuery destination does too.
  //
  // Cancellation wraps creation AND polling in one `runCancellable` scope, which
  // is orthogonal to the two separate `authRetry` calls inside it. Unlike
  // DuckDB's connection-level `interrupt()`, BigQuery's cancellable handle is
  // the JOB, which does not exist until `createQueryJob` resolves — so the
  // canceller can only be registered after submission. `register` fires the
  // canceller immediately when the signal has already aborted, which closes the
  // create-then-abort race (abort landing between the pre-flight guard and the
  // job handle existing) without a hand-rolled re-check.
  const run = async (sql: string, options?: SqlExecOptions): Promise<SqlRunResult> => {
    const job = await runCancellable(options?.signal, async (register) => {
      const [created] = await authRetry(
        () => client.createQueryJob({ query: sql, location, ...jobLimit }),
        options?.signal
      );
      register(() => cancelBigQueryJob(created));
      await authRetry(() => created.getQueryResults(), options?.signal);
      return created;
    });
    const rc = job.metadata?.statistics?.query?.numDmlAffectedRows;
    if (rc !== undefined) {
      const n = parseInt(rc, 10);
      if (Number.isFinite(n)) return { rowCount: n };
    }
    return {};
  };

  const dryRun = async (sql: string, options?: SqlExecOptions): Promise<void> => {
    // Dry-run jobs do no work and return no results, so there is nothing to
    // re-submit; a single retry around creation is safe.
    await runCancellable(options?.signal, async (register) => {
      const [job] = await authRetry(
        () => client.createQueryJob({ query: sql, location, dryRun: true, useQueryCache: false }),
        options?.signal
      );
      // A dry-run job consumes no slots, but registering keeps the abort path
      // uniform and releases the server-side handle if the caller has bailed.
      register(() => cancelBigQueryJob(job));
    });
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): Promise<TRow[]> => {
    return runCancellable(options?.signal, async (register) => {
      const [job] = await authRetry(
        () =>
          client.createQueryJob({
            query: sql,
            location,
            ...jobLimit,
            ...(params
              ? { params, parameterMode: Array.isArray(params) ? 'positional' : 'named' }
              : {}),
          }),
        options?.signal
      );
      register(() => cancelBigQueryJob(job));
      const [rows] = await authRetry(() => job.getQueryResults(), options?.signal);
      return rows as TRow[];
    });
  };

  const close = async (): Promise<void> => {
    // BigQuery client is stateless — no connection to close.
  };

  const unload = async (
    sql: string,
    targetUri: string,
    opts: UnloadOptions
  ): Promise<UnloadResult> => {
    if (opts.format !== 'parquet') {
      throw new CommandError(
        `BigQuery unload supports only parquet format, got ${opts.format}.`,
        2
      );
    }
    const uri = unloadUriPattern(targetUri);
    if (!uri.startsWith('gs://')) {
      throw new CommandError('BigQuery unload requires a gs:// cross_warehouse_staging URI.', 2);
    }
    const exportSql = `EXPORT DATA OPTIONS(uri = '${escapeBigQueryString(uri)}', format = 'PARQUET', overwrite = true) AS (${sql})`;
    // EXPORT DATA writes files as a side effect — create once, poll separately,
    // so a 401 while polling never re-runs the export.
    const job = await runCancellable(opts.signal, async (register) => {
      const [created] = await authRetry(
        () => client.createQueryJob({ query: exportSql, location, ...jobLimit }),
        opts.signal
      );
      register(() => cancelBigQueryJob(created));
      await authRetry(() => created.getQueryResults(), opts.signal);
      return created;
    });
    const rawBytes = job.metadata?.statistics?.query?.totalBytesProcessed;
    const bytes = rawBytes === undefined ? undefined : Number(rawBytes);
    return {
      uris: [uri],
      rowCount: 0,
      ...(bytes !== undefined && Number.isFinite(bytes) ? { bytes } : {}),
    };
  };

  return { run, dryRun, query, unload, supportsBindings: true, close };
}
