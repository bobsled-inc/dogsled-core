import { quoteWarehouseLiteral } from '@bobsled-inc/protocol';
import {
  buildClusterColumns,
  logTableOptimization,
  SYSTEM_COLUMNS,
  assertNonEmptyColumns,
  sanitizeSchemaName,
  sanitizeTableName,
  reverseMapDbType,
} from './database.js';
import { isRetryableError, withRetry } from '../retry.js';
import {
  compareSnowflakeSchema,
  enforceContract,
  readSnowflakeVectorTypes,
  reconcileRemovedSnowflakeColumns,
} from './snowflake-schema-reconcile.js';
import {
  applySnowflakeClustering,
  parseSnowflakeClusteringKey,
  replaceSnowflakeTable,
  type SnowflakeTableMaintenanceContext,
} from './snowflake-table-maintenance.js';
import {
  assertUniqueSnowflakeColumnNames,
  loadSnowflakeAndFinalize,
  loadSnowflakeFromUri,
  type SnowflakeLoadContext,
} from './snowflake-loading.js';
import {
  RefreshableTokenSource,
  TOKEN_REFRESH_SKEW_SECONDS,
  type BigQueryAccessToken,
  type BigQueryTokenProvider,
} from '../bigquery-auth.js';

import { CommandError } from '@bobsled-inc/protocol';
import type { BatchEncoding, SchemaColumn } from '@bobsled-inc/protocol';
import type { DatabaseDestination, EnsureTableOptions, LoadResult } from './database.js';
import type { LoaderLogger } from '../logger.js';
import {
  assertSnowflakeWorkloadIdentityUsable,
  createSnowflakeSdkConnection,
  sanitizeSnowflakeConnection,
  validateSnowflakeWorkloadIdentityConfiguration,
  validateSnowflakeWorkloadIdentityToken,
} from './snowflake-connection.js';
import { copySnowflakeErrorLike, redactSnowflakeSecret } from './snowflake-errors.js';
import {
  mapSnowflakeColumnType,
  mapSnowflakeType,
  normalizeSnowflakeType,
} from './snowflake-type-mapping.js';

export { mapSnowflakeType, normalizeSnowflakeType } from './snowflake-type-mapping.js';

const DELETE_BATCH_SIZE = 500;

// ── Snowflake DI interfaces for testing ──

export interface SnowflakeUploadResult {
  status: string;
}

export interface SnowflakeStatementResult {
  getRows(): Record<string, unknown>[];
  getAffectedRows(): number;
  getColumns(): Array<{ getName(): string; getType(): string }>;
}

export interface SnowflakeConnectionLike {
  connect(): Promise<void>;
  execute(options: { sqlText: string; binds?: string[] }): Promise<SnowflakeStatementResult>;
  uploadFile(options: { srcPath: string; destLoc: string }): Promise<SnowflakeUploadResult>;
  isClosed(): boolean;
  destroy(): Promise<void>;
}

/**
 * A Snowflake MERGE returns a one-row result set summarizing the operation,
 * e.g. `{ "number of rows inserted": 97, "number of rows updated": 0 }`. The
 * generic `getAffectedRows()` relies on the driver's `getNumUpdatedRows()`,
 * which reports UPDATED rows only — so an insert-only merge into a fresh/empty
 * table reports `rowsAffected: 0` even though every staged row was inserted.
 * That silent zero is indistinguishable from "nothing to merge", which is
 * exactly how a working first run can look like dropped data. Sum the insert +
 * update counts from the summary so the reported count reflects what landed.
 */
export function extractMergeAffectedRows(rows: Record<string, unknown>[]): number | undefined {
  const summary = rows[0];
  if (!summary) return undefined;
  let total = 0;
  let matched = false;
  for (const [key, value] of Object.entries(summary)) {
    const normalized = key.toLowerCase();
    if (normalized.includes('rows inserted') || normalized.includes('rows updated')) {
      const count = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(count)) {
        total += count;
        matched = true;
      }
    }
  }
  return matched ? total : undefined;
}

export interface SnowflakeConnectionConfig {
  account: string;
  username: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  /** Selects the Snowflake authentication mode. */
  authenticator?: 'OAUTH' | 'SNOWFLAKE_JWT' | 'WORKLOAD_IDENTITY';
  /** Resolved OAuth or workload identity token. */
  token?: string;
  /** Snowflake workload identity provider for `WORKLOAD_IDENTITY` auth. */
  workloadIdentityProvider?: 'OIDC';
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  queryTag?: string;
}

export interface SnowflakeDestinationOptions {
  account: string;
  username: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  /** Static pre-minted Snowflake OIDC/OAuth access token. */
  accessToken?: string;
  /** Refreshable short-lived OIDC/OAuth token source (takes precedence over accessToken). */
  tokenProvider?: BigQueryTokenProvider;
  /** Selects OAuth auth path — the destination will fetch a token at initialize(). */
  authenticator?: 'OAUTH' | 'SNOWFLAKE_JWT';
  /** OAuth client_credentials grant inputs (required when authenticator === 'OAUTH'). */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTokenUrl?: string;
  /** Clock override for token refresh tests. Unix seconds. */
  now?: () => number;
  /** Override the proactive token-refresh skew for tests. Seconds before expiry. */
  skewSeconds?: number;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  /** Trusted per-run metadata applied by the SDK as Snowflake QUERY_TAG. */
  queryTag?: string;
  connectionFactory?: (config: SnowflakeConnectionConfig) => SnowflakeConnectionLike;
  /** Override the OAuth token fetcher (for tests). */
  oauthTokenFetcher?: (opts: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
  }) => Promise<{ accessToken: string; expiresAt: number }>;
  /** Pre-minted Snowflake OIDC workload identity JWT for one loader attempt. */
  workloadIdentityToken?: string;
  logger?: LoaderLogger;
}

interface SnowflakeTableMetadata {
  exists: boolean;
  comment?: string;
}

export function quoteSnowflakeIdentifier(identifier: string): string {
  return `"${identifier.toUpperCase().replace(/"/g, '""')}"`;
}

/**
 * Quote an identifier without changing its case. Snowflake preserves the case
 * of quoted identifiers, so reserved tables whose names contain opaque mixed
 * or lower-case tokens must use this form for every reference to the table.
 */
function quoteSnowflakeIdentifierPreservingCase(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteSnowflakeStringLiteral(value: string): string {
  return quoteWarehouseLiteral(value);
}

const MAX_TABLE_OWNERSHIP_MARKER_LENGTH = 256;

/**
 * Validate a table ownership marker before it is interpolated into a Snowflake
 * COMMENT literal. The marker is generated by the orchestrator (currently a
 * dataset identifier), but it still crosses the loader boundary as input.
 */
export function validateSnowflakeTableOwnershipMarker(marker: string): void {
  if (marker.length === 0) {
    throw new CommandError('Snowflake table ownership marker must be non-empty.', 2);
  }
  if (marker.length > MAX_TABLE_OWNERSHIP_MARKER_LENGTH) {
    throw new CommandError(
      `Snowflake table ownership marker must be at most ${MAX_TABLE_OWNERSHIP_MARKER_LENGTH} characters.`,
      2
    );
  }
  if (marker.trim() !== marker) {
    throw new CommandError(
      'Snowflake table ownership marker must not have surrounding whitespace.',
      2
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(marker)) {
    throw new CommandError(
      'Snowflake table ownership marker must not contain control characters.',
      2
    );
  }
}

function getSnowflakeMetadataValue(row: Record<string, unknown>, key: string): unknown {
  const expected = key.toUpperCase();
  return Object.entries(row).find(([name]) => name.toUpperCase() === expected)?.[1];
}

/** Escape a field name for use in Snowflake `$1:"field"` JSON path expressions. */
function escapeJsonFieldName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function inferSnowflakeAuthenticator(
  explicit: 'OAUTH' | 'SNOWFLAKE_JWT' | undefined,
  privateKeyPath: string | undefined
): 'OAUTH' | 'SNOWFLAKE_JWT' | undefined {
  if (explicit) return explicit;
  if (privateKeyPath) return 'SNOWFLAKE_JWT';
  return undefined;
}

/** Check if a Snowflake error is retryable (delegates to base + Snowflake-specific patterns). */
function isSnowflakeRetryable(error: unknown): boolean {
  if (isRetryableError(error)) return true;
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: string }).code;
  if (code === 'ENOTFOUND') return true;

  const message = error.message;
  if (/throttl/i.test(message)) return true;
  if (/too many requests/i.test(message)) return true;
  if (/connection was closed/i.test(message)) return true;
  if (/warehouse.*resum/i.test(message)) return true;

  return false;
}

export class SnowflakeDestination implements DatabaseDestination {
  private readonly account: string;
  private readonly username: string;
  private readonly password?: string;
  private readonly privateKeyPath?: string;
  private readonly privateKeyPassphrase?: string;
  private readonly accessToken?: string;
  private readonly workloadIdentityToken?: string;
  private readonly now: () => number;
  private workloadIdentityExpiresAt?: number;
  private readonly configuredTokenProvider: boolean;
  private readonly configuredAuthenticator?: 'OAUTH' | 'SNOWFLAKE_JWT';
  private readonly tokenSource?: RefreshableTokenSource;
  private readonly authenticator?: 'OAUTH' | 'SNOWFLAKE_JWT' | 'WORKLOAD_IDENTITY';
  private readonly oauthClientId?: string;
  private readonly oauthClientSecret?: string;
  private readonly oauthTokenUrl?: string;
  private readonly oauthTokenFetcher?: SnowflakeDestinationOptions['oauthTokenFetcher'];
  private readonly warehouse: string;
  private readonly database: string;
  private readonly schema: string;
  private readonly role?: string;
  private readonly queryTag?: string;
  private readonly logger?: LoaderLogger;
  private readonly connectionFactory: (
    config: SnowflakeConnectionConfig
  ) => SnowflakeConnectionLike;
  private conn: SnowflakeConnectionLike | null = null;
  private cancelRequested = false;
  /** Active short-lived access token for the reconnecting OAUTH path. */
  private currentAccessToken?: BigQueryAccessToken;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  /** Cache of applied cluster columns per table to avoid redundant ALTER CLUSTER BY. */
  private clusterCache = new Map<string, string[]>();
  /** Ownership markers learned from SCHEMA handling for the current run. */
  private tableOwnershipMarkers = new Map<string, string>();

  constructor(options: SnowflakeDestinationOptions) {
    this.account = options.account;
    this.username = options.username;
    this.password = options.password;
    this.privateKeyPath = options.privateKeyPath;
    this.privateKeyPassphrase = options.privateKeyPassphrase;
    this.accessToken = options.accessToken;
    this.workloadIdentityToken = options.workloadIdentityToken;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.configuredTokenProvider = options.tokenProvider !== undefined;
    this.configuredAuthenticator = options.authenticator;
    this.authenticator = options.workloadIdentityToken
      ? 'WORKLOAD_IDENTITY'
      : options.tokenProvider || options.accessToken
        ? 'OAUTH'
        : inferSnowflakeAuthenticator(options.authenticator, options.privateKeyPath);
    this.oauthClientId = options.oauthClientId;
    this.oauthClientSecret = options.oauthClientSecret;
    this.oauthTokenUrl = options.oauthTokenUrl;
    this.oauthTokenFetcher = options.oauthTokenFetcher;
    this.warehouse = options.warehouse;
    this.database = options.database;
    this.schema = options.schema;
    this.role = options.role;
    this.queryTag = options.queryTag;
    this.logger = options.logger;
    this.connectionFactory =
      options.connectionFactory ??
      ((config) => createSnowflakeSdkConnection(config, (error) => this.sanitizeError(error)));
    const provider = !options.workloadIdentityToken
      ? (options.tokenProvider ??
        (this.authenticator === 'OAUTH' && !options.accessToken
          ? () => this.resolveOAuthToken()
          : undefined))
      : undefined;
    this.tokenSource = provider
      ? new RefreshableTokenSource(provider, {
          now: options.now,
          skewSeconds: options.skewSeconds ?? TOKEN_REFRESH_SKEW_SECONDS,
        })
      : undefined;
  }

  private getKnownSecrets(): string[] {
    return [
      this.password,
      this.privateKeyPassphrase,
      this.oauthClientSecret,
      this.accessToken,
      this.workloadIdentityToken,
      this.currentAccessToken?.accessToken,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  private sanitizeErrorMessage(message: string): string {
    let sanitized = message;
    for (const secret of this.getKnownSecrets()) {
      sanitized = redactSnowflakeSecret(sanitized, secret);
    }
    return sanitized;
  }

  private sanitizeError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new Error(this.sanitizeErrorMessage(String(error)));
    }
    const sanitizedMessage = this.sanitizeErrorMessage(error.message);
    return copySnowflakeErrorLike(error, sanitizedMessage, (value) =>
      this.sanitizeErrorMessage(value)
    );
  }

  private createConnection(config: SnowflakeConnectionConfig): SnowflakeConnectionLike {
    try {
      return sanitizeSnowflakeConnection(this.connectionFactory(config), (error) =>
        this.sanitizeError(error)
      );
    } catch (error) {
      throw this.sanitizeError(error);
    }
  }

  private async resolveOAuthToken(): Promise<{ accessToken: string; expiresAt: number }> {
    if (!this.oauthClientId || !this.oauthClientSecret || !this.oauthTokenUrl) {
      throw new Error(
        'SnowflakeDestination: authenticator=OAUTH requires oauthClientId, oauthClientSecret, and oauthTokenUrl.'
      );
    }
    if (this.oauthTokenFetcher) {
      return this.oauthTokenFetcher({
        tokenUrl: this.oauthTokenUrl,
        clientId: this.oauthClientId,
        clientSecret: this.oauthClientSecret,
      });
    }
    const { fetchOAuthToken } = await import('../oauth-token-fetcher.js');
    return fetchOAuthToken({
      tokenUrl: this.oauthTokenUrl,
      clientId: this.oauthClientId,
      clientSecret: this.oauthClientSecret,
    });
  }

  private buildConnectionConfig(token: string | undefined): SnowflakeConnectionConfig {
    return {
      account: this.account,
      username: this.username,
      password: this.password,
      privateKeyPath: this.privateKeyPath,
      privateKeyPassphrase: this.privateKeyPassphrase,
      authenticator: this.authenticator,
      token,
      workloadIdentityProvider: this.workloadIdentityToken ? 'OIDC' : undefined,
      warehouse: this.warehouse,
      database: this.database,
      schema: this.schema,
      role: this.role,
      ...(this.queryTag === undefined ? {} : { queryTag: this.queryTag }),
    };
  }

  async initialize(): Promise<void> {
    this.throwIfCancelled();
    validateSnowflakeWorkloadIdentityConfiguration({
      token: this.workloadIdentityToken,
      password: this.password,
      privateKeyPath: this.privateKeyPath,
      privateKeyPassphrase: this.privateKeyPassphrase,
      accessToken: this.accessToken,
      tokenProviderConfigured: this.configuredTokenProvider,
      authenticatorConfigured: this.configuredAuthenticator,
      oauthClientId: this.oauthClientId,
      oauthClientSecret: this.oauthClientSecret,
      oauthTokenUrl: this.oauthTokenUrl,
    });
    let token: string | undefined;
    if (this.workloadIdentityToken) {
      this.workloadIdentityExpiresAt = validateSnowflakeWorkloadIdentityToken(
        this.workloadIdentityToken,
        this.now()
      );
      token = this.workloadIdentityToken;
      assertSnowflakeWorkloadIdentityUsable({
        expiresAt: this.workloadIdentityExpiresAt,
        now: this.now(),
      });
    } else if (this.tokenSource) {
      this.currentAccessToken = await this.tokenSource.getAccessToken();
      token = this.currentAccessToken.accessToken;
      this.throwIfCancelled();
    } else if (this.accessToken) {
      token = this.accessToken;
    } else if (this.authenticator === 'OAUTH') {
      throw new Error(
        'SnowflakeDestination: authenticator=OAUTH requires accessToken, tokenProvider, or oauthClientId, oauthClientSecret, and oauthTokenUrl.'
      );
    }

    this.throwIfCancelled();
    this.conn = this.createConnection(this.buildConnectionConfig(token));
    try {
      await this.conn.connect();
    } catch (error) {
      throw this.sanitizeError(error);
    }
    if (this.workloadIdentityToken) {
      try {
        assertSnowflakeWorkloadIdentityUsable({
          expiresAt: this.workloadIdentityExpiresAt,
          now: this.now(),
          connection: this.conn,
        });
      } catch (error) {
        await this.conn.destroy().catch(() => undefined);
        this.conn = null;
        throw error;
      }
    }
    if (this.cancelRequested) {
      await this.conn.destroy();
      throw new Error('Snowflake destination cancelled during initialization.');
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) {
      throw new Error('Snowflake destination operation cancelled.');
    }
  }

  private async refreshConnectionIfNeeded(): Promise<void> {
    if (this.workloadIdentityToken) {
      assertSnowflakeWorkloadIdentityUsable({
        expiresAt: this.workloadIdentityExpiresAt,
        now: this.now(),
        connection: this.conn,
      });
      return;
    }
    if (
      this.authenticator !== 'OAUTH' ||
      !this.tokenSource ||
      !this.currentAccessToken ||
      !this.tokenSource.isExpiring(this.currentAccessToken)
    ) {
      return;
    }

    const resolved = await this.tokenSource.getAccessToken(true);
    this.throwIfCancelled();
    if (resolved.accessToken === this.currentAccessToken.accessToken) {
      this.currentAccessToken = resolved;
      return;
    }

    const previous = this.conn;
    const next = this.createConnection(this.buildConnectionConfig(resolved.accessToken));
    try {
      await next.connect();
    } catch (error) {
      throw this.sanitizeError(error);
    }
    if (this.cancelRequested) {
      await next.destroy();
      throw new Error('Snowflake destination cancelled during credential refresh.');
    }
    this.conn = next;
    this.currentAccessToken = resolved;
    this.logger?.info('snowflake_oauth_token_refreshed');
    if (previous && !previous.isClosed()) {
      try {
        await previous.destroy();
      } catch (err) {
        this.logger?.warn('snowflake_oauth_reconnect_close_failed', {
          error: this.sanitizeError(err).message,
        });
      }
    }
  }

  private getConn(): SnowflakeConnectionLike {
    this.throwIfCancelled();
    if (!this.conn) {
      throw new Error('SnowflakeDestination not initialized — call initialize() first');
    }
    return this.conn;
  }

  private tableMaintenanceContext(
    beforeMutation?: () => Promise<void>
  ): SnowflakeTableMaintenanceContext {
    return {
      columnCache: this.columnCache,
      clusterCache: this.clusterCache,
      logger: this.logger,
      throwIfCancelled: () => this.throwIfCancelled(),
      retryOpts: (context) => this.retryOpts(context),
      mapColumnType: mapSnowflakeColumnType,
      normalizeType: normalizeSnowflakeType,
      quoteIdentifier: quoteSnowflakeIdentifier,
      beforeMutation,
    };
  }

  private loadingContext(): SnowflakeLoadContext {
    return {
      refreshConnectionIfNeeded: () => this.refreshConnectionIfNeeded(),
      getConnection: () => this.getConn(),
      throwIfCancelled: () => this.throwIfCancelled(),
      retryOpts: (context) => this.retryOpts(context),
      getOwnershipMarker: (schemaName, tableName) =>
        this.tableOwnershipMarkers.get(`${schemaName}.${tableName}`),
      assertTableOwnership: (conn, qualifiedTable, metadataSchema, metadataTable, marker) =>
        this.assertTableOwnership(conn, qualifiedTable, metadataSchema, metadataTable, marker),
      ensureTable: (schemaName, tableName, columns, options) =>
        this.ensureTable(schemaName, tableName, columns, options),
      isTableTruncated: (key) => this.truncatedTables.has(key),
      markTableTruncated: (key) => this.truncatedTables.add(key),
      logger: this.logger,
      sanitizeError: (error) => this.sanitizeError(error),
      mapColumnType: mapSnowflakeColumnType,
      quoteIdentifier: quoteSnowflakeIdentifier,
      quoteIdentifierPreservingCase: quoteSnowflakeIdentifierPreservingCase,
      quoteStringLiteral: quoteSnowflakeStringLiteral,
      escapeJsonFieldName,
      extractMergeAffectedRows,
    };
  }

  private async readTableMetadata(
    conn: SnowflakeConnectionLike,
    metadataSchema: string,
    metadataTable: string
  ): Promise<SnowflakeTableMetadata> {
    const result = await withRetry(
      () =>
        conn.execute({
          sqlText:
            `SELECT TABLE_NAME, COMMENT FROM ${quoteSnowflakeIdentifier(this.database)}.INFORMATION_SCHEMA.TABLES ` +
            `WHERE TABLE_SCHEMA = '${metadataSchema}' AND TABLE_NAME = '${metadataTable}' LIMIT 1`,
        }),
      this.retryOpts('check_table_ownership')
    );
    const row = result.getRows()[0];
    if (!row) return { exists: false };

    const comment = getSnowflakeMetadataValue(row, 'COMMENT');
    return {
      exists: true,
      comment: comment === undefined || comment === null ? undefined : String(comment),
    };
  }

  private async schemaExists(
    conn: SnowflakeConnectionLike,
    metadataSchema: string
  ): Promise<boolean> {
    const result = await withRetry(
      () =>
        conn.execute({
          sqlText:
            `SELECT SCHEMA_NAME FROM ${quoteSnowflakeIdentifier(this.database)}.INFORMATION_SCHEMA.SCHEMATA ` +
            `WHERE SCHEMA_NAME = '${metadataSchema}' LIMIT 1`,
        }),
      this.retryOpts('check_schema')
    );
    this.throwIfCancelled();
    return result.getRows().length > 0;
  }

  private async assertExistingSchema(
    conn: SnowflakeConnectionLike,
    metadataSchema: string,
    qualifiedSchema: string
  ): Promise<void> {
    if (!(await this.schemaExists(conn, metadataSchema))) {
      throw new CommandError(
        `Snowflake staging schema ${qualifiedSchema} does not exist. Create it before loading; ` +
          'Dogsled does not create administrator-provisioned staging schemas.',
        2
      );
    }
  }

  private async assertTableOwnership(
    conn: SnowflakeConnectionLike,
    qualifiedTable: string,
    metadataSchema: string,
    metadataTable: string,
    marker: string
  ): Promise<void> {
    const metadata = await this.readTableMetadata(conn, metadataSchema, metadataTable);
    this.throwIfCancelled();
    if (!metadata.exists) {
      throw new CommandError(
        `Snowflake table ${qualifiedTable} does not exist while verifying its reserved ownership.`,
        2
      );
    }
    if (metadata.comment !== marker) {
      throw new CommandError(
        `Snowflake table ${qualifiedTable} is not owned by the requested dataset; refusing to mutate it.`,
        2
      );
    }
  }

  private retryOpts(context: string) {
    return {
      maxAttempts: 5,
      retryable: (error: unknown) => !this.workloadIdentityToken && isSnowflakeRetryable(error),
      onRetry: (attempt: number, delay: number, error: Error) => {
        this.logger?.warn(`snowflake_retry`, {
          attempt,
          delay,
          error: this.sanitizeError(error).message,
          context,
        });
      },
    };
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    assertNonEmptyColumns(tableName, columns);
    assertUniqueSnowflakeColumnNames(tableName, columns);
    await this.refreshConnectionIfNeeded();
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    // Snowflake stores unquoted identifiers in uppercase, including the
    // TABLE_SCHEMA/TABLE_NAME values exposed through INFORMATION_SCHEMA.
    // Keep metadata predicates aligned with the quoted target identifiers.
    const cacheKey = `${safeSchema}.${safeTable}`;
    const requestedOwnershipMarker = options?.tableOwnershipMarker;
    if (requestedOwnershipMarker !== undefined) {
      validateSnowflakeTableOwnershipMarker(requestedOwnershipMarker);
    }
    const ownershipMarker = requestedOwnershipMarker ?? this.tableOwnershipMarkers.get(cacheKey);
    const ownerGuarded = ownershipMarker !== undefined;
    // Ordinary Dogsled tables keep the historical case-insensitive quoting
    // behavior. A reserved staging table is an exact external resource: the
    // opaque table token may contain lower-case or mixed-case characters, and
    // Snowflake treats a quoted case change as a different identifier.
    const quoteTargetTable = ownerGuarded
      ? quoteSnowflakeIdentifierPreservingCase
      : quoteSnowflakeIdentifier;
    const metadataSchema = safeSchema.toUpperCase();
    const metadataTable = ownerGuarded ? safeTable : safeTable.toUpperCase();
    const qualifiedSchema = quoteSnowflakeIdentifier(safeSchema);
    const qualifiedTable = `${qualifiedSchema}.${quoteTargetTable(safeTable)}`;
    const assertOwnershipBeforeMutation = async (): Promise<void> => {
      if (ownershipMarker === undefined) return;
      await this.assertTableOwnership(
        conn,
        qualifiedTable,
        metadataSchema,
        metadataTable,
        ownershipMarker
      );
    };

    const readVectorTypes = (existing: Map<string, string>): Promise<void> => {
      const context = this.tableMaintenanceContext();
      return readSnowflakeVectorTypes(context, conn, qualifiedTable, columns, options, existing);
    };

    // A Snowflake full_refresh with the default/evolve contract replaces the
    // table when its schema has drifted, so it must inspect destination
    // metadata on every schema message. Other behaviors retain the existing
    // idempotent cache semantics.
    const effectiveSchemaBehavior = options?.schemaBehavior ?? 'evolve';
    const replaceOnDrift =
      options?.loadStrategy === 'full_refresh' &&
      effectiveSchemaBehavior === 'evolve' &&
      options?.reconcileSchema !== true;
    const cached = replaceOnDrift ? undefined : this.columnCache.get(cacheKey);
    if (cached) {
      if (ownershipMarker !== undefined) {
        await this.assertTableOwnership(
          conn,
          qualifiedTable,
          metadataSchema,
          metadataTable,
          ownershipMarker
        );
      }

      await readVectorTypes(cached);
      const comparison = compareSnowflakeSchema(
        columns,
        cached,
        mapSnowflakeColumnType,
        normalizeSnowflakeType,
        reverseMapDbType
      );
      const { columnsToAdd, columnsToWiden } = enforceContract(options, comparison, qualifiedTable);

      if (columnsToAdd.length > 0) {
        this.throwIfCancelled();
        const newColumnDefs = columnsToAdd.map(
          (col) => `ADD COLUMN ${quoteSnowflakeIdentifier(col.name)} ${mapSnowflakeColumnType(col)}`
        );
        await withRetry(async () => {
          await assertOwnershipBeforeMutation();
          return conn.execute({
            sqlText: `ALTER TABLE ${qualifiedTable} ${newColumnDefs.join(', ')}`,
          });
        }, this.retryOpts('alter_table'));
      }

      for (const conflict of columnsToWiden) {
        this.throwIfCancelled();
        const newSqlType = mapSnowflakeType(conflict.expectedColumnType);
        await withRetry(async () => {
          await assertOwnershipBeforeMutation();
          return conn.execute({
            sqlText: `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteSnowflakeIdentifier(conflict.column)} SET DATA TYPE ${newSqlType}`,
          });
        }, this.retryOpts('alter_column_type'));
      }

      if (options?.reconcileSchema) {
        await reconcileRemovedSnowflakeColumns(
          conn,
          qualifiedTable,
          comparison.removedColumns,
          cached,
          () => this.throwIfCancelled(),
          (context) => this.retryOpts(context),
          quoteSnowflakeIdentifier,
          assertOwnershipBeforeMutation
        );
      }

      // Update cache after changes
      for (const col of columnsToAdd) {
        cached.set(col.name.toUpperCase(), normalizeSnowflakeType(mapSnowflakeColumnType(col)));
      }
      for (const conflict of columnsToWiden) {
        cached.set(
          conflict.column.toUpperCase(),
          normalizeSnowflakeType(mapSnowflakeType(conflict.expectedColumnType))
        );
      }
      if (ownershipMarker !== undefined) {
        this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
      }
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: null,
        partitionSource: 'not_supported',
        clusterColumns: buildClusterColumns(columns, options),
      });

      return;
    }

    if (ownerGuarded) {
      // A reserved staging schema is provisioned by an administrator. In
      // particular, do not turn a missing CREATE SCHEMA privilege into a
      // misleading table-ownership failure or silently create a new schema.
      await this.assertExistingSchema(conn, metadataSchema, qualifiedSchema);
    } else if (!(await this.schemaExists(conn, metadataSchema))) {
      await withRetry(
        () =>
          conn.execute({
            sqlText: `CREATE SCHEMA IF NOT EXISTS ${qualifiedSchema}`,
          }),
        this.retryOpts('create_schema')
      );
      this.throwIfCancelled();
    }

    // Check if table exists by querying INFORMATION_SCHEMA
    const existingResult = await withRetry(
      () =>
        conn.execute({
          sqlText: `SELECT COLUMN_NAME, DATA_TYPE FROM ${quoteSnowflakeIdentifier(this.database)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${metadataSchema}' AND TABLE_NAME = '${metadataTable}' ORDER BY ORDINAL_POSITION`,
        }),
      this.retryOpts('check_table_exists')
    );
    this.throwIfCancelled();
    const existingRows = existingResult.getRows();

    // INFORMATION_SCHEMA.COLUMNS can be empty for an existing table when the
    // session cannot see its columns (for example, a transient metadata
    // visibility gap or a shell table with no user columns). Distinguish that
    // case from a genuinely absent table before creating or caching anything;
    // CREATE TABLE IF NOT EXISTS would no-op and a fictional full schema in
    // the cache would hide the drift on later schema messages.
    let tableExists = existingRows.length > 0;
    if (ownerGuarded) {
      const metadata = await this.readTableMetadata(conn, metadataSchema, metadataTable);
      this.throwIfCancelled();
      tableExists = metadata.exists;
      if (tableExists && metadata.comment !== ownershipMarker) {
        throw new CommandError(
          `Snowflake table ${qualifiedTable} is not owned by the requested dataset; refusing to mutate it.`,
          2
        );
      }
      if (!tableExists && existingRows.length > 0) {
        throw new CommandError(
          `Snowflake table ${qualifiedTable} metadata is inconsistent; refusing to mutate it.`,
          2
        );
      }
    } else if (!tableExists) {
      const tableResult = await withRetry(
        () =>
          conn.execute({
            sqlText: `SELECT TABLE_NAME FROM ${quoteSnowflakeIdentifier(this.database)}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${metadataSchema}' AND TABLE_NAME = '${metadataTable}' LIMIT 1`,
          }),
        this.retryOpts('check_table_exists')
      );
      this.throwIfCancelled();
      tableExists = tableResult.getRows().length > 0;
    }

    if (tableExists && existingRows.length === 0) {
      throw new CommandError(
        `Snowflake table ${qualifiedTable} exists, but INFORMATION_SCHEMA.COLUMNS returned no visible columns. ` +
          'Verify that the loader role can read the table metadata; no schema cache was populated.',
        2
      );
    }

    if (!tableExists) {
      // Table does not exist — create it. For a reserved destination,
      // IF NOT EXISTS and the ownership COMMENT form one atomic collision
      // guard: a concurrent creator leaves its table unchanged, and the
      // metadata check below rejects it before any mutation.
      const colDefs = columns.map(
        (col) => `${quoteSnowflakeIdentifier(col.name)} ${mapSnowflakeColumnType(col)}`
      );
      const systemColDefs = [
        `${quoteSnowflakeIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP_TZ`,
        `${quoteSnowflakeIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP_TZ`,
      ];
      const fullColDefs = [...colDefs, ...systemColDefs].join(', ');
      const ownershipComment =
        ownershipMarker === undefined
          ? ''
          : ` COMMENT = ${quoteSnowflakeStringLiteral(ownershipMarker)}`;

      await withRetry(
        () =>
          conn.execute({
            sqlText: `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${fullColDefs})${ownershipComment}`,
          }),
        this.retryOpts('create_table')
      );
      this.throwIfCancelled();

      if (ownershipMarker !== undefined) {
        await this.assertTableOwnership(
          conn,
          qualifiedTable,
          metadataSchema,
          metadataTable,
          ownershipMarker
        );
        this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
      }

      // Populate column cache
      const columnMap = new Map<string, string>();
      for (const col of columns) {
        columnMap.set(col.name.toUpperCase(), normalizeSnowflakeType(mapSnowflakeColumnType(col)));
      }
      columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase(), 'TIMESTAMP_TZ');
      columnMap.set(SYSTEM_COLUMNS.LOADED_AT.toUpperCase(), 'TIMESTAMP_TZ');
      this.columnCache.set(cacheKey, columnMap);
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: null,
        partitionSource: 'not_supported',
        clusterColumns: buildClusterColumns(columns, options),
      });
      return;
    }

    const clusteringResult = await withRetry(
      () =>
        conn.execute({
          sqlText: `SELECT CLUSTERING_KEY FROM ${quoteSnowflakeIdentifier(this.database)}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${metadataSchema}' AND TABLE_NAME = '${metadataTable}'`,
        }),
      this.retryOpts('get_clustering_key')
    );
    this.throwIfCancelled();
    const currentClustering = parseSnowflakeClusteringKey(
      clusteringResult.getRows()[0]?.['CLUSTERING_KEY']
    );
    this.clusterCache.set(cacheKey, currentClustering);

    // Table exists — build comparison and enforce schema contract
    const existingMap = new Map<string, string>();
    for (const row of existingRows) {
      const colName = String(row['COLUMN_NAME'] ?? '');
      const colType = String(row['DATA_TYPE'] ?? '');
      existingMap.set(colName, colType);
    }
    await readVectorTypes(existingMap);

    const comparison = compareSnowflakeSchema(
      columns,
      existingMap,
      mapSnowflakeColumnType,
      normalizeSnowflakeType,
      reverseMapDbType
    );
    const hasSchemaDrift =
      comparison.newColumns.length > 0 ||
      comparison.removedColumns.length > 0 ||
      comparison.typeConflicts.length > 0 ||
      !existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase()) ||
      !existingMap.has(SYSTEM_COLUMNS.LOADED_AT.toUpperCase());
    if (replaceOnDrift && hasSchemaDrift) {
      const replacementOptions =
        ownershipMarker !== undefined && options?.tableOwnershipMarker === undefined
          ? { ...options, tableOwnershipMarker: ownershipMarker }
          : options;
      if (ownershipMarker !== undefined) {
        // Recheck immediately before CREATE OR REPLACE. Snowflake DDL cannot
        // express a conditional replace on a table COMMENT, so this is the
        // last ownership check before the destructive DDL.
        await this.assertTableOwnership(
          conn,
          qualifiedTable,
          metadataSchema,
          metadataTable,
          ownershipMarker
        );
        this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
      }
      await replaceSnowflakeTable(
        this.tableMaintenanceContext(assertOwnershipBeforeMutation),
        conn,
        qualifiedTable,
        cacheKey,
        safeTable,
        columns,
        replacementOptions
      );
      return;
    }

    const { columnsToAdd, columnsToWiden } = enforceContract(options, comparison, qualifiedTable);

    // Build ALTER TABLE for new columns
    const newColumnDefs: string[] = columnsToAdd.map(
      (col) => `ADD COLUMN ${quoteSnowflakeIdentifier(col.name)} ${mapSnowflakeColumnType(col)}`
    );

    // Ensure system columns exist
    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase())) {
      newColumnDefs.push(
        `ADD COLUMN ${quoteSnowflakeIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP_TZ`
      );
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT.toUpperCase())) {
      newColumnDefs.push(
        `ADD COLUMN ${quoteSnowflakeIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP_TZ`
      );
    }

    if (newColumnDefs.length > 0) {
      this.throwIfCancelled();
      await withRetry(async () => {
        await assertOwnershipBeforeMutation();
        return conn.execute({
          sqlText: `ALTER TABLE ${qualifiedTable} ${newColumnDefs.join(', ')}`,
        });
      }, this.retryOpts('alter_table'));
    }

    // Widen columns one at a time
    for (const conflict of columnsToWiden) {
      this.throwIfCancelled();
      const newSqlType = mapSnowflakeType(conflict.expectedColumnType);
      await withRetry(async () => {
        await assertOwnershipBeforeMutation();
        return conn.execute({
          sqlText: `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteSnowflakeIdentifier(conflict.column)} SET DATA TYPE ${newSqlType}`,
        });
      }, this.retryOpts('alter_column_type'));
    }

    const columnMap = new Map(existingMap);
    if (options?.reconcileSchema) {
      await reconcileRemovedSnowflakeColumns(
        conn,
        qualifiedTable,
        comparison.removedColumns,
        columnMap,
        () => this.throwIfCancelled(),
        (context) => this.retryOpts(context),
        quoteSnowflakeIdentifier,
        assertOwnershipBeforeMutation
      );
    }

    // Update column cache
    for (const col of columnsToAdd) {
      columnMap.set(col.name.toUpperCase(), normalizeSnowflakeType(mapSnowflakeColumnType(col)));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(
        conflict.column.toUpperCase(),
        normalizeSnowflakeType(mapSnowflakeType(conflict.expectedColumnType))
      );
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase(), 'TIMESTAMP_TZ');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT.toUpperCase(), 'TIMESTAMP_TZ');
    this.columnCache.set(cacheKey, columnMap);
    if (ownershipMarker !== undefined) {
      this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
    }

    // Apply clustering — metadata-only + idempotent. Skip if already matching.
    await applySnowflakeClustering(
      this.tableMaintenanceContext(assertOwnershipBeforeMutation),
      conn,
      qualifiedTable,
      cacheKey,
      safeTable,
      columns,
      options
    );
  }

  async loadAndFinalize(
    schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: 'append' | 'merge' | 'full_refresh',
    keyColumns: string[],
    sourceEncoding: BatchEncoding = { format: 'jsonl' }
  ): Promise<LoadResult> {
    return loadSnowflakeAndFinalize(
      this.loadingContext(),
      schemaName,
      tableName,
      filePath,
      columns,
      strategy,
      keyColumns,
      sourceEncoding
    );
  }

  async deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    await this.refreshConnectionIfNeeded();
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const ownershipMarker = this.tableOwnershipMarkers.get(`${safeSchema}.${safeTable}`);
    const metadataSchema = safeSchema.toUpperCase();
    const metadataTable = ownershipMarker === undefined ? safeTable.toUpperCase() : safeTable;
    const quoteTargetTable =
      ownershipMarker === undefined
        ? quoteSnowflakeIdentifier
        : quoteSnowflakeIdentifierPreservingCase;
    const qualifiedTable = `${quoteSnowflakeIdentifier(safeSchema)}.${quoteTargetTable(safeTable)}`;
    const metadata = await this.readTableMetadata(conn, metadataSchema, metadataTable);
    if (!metadata.exists) return;
    // The session runs in autocommit, so each DELETE commits before the next load reads or writes.
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      await withRetry(async () => {
        if (ownershipMarker !== undefined) {
          await this.assertTableOwnership(
            conn,
            qualifiedTable,
            metadataSchema,
            metadataTable,
            ownershipMarker
          );
        }
        return conn.execute({
          sqlText: `DELETE FROM ${qualifiedTable} WHERE ${quoteSnowflakeIdentifier(column)} IN (${batch.map(() => '?').join(', ')})`,
          binds: batch,
        });
      }, this.retryOpts('delete_rows'));
    }
  }

  async loadFromUri(
    schemaName: string,
    tableName: string,
    uris: string[],
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<LoadResult> {
    return loadSnowflakeFromUri(
      this.loadingContext(),
      schemaName,
      tableName,
      uris,
      columns,
      options
    );
  }

  async close(): Promise<void> {
    if (this.conn && !this.conn.isClosed()) {
      try {
        await this.conn.destroy();
      } catch (error) {
        throw this.sanitizeError(error);
      }
    }
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.conn && !this.conn.isClosed()) {
      try {
        await this.conn.destroy();
      } catch (error) {
        throw this.sanitizeError(error);
      }
    }
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }
}
