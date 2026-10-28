import { createRequire } from 'node:module';
import { assertDriverVersion } from '@bobsled-inc/connections';
/**
 * Standalone BigQuery SDK wrapper for the extractor.
 *
 * Adapted from patterns in:
 * - app/src/lib/bigquery-connector/client.ts (SDK usage, job creation, pagination)
 *
 * Must NOT import from app/ or services/ — fully standalone.
 *
 * Uses dynamic `import('@google-cloud/bigquery')` to avoid loading the SDK
 * unless a BigQuery extraction is actually requested.
 */

import { CommandError } from '@bobsled-inc/protocol';

import {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  createTokenCommandProvider,
} from './bigquery-auth.js';

import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
} from './warehouse-client.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BigQueryConfig {
  projectId: string;
  billingProjectId?: string;
  defaultLocation?: string;
  /**
   * Pre-minted OAuth access-token auth, resolved from the source's `auth` block
   * (`type: access_token`). Absent for adc / wif / service_account, which keep
   * the SDK's ambient credential resolution.
   */
  accessTokenAuth?: BigQueryAccessTokenAuth;
}

/** Resolved pre-minted access-token auth extracted from a source `auth` block. */
export interface BigQueryAccessTokenAuth {
  /** Static short-lived OAuth 2.0 access token (already env-resolved). */
  accessToken: string;
  /**
   * Optional shell command that prints fresh `{"access_token","expires_at"}`
   * JSON. When set it takes precedence over the static token and is run
   * per-fetch so a long extraction survives the token TTL.
   */
  tokenCommand?: string;
}

/**
 * Extract pre-minted access-token auth from a resolved `auth` block (env vars
 * already interpolated by the extractor's `resolveConnectionConfig`). Returns
 * undefined for adc / wif / service_account / absent auth — those keep the
 * SDK's ambient credential resolution (ADC, `GOOGLE_APPLICATION_CREDENTIALS`),
 * preserving prior behavior. Throws when `type: access_token` carries no
 * usable token (e.g. an unresolved `${{ env.X }}` reference).
 */
export function resolveBigQueryAccessTokenAuth(auth: unknown): BigQueryAccessTokenAuth | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const a = auth as Record<string, unknown>;
  if (a['type'] !== 'access_token') {
    return undefined;
  }
  const accessToken = a['access_token'];
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new CommandError(
      'BigQuery access_token auth requires a non-empty "access_token" (check ${{ env.X }} resolution)'
    );
  }
  const rawCommand = a['token_command'];
  const tokenCommand =
    typeof rawCommand === 'string' && rawCommand.trim().length > 0 ? rawCommand : undefined;
  return { accessToken, tokenCommand };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default query timeout (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 10 TB maximum bytes billed per query — safety cap. */
const MAXIMUM_BYTES_BILLED = '10000000000000';

/** Number of rows per page when fetching query results. */
const PAGE_SIZE = 10_000;

/** Number of rows per yielded batch from execute(). */
const BATCH_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Lazy-loaded SDK types
//
// We avoid importing the SDK at module level. Instead, the class dynamically
// imports `@google-cloud/bigquery` on first use. The types below are minimal
// structural interfaces so the rest of the file compiles without the SDK.
// ---------------------------------------------------------------------------

/** Minimal structural type for the BigQuery SDK client. */
interface BigQuerySdk {
  createQueryJob(options: Record<string, unknown>): Promise<[BigQueryJob]>;
}

/** Minimal structural type for a BigQuery Job. */
interface BigQueryJob {
  getQueryResults(
    options: Record<string, unknown>
  ): Promise<[Record<string, unknown>[], unknown, BigQueryResultsMeta]>;
}

/** Metadata returned alongside query results. */
interface BigQueryResultsMeta {
  schema?: {
    fields?: BigQueryField[];
  };
  totalBytesProcessed?: string;
  pageToken?: string;
  jobReference?: { jobId?: string };
}

/** A single field descriptor from the BigQuery schema. */
interface BigQueryField {
  name?: string;
  type?: string;
  mode?: string; // 'NULLABLE' | 'REQUIRED' | 'REPEATED'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a BigQuery project ID or dataset ID to prevent injection in backtick-quoted identifiers. */
function validateBigQueryIdentifier(value: string, label: string): string {
  // BigQuery project IDs: [a-z][a-z0-9:-]*, dataset IDs: [a-zA-Z0-9_]*
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) {
    throw new CommandError(`Invalid BigQuery ${label}: "${value}" contains disallowed characters`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class BigQueryWarehouseClient implements WarehouseClient {
  readonly dialect = 'bigquery' as const;
  private readonly config: BigQueryConfig;
  private sdkClient: BigQuerySdk | null = null;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseBigQueryConfig(rawConfig);
  }

  // -----------------------------------------------------------------------
  // execute — AsyncGenerator yielding row batches
  // -----------------------------------------------------------------------

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const client = await this.getClient();

    const queryOptions: Record<string, unknown> = {
      query: sql,
      location: this.config.defaultLocation,
      maximumBytesBilled: MAXIMUM_BYTES_BILLED,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      useLegacySql: false,
      ...(params && params.length > 0 ? { params } : {}),
    };

    const [job] = await client.createQueryJob(queryOptions);

    let emittedRows = 0;
    let pageToken: string | undefined;

    // Paginate results manually so we can yield in bounded batches.
    do {
      const resultsOptions: Record<string, unknown> = {
        maxResults: PAGE_SIZE,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        autoPaginate: false,
      };

      if (pageToken) {
        resultsOptions['pageToken'] = pageToken;
      }

      const [rows, , meta] = await (job as BigQueryJob).getQueryResults(resultsOptions);

      const fetchedRows = rows as Record<string, unknown>[];

      // Yield in BATCH_SIZE chunks (typically same as PAGE_SIZE, but guard)
      yield* this.chunkAndYield(fetchedRows, opts?.maxRows, emittedRows);
      emittedRows += fetchedRows.length;

      if (opts?.maxRows !== undefined && emittedRows >= opts.maxRows) {
        return;
      }

      pageToken = (meta as BigQueryResultsMeta).pageToken ?? undefined;
    } while (pageToken);
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
  // introspect — INFORMATION_SCHEMA discovery
  // -----------------------------------------------------------------------

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // In BigQuery, `database` maps to `project` and `schema` maps to `dataset`.
    // Validate identifiers to prevent injection in backtick-quoted contexts.
    const project = validateBigQueryIdentifier(database, 'project');
    const dataset = validateBigQueryIdentifier(schema, 'dataset');

    const sql = `
      SELECT
        c.TABLE_NAME,
        c.COLUMN_NAME,
        c.DATA_TYPE,
        c.IS_NULLABLE,
        COALESCE(c.COLUMN_DEFAULT, '') AS COLUMN_DEFAULT,
        CASE
          WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES'
          ELSE 'NO'
        END AS IS_PRIMARY_KEY
      FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` c
      LEFT JOIN (
        SELECT
          kcu.TABLE_NAME,
          kcu.COLUMN_NAME
        FROM \`${project}.${dataset}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE\` kcu
        JOIN \`${project}.${dataset}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS\` tc
          ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          AND kcu.TABLE_NAME = tc.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk
        ON c.TABLE_NAME = pk.TABLE_NAME
        AND c.COLUMN_NAME = pk.COLUMN_NAME
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql)) {
      for (const row of batch) {
        const tableName = String(row['TABLE_NAME'] ?? '');
        let table = tables.get(tableName);
        if (!table) {
          table = { tableName, schema, database, columns: [] };
          tables.set(tableName, table);
        }

        const column: ColumnDiscovery = {
          name: String(row['COLUMN_NAME'] ?? ''),
          sourceType: String(row['DATA_TYPE'] ?? ''),
          nullable: String(row['IS_NULLABLE']) === 'YES',
          isPrimaryKey: String(row['IS_PRIMARY_KEY']) === 'YES',
        };
        table.columns.push(column);
      }
    }

    return Array.from(tables.values());
  }

  // -----------------------------------------------------------------------
  // close — no-op for SDK client
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    // BigQuery SDK client is stateless — nothing to close
  }

  // -----------------------------------------------------------------------
  // Private: lazy SDK initialization
  // -----------------------------------------------------------------------

  private async getClient(): Promise<BigQuerySdk> {
    if (this.sdkClient) {
      return this.sdkClient;
    }

    // Dynamic import to avoid loading the SDK unless BigQuery is actually used.
    assertDriverVersion('@google-cloud/bigquery', '8.1.1', createRequire(import.meta.url));
    const { BigQuery } = await import('@google-cloud/bigquery');

    // Determine execution/billing project.
    // billingProjectId is the host application's billing project; falls back to projectId.
    const executionProjectId = this.config.billingProjectId ?? this.config.projectId;

    // Auth precedence (mirrors the loader's BigQuery destination):
    //   1. access_token auth with token_command → refreshable AuthClient
    //      (re-mints per-fetch; survives extractions longer than the token TTL)
    //   2. access_token auth, static token → OAuth2Client seeded with the token
    //   3. no access_token auth → the SDK's ambient resolution:
    //      - ADC for local dev (gcloud auth application-default login)
    //      - WIF for production (GOOGLE_APPLICATION_CREDENTIALS or metadata server)
    const authClient = await this.buildAuthClient();
    const sdkOptions: { projectId: string; location?: string; authClient?: unknown } = {
      projectId: executionProjectId,
      location: this.config.defaultLocation,
    };
    if (authClient) {
      // The runtime value is a valid OAuth2-based auth client; the cast bridges
      // a google-auth-library / @google-cloud/bigquery type-version skew in the
      // SDK's `authClient` union (`AnyAuthClient`).
      sdkOptions.authClient = authClient;
    }
    this.sdkClient = new BigQuery(
      sdkOptions as unknown as ConstructorParameters<typeof BigQuery>[0]
    ) as unknown as BigQuerySdk;

    return this.sdkClient;
  }

  /**
   * Build the google-auth `AuthClient` for a pre-minted access-token source, or
   * `undefined` when no access_token auth was configured — in which case the
   * SDK falls back to ambient ADC/WIF, so adc / wif / service_account sources
   * are unchanged.
   *
   * `google-auth-library` is imported lazily (only when an access_token source
   * is actually exercised), matching the lazy `@google-cloud/bigquery` import.
   */
  private async buildAuthClient(): Promise<import('google-auth-library').OAuth2Client | undefined> {
    const auth = this.config.accessTokenAuth;
    if (!auth) {
      return undefined;
    }

    let OAuth2Client: typeof import('google-auth-library').OAuth2Client;
    try {
      ({ OAuth2Client } = await import('google-auth-library'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandError(
        `Failed to load google-auth-library, required for BigQuery access_token auth. ${message}`
      );
    }

    if (auth.tokenCommand) {
      // Refreshable: re-mint per-fetch so an extraction outlasting the ~1h
      // token TTL keeps authenticating. Takes precedence over the static token.
      const tokenSource = new RefreshableTokenSource(createTokenCommandProvider(auth.tokenCommand));
      return createRefreshableAuthClient({ tokenSource, OAuth2Client });
    }

    // Static pre-minted token: wrap it in a non-refreshing token source so it
    // flows through the SAME `Headers`-returning auth client as the refreshable
    // path. A native `OAuth2Client.setCredentials()` built from the (externalized)
    // google-auth import returns plain-object headers when that import resolves
    // v9, which the BigQuery SDK v8 (v10 contract) drops -> unauthenticated
    // request. The static token has no refresh mechanism; the far-future expiry
    // just keeps the source from attempting a (nonexistent) refresh — the token
    // is valid for its own ~1h TTL, which covers normal extracts.
    const tokenSource = new RefreshableTokenSource(async () => ({
      accessToken: auth.accessToken,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }));
    return createRefreshableAuthClient({ tokenSource, OAuth2Client });
  }

  // -----------------------------------------------------------------------
  // Private: chunk a row array into BATCH_SIZE pieces and yield
  // -----------------------------------------------------------------------

  private *chunkAndYield(
    rows: Record<string, unknown>[],
    maxRows: number | undefined,
    emittedSoFar: number
  ): Generator<Record<string, unknown>[]> {
    let remaining = maxRows !== undefined ? maxRows - emittedSoFar : rows.length;
    let offset = 0;

    while (offset < rows.length && remaining > 0) {
      const end = Math.min(offset + BATCH_SIZE, offset + remaining, rows.length);
      const chunk = rows.slice(offset, end);
      if (chunk.length > 0) {
        yield chunk;
      }
      remaining -= chunk.length;
      offset = end;
    }
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function parseBigQueryConfig(raw: Record<string, unknown>): BigQueryConfig {
  const projectId = resolveBigQueryProjectId(raw);
  const billingProjectId =
    optionalString(raw, 'billingProjectId') ?? optionalString(raw, 'billing_project_id');
  const defaultLocation =
    optionalString(raw, 'defaultLocation') ?? optionalString(raw, 'default_location');

  return {
    projectId,
    billingProjectId,
    defaultLocation,
    accessTokenAuth: resolveBigQueryAccessTokenAuth(raw['auth']),
  };
}

function resolveBigQueryProjectId(raw: Record<string, unknown>): string {
  const direct = raw['projectId'];
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }

  const legacy = raw['project_ids'];
  if (Array.isArray(legacy)) {
    const first = legacy.find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    if (first !== undefined) {
      return first.trim();
    }
  }

  throw new CommandError(
    'BigQueryConfig: provide "projectId" or a non-empty entry in "project_ids"'
  );
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'string') {
    throw new CommandError(`BigQueryConfig: "${key}" must be a string if provided`);
  }
  // Trim and treat empty-after-trim as undefined, so whitespace-only values
  // don't slip through later stages of parsing as valid config.
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
