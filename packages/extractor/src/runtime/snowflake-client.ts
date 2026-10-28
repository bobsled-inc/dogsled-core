/**
 * Standalone Snowflake SQL API v2 REST client for the extractor.
 *
 * Adapted from patterns in:
 * - app/src/lib/snowflake-connector/client.ts (REST API, polling, auth headers)
 * - services/cross-source-query/src/providers/snowflake-rest-client.ts (standalone PoC)
 *
 * Must NOT import from app/ or services/ — fully standalone.
 *
 * @see https://docs.snowflake.com/en/developer-guide/sql-api/reference
 */

import { readFileSync } from 'node:fs';

import { safeFetch } from '../framework/core/ssrf.js';
import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
} from './warehouse-client.js';
import { buildSnowflakeJwt } from './snowflake-jwt.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SnowflakeConfig {
  accountIdentifier: string;
  warehouse: string;
  // database + schema are optional defaults — resources/targets supply fully
  // qualified table refs when they need a different location.
  database?: string;
  schema?: string;
  role?: string;
  queryTag?: string;
  auth: SnowflakePatAuth | SnowflakeOAuthAuth | SnowflakeRsaKeyAuth | SnowflakeWorkloadIdentityAuth;
}

interface SnowflakePatAuth {
  type: 'pat';
  token: string;
}

interface SnowflakeOAuthAuth {
  type: 'oauth';
  token: string;
}

interface SnowflakeRsaKeyAuth {
  type: 'rsa_key';
  /** Pre-generated JWT (RS256, signed with the configured private key). */
  jwt: string;
}

/** Bearer prefixes the SQL API accepts for token-based workload identity federation. */
const WORKLOAD_IDENTITY_PROVIDERS = ['OIDC', 'GCP', 'AZURE'] as const;
type SnowflakeWorkloadIdentityProvider = (typeof WORKLOAD_IDENTITY_PROVIDERS)[number];

interface SnowflakeWorkloadIdentityAuth {
  type: 'workload_identity';
  provider: SnowflakeWorkloadIdentityProvider;
  /** Pre-minted identity token, sent as `Bearer WIF.<provider>.<token>`. */
  token: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Snowflake SQL API statement timeout (seconds). */
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Maximum polling attempts before giving up on async queries. */
const MAX_POLL_ATTEMPTS = 120;

/** Base polling interval (ms) for exponential backoff. */
const BASE_POLL_INTERVAL_MS = 500;

/** Maximum polling interval (ms). */
const MAX_POLL_INTERVAL_MS = 5_000;

/** Maximum retries on HTTP 429. */
const MAX_RATE_LIMIT_RETRIES = 5;

/** HTTP request timeout (ms) — statement timeout + buffer. */
const HTTP_TIMEOUT_MS = (DEFAULT_TIMEOUT_SECONDS + 5) * 1_000;

/** Number of rows per yielded batch from execute(). */
const BATCH_SIZE = 10_000;
const DEFAULT_QUERY_TAG = 'dogsled-extractor';
const MAX_QUERY_TAG_LENGTH = 256;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SnowflakeApiResponse {
  statementHandle: string;
  code?: string;
  message?: string;
  resultSetMetaData?: {
    numRows: number;
    partitionInfo?: Array<{ rowCount: number }>;
    rowType: Array<{
      name: string;
      type: string;
      nullable: boolean;
    }>;
  };
  data?: unknown[][];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAccountIdentifier(raw: string): string {
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/\.snowflakecomputing\.com\/?$/i, '')
    .replace(/\/+$/, '');
}

function getBackoffDelay(attempt: number): number {
  const base = Math.min(BASE_POLL_INTERVAL_MS * Math.pow(2, attempt), MAX_POLL_INTERVAL_MS);
  return base + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildAuthHeaders(auth: SnowflakeConfig['auth']): Record<string, string> {
  if (auth.type === 'pat') {
    return {
      Authorization: `Bearer ${auth.token}`,
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    };
  }
  if (auth.type === 'oauth') {
    return {
      Authorization: `Bearer ${auth.token}`,
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    };
  }
  if (auth.type === 'workload_identity') {
    return {
      Authorization: `Bearer WIF.${auth.provider}.${auth.token}`,
      'X-Snowflake-Authorization-Token-Type': 'WORKLOAD_IDENTITY_FEDERATION',
    };
  }
  // rsa_key — pre-generated JWT (built during parseSnowflakeConfig)
  return {
    Authorization: `Bearer ${auth.jwt}`,
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
  };
}

/**
 * Convert Snowflake columnar data (array of arrays) into row objects.
 */
function toRowObjects(data: unknown[][], columnNames: string[]): Record<string, unknown>[] {
  return data.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columnNames.length; i++) {
      obj[columnNames[i] ?? `col_${i}`] = row[i];
    }
    return obj;
  });
}

/**
 * Parse an error response from Snowflake into a descriptive error.
 */
async function parseSnowflakeError(response: Response): Promise<Error> {
  let message = `Snowflake SQL API request failed with status ${response.status}`;
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as SnowflakeApiResponse;
        if (parsed.message) {
          message = parsed.message;
        }
      } catch {
        message = text;
      }
    }
  } catch {
    // Unable to read body — use status-based message
  }
  return new Error(message);
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class SnowflakeWarehouseClient implements WarehouseClient {
  readonly dialect = 'snowflake' as const;
  private readonly baseUrl: string;
  private readonly config: SnowflakeConfig;
  private readonly authHeaders: Record<string, string>;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseSnowflakeConfig(rawConfig);
    const account = normalizeAccountIdentifier(this.config.accountIdentifier);
    // Validate account identifier format to prevent URL injection / SSRF
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(account)) {
      throw new Error(
        `Invalid Snowflake account identifier: "${account}" contains disallowed characters`
      );
    }
    this.baseUrl = `https://${account}.snowflakecomputing.com`;
    this.authHeaders = buildAuthHeaders(this.config.auth);
  }

  // -----------------------------------------------------------------------
  // execute — AsyncGenerator yielding row batches
  // -----------------------------------------------------------------------

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    const body: Record<string, unknown> = {
      statement: sql,
      timeout: DEFAULT_TIMEOUT_SECONDS,
      database: this.config.database,
      schema: this.config.schema,
      warehouse: this.config.warehouse,
      ...(this.config.role ? { role: this.config.role } : {}),
      parameters: {
        QUERY_TAG: this.config.queryTag ?? DEFAULT_QUERY_TAG,
      },
    };

    // Add bind parameters if provided (Snowflake SQL API v2 bindings format)
    if (params && params.length > 0) {
      const bindings: Record<string, { type: string; value: string }> = {};
      for (let i = 0; i < params.length; i++) {
        bindings[String(i + 1)] = {
          type: 'TEXT',
          value: String(params[i]),
        };
      }
      body['bindings'] = bindings;
    }

    const response = await this.sendRequest(`${this.baseUrl}/api/v2/statements`, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // 202 — async query, need to poll
    if (response.status === 202) {
      const asyncBody = (await response.json()) as SnowflakeApiResponse;
      yield* this.pollAndYield(asyncBody.statementHandle, opts?.maxRows);
      return;
    }

    if (!response.ok) {
      throw await parseSnowflakeError(response);
    }

    // 200 — immediate result
    const result = (await response.json()) as SnowflakeApiResponse;
    yield* this.yieldFromResponse(result, opts?.maxRows);
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
    // Escape double-quote characters in the database identifier to prevent SQL injection
    const escapedDb = database.replace(/"/g, '""');
    const sql = `
      SELECT
        c.TABLE_NAME,
        c.COLUMN_NAME,
        c.DATA_TYPE,
        c.IS_NULLABLE,
        c.COMMENT,
        CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY
      FROM "${escapedDb}".INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.COLUMN_NAME
        FROM "${escapedDb}".INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN "${escapedDb}".INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          AND tc.TABLE_NAME = kcu.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk
        ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA
        AND c.TABLE_NAME = pk.TABLE_NAME
        AND c.COLUMN_NAME = pk.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = :1
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql, [schema])) {
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
          ...(row['COMMENT'] ? { comment: String(row['COMMENT']) } : {}),
        };
        table.columns.push(column);
      }
    }

    return Array.from(tables.values());
  }

  // -----------------------------------------------------------------------
  // close — no-op for REST client
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    // REST client is stateless — nothing to close
  }

  // -----------------------------------------------------------------------
  // Private: HTTP request with rate limiting
  // -----------------------------------------------------------------------

  private async sendRequest(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const response = await safeFetch(url, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
    });

    // Rate limiting — exponential backoff
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const delay = getBackoffDelay(attempt);
      await sleep(delay);
      return this.sendRequest(url, init, attempt + 1);
    }

    return response;
  }

  // -----------------------------------------------------------------------
  // Private: poll for async results and yield batches
  // -----------------------------------------------------------------------

  private async *pollAndYield(
    statementHandle: string,
    maxRows?: number
  ): AsyncGenerator<Record<string, unknown>[]> {
    // Validate statement handle format to prevent path traversal / SSRF
    if (!/^[0-9a-f-]+$/i.test(statementHandle)) {
      throw new Error('Invalid Snowflake statement handle format');
    }
    const pollUrl = `${this.baseUrl}/api/v2/statements/${statementHandle}`;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await this.sendRequest(pollUrl, {
        method: 'GET',
        headers: this.authHeaders,
      });

      if (response.status === 202) {
        await sleep(getBackoffDelay(attempt));
        continue;
      }

      if (!response.ok) {
        throw await parseSnowflakeError(response);
      }

      const result = (await response.json()) as SnowflakeApiResponse;
      yield* this.yieldFromResponse(result, maxRows);
      return;
    }

    throw new Error(
      `Snowflake SQL API polling timed out after ${MAX_POLL_ATTEMPTS} attempts for statement ${statementHandle}`
    );
  }

  // -----------------------------------------------------------------------
  // Private: yield row batches from a completed response
  // -----------------------------------------------------------------------

  private async *yieldFromResponse(
    response: SnowflakeApiResponse,
    maxRows?: number
  ): AsyncGenerator<Record<string, unknown>[]> {
    const columnNames = response.resultSetMetaData?.rowType.map((col) => col.name) ?? [];

    let emittedRows = 0;

    // Yield rows from the initial response data
    if (response.data && response.data.length > 0) {
      const rows = toRowObjects(response.data, columnNames);
      const actualYielded = this.computeActualYielded(rows.length, maxRows, emittedRows);
      yield* this.chunkAndYield(rows, maxRows, emittedRows);
      emittedRows += actualYielded;

      if (maxRows !== undefined && emittedRows >= maxRows) {
        return;
      }
    }

    // Fetch additional partitions if present
    const partitions = response.resultSetMetaData?.partitionInfo;
    if (partitions && partitions.length > 1) {
      // Partition 0 is the initial response; fetch 1..N
      for (let partIdx = 1; partIdx < partitions.length; partIdx++) {
        if (maxRows !== undefined && emittedRows >= maxRows) {
          return;
        }

        const partitionUrl = `${this.baseUrl}/api/v2/statements/${response.statementHandle}?partition=${partIdx}`;
        const partResponse = await this.sendRequest(partitionUrl, {
          method: 'GET',
          headers: this.authHeaders,
        });

        if (!partResponse.ok) {
          throw await parseSnowflakeError(partResponse);
        }

        const partBody = (await partResponse.json()) as SnowflakeApiResponse;
        if (partBody.data && partBody.data.length > 0) {
          const rows = toRowObjects(partBody.data, columnNames);
          const actualYielded = this.computeActualYielded(rows.length, maxRows, emittedRows);
          yield* this.chunkAndYield(rows, maxRows, emittedRows);
          emittedRows += actualYielded;
        }
      }
    }
  }

  private computeActualYielded(
    rowCount: number,
    maxRows: number | undefined,
    emittedRows: number
  ): number {
    return maxRows !== undefined ? Math.min(rowCount, maxRows - emittedRows) : rowCount;
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

/** Validate a Snowflake identifier (database, schema, role, warehouse).
 *  Per Snowflake docs, unquoted identifiers allow letters, digits, underscores, and $. */
const SNOWFLAKE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function validateSnowflakeIdentifier(value: string, label: string): string {
  if (!SNOWFLAKE_IDENTIFIER_RE.test(value)) {
    throw new Error(
      `SnowflakeConfig: "${label}" value "${value}" contains disallowed characters (only alphanumeric, underscore, and $ are permitted)`
    );
  }
  return value;
}

export function parseSnowflakeConfig(raw: Record<string, unknown>): SnowflakeConfig {
  const accountIdentifier = requireString(raw, 'accountIdentifier');
  const warehouse = requireString(raw, 'warehouse');
  // database + schema are optional defaults on the connection — resources and
  // targets override per-use. Validated only when present.
  const database = optionalString(raw, 'database');
  const schema = optionalString(raw, 'schema');
  const role = optionalString(raw, 'role');
  const queryTag = optionalQueryTag(raw);

  // Validate identifiers to prevent injection via Snowflake API
  if (database) validateSnowflakeIdentifier(database, 'database');
  if (schema) validateSnowflakeIdentifier(schema, 'schema');
  validateSnowflakeIdentifier(warehouse, 'warehouse');
  if (role) validateSnowflakeIdentifier(role, 'role');

  const authRaw = raw['auth'];
  if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
    throw new Error('SnowflakeConfig: "auth" must be an object with a type discriminator');
  }
  const authObj = authRaw as Record<string, unknown>;
  const authType = requireString(authObj, 'type');

  if (authType === 'pat' || authType === 'oauth') {
    const token = requireString(authObj, 'token');
    return {
      accountIdentifier,
      warehouse,
      database,
      schema,
      role,
      queryTag,
      auth: { type: authType, token },
    };
  }

  if (authType === 'rsa_key') {
    // username lives on the connection (connection.user_env → resolved as raw.user)
    const user = requireString(raw, 'user');
    const privateKeyPath = requireString(authObj, 'private_key_path');
    const passphrase = optionalString(authObj, 'private_key_passphrase');

    let privateKeyPem: string;
    try {
      privateKeyPem = readFileSync(privateKeyPath, 'utf8');
    } catch (err) {
      throw new Error(
        `SnowflakeConfig: failed to read private key file at "${privateKeyPath}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let jwt: string;
    try {
      jwt = buildSnowflakeJwt({
        accountIdentifier,
        user,
        privateKeyPem,
        passphrase,
      });
    } catch (err) {
      throw new Error(
        `SnowflakeConfig: failed to sign JWT with provided private key (check passphrase / key format): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      accountIdentifier,
      warehouse,
      database,
      schema,
      role,
      queryTag,
      auth: { type: 'rsa_key', jwt },
    };
  }

  if (authType === 'workload_identity') {
    const token = requireString(authObj, 'token');
    if (/[\r\n]/.test(token)) {
      throw new Error('SnowflakeConfig: workload identity "token" must not contain newlines');
    }
    const providerRaw = optionalString(authObj, 'provider') ?? 'OIDC';
    const provider = WORKLOAD_IDENTITY_PROVIDERS.find((candidate) => candidate === providerRaw);
    if (!provider) {
      throw new Error(
        `SnowflakeConfig: unsupported workload identity provider "${providerRaw}" (expected ${WORKLOAD_IDENTITY_PROVIDERS.map((candidate) => `"${candidate}"`).join(', ')})`
      );
    }
    return {
      accountIdentifier,
      warehouse,
      database,
      schema,
      role,
      queryTag,
      auth: { type: 'workload_identity', provider, token },
    };
  }

  throw new Error(
    `SnowflakeConfig: unsupported auth type "${authType}" (expected "pat", "oauth", "rsa_key", or "workload_identity")`
  );
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const val = pickEitherCase(obj, key);
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`SnowflakeConfig: "${key}" is required and must be a non-empty string`);
  }
  return val;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = pickEitherCase(obj, key);
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== 'string') {
    throw new Error(`SnowflakeConfig: "${key}" must be a string if provided`);
  }
  return val;
}

function optionalQueryTag(obj: Record<string, unknown>): string | undefined {
  const value = optionalString(obj, 'queryTag');
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error('SnowflakeConfig: "queryTag" must not be empty');
  }
  if (value.length > MAX_QUERY_TAG_LENGTH) {
    throw new Error(
      `SnowflakeConfig: "queryTag" must be at most ${MAX_QUERY_TAG_LENGTH} characters`
    );
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new Error('SnowflakeConfig: "queryTag" must not contain control characters');
  }
  return value;
}

/**
 * Accept both camelCase (how tests and callers building config programmatically
 * supply keys) and snake_case (how resolveEnvVars produces them after parsing
 * the integration YAML). Prefer camelCase when both are present for backwards
 * compatibility with existing programmatic callers.
 */
function pickEitherCase(obj: Record<string, unknown>, camelKey: string): unknown {
  if (camelKey in obj) return obj[camelKey];
  const snakeKey = camelKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return obj[snakeKey];
}
