import { assertDriverVersion } from '@bobsled-inc/connections';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildClusterColumns,
  logTableOptimization,
  resolvePartitionColumn,
  resolvePartitionSource,
  sanitizeSchemaName,
  sanitizeTableName,
  SYSTEM_COLUMNS,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';
import { withRetry, type RetryOptions } from '../retry.js';
import {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  isInvalidCredentialsError,
  type BigQueryTokenProvider,
} from '../bigquery-auth.js';

import { CommandError } from '@bobsled-inc/protocol';
import {
  assertOwnedBigQueryMetadata,
  OWNERSHIP_LABEL,
  validateOwnershipMarker,
} from './bigquery-ownership.js';
import { quoteBqIdentifier } from './bigquery-identifiers.js';
import type { BatchEncoding, SchemaColumn, ColumnType } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { DuckDbWriter } from '../duckdb-writer.js';
import type { GcsStagingManager } from '../gcs-staging.js';
import type { LoaderLogger } from '../logger.js';
import type {
  BigQueryClientLike,
  BigQueryDestinationOptions,
  BigQueryJobLike,
  BigQueryLoadJobResponse,
} from './bigquery-types.js';

export type {
  BigQueryClientLike,
  BigQueryDatasetLike,
  BigQueryDestinationOptions,
  BigQueryJobLike,
  BigQueryLoadJobResponse,
  BigQueryTableLike,
} from './bigquery-types.js';

/** Normalize BigQuery type aliases to canonical forms for comparison. */
function normalizeBqType(t: string): string {
  switch (t.toUpperCase()) {
    case 'INTEGER':
      return 'INT64';
    case 'FLOAT':
      return 'FLOAT64';
    case 'BOOLEAN':
      return 'BOOL';
    default:
      return t.toUpperCase();
  }
}

export function mapBigQueryType(column: ColumnType | SchemaColumn): string {
  const type = typeof column === 'string' ? column : column.type;
  switch (type) {
    case 'integer':
      return 'INT64';
    case 'number':
      return 'FLOAT64';
    case 'boolean':
      return 'BOOL';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'string':
    case 'array':
    case 'object':
      return 'STRING';
    case 'vector':
      return 'ARRAY<FLOAT64>';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

export function buildBigQuerySchemaField(column: SchemaColumn): {
  name: string;
  mode?: 'NULLABLE' | 'REPEATED';
  type: string;
} {
  if (column.type === 'vector') {
    return { name: column.name, type: 'FLOAT64', mode: 'REPEATED' };
  }

  return { name: column.name, type: mapBigQueryType(column), mode: 'NULLABLE' };
}

function getExistingBigQueryType(field: { mode?: string; type: string }): string {
  const normalizedType = normalizeBqType(field.type);
  if (field.mode?.toUpperCase() === 'REPEATED' && normalizedType === 'FLOAT64') {
    return 'ARRAY<FLOAT64>';
  }

  return normalizedType;
}

function throwOnLoadErrors(job: BigQueryLoadJobResponse, context: string): void {
  const errors = job.status?.errors;
  if (errors && errors.length > 0) {
    throw new Error(`BigQuery ${context}: ${errors.map((e) => e.message).join(', ')}`);
  }
}

export class BigQueryDestination implements DatabaseDestination {
  private readonly projectId?: string;
  private readonly datasetId: string;
  private readonly location?: string;
  private readonly keyFilename?: string;
  private readonly credentials?: Record<string, unknown>;
  private readonly accessToken?: string;
  private readonly tokenProvider?: BigQueryTokenProvider;
  private readonly tokenSource?: RefreshableTokenSource;
  private cachedAuthClient?: unknown;
  private readonly stagingFormat: 'parquet' | 'jsonl';
  private readonly tempDir?: string;
  private readonly gcsStagingBucket?: string;
  private readonly gcsStagingPrefix?: string;
  private readonly logger?: LoaderLogger;
  private cachedClient?: BigQueryClientLike;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  private partitionColumnCache = new Map<string, string>();
  private tableOwnershipMarkers = new Map<string, string>();
  private duckDbWriter?: DuckDbWriter;
  private gcsStagingManager?: GcsStagingManager;
  private readonly activeJobs = new Set<BigQueryJobLike>();
  private cancelRequested = false;

  constructor(options: BigQueryDestinationOptions) {
    this.projectId = options.projectId;
    this.datasetId = options.datasetId;
    this.location = options.location;
    this.keyFilename = options.keyFilename;
    this.credentials = options.credentials;
    this.accessToken = options.accessToken;
    this.tokenProvider = options.tokenProvider;
    if (options.tokenProvider) {
      this.tokenSource = new RefreshableTokenSource(options.tokenProvider);
    }
    this.stagingFormat = options.stagingFormat ?? 'parquet';
    this.tempDir = options.tempDir;
    this.gcsStagingBucket = options.gcsStagingBucket;
    this.gcsStagingPrefix = options.gcsStagingPrefix;
    this.logger = options.logger;
    if (options.client) {
      this.cachedClient = options.client;
    }
  }

  private async getClient(): Promise<BigQueryClientLike> {
    if (this.cachedClient) {
      return this.cachedClient;
    }

    assertDriverVersion('@google-cloud/bigquery', '8.1.1', createRequire(import.meta.url));
    try {
      const module = await import('@google-cloud/bigquery');
      // Auth precedence: accessToken (OAuth Temporary Token) > credentials
      // (parsed JSON object) > keyFilename (file path) > ADC fallback.
      //
      // The @google-cloud/bigquery SDK accepts `authClient` (an
      // `AuthClient` instance) — there is no `token` field on
      // `BigQueryOptions`. To ship a pre-minted access token we build
      // an `OAuth2Client`, seed its credentials, and pass it as
      // `authClient`. Mirrors dbt-bigquery's `oauth-secrets` method
      // (which performs the equivalent dance in Python via
      // `google.oauth2.credentials.Credentials(token=...)`).
      let authOpts: Record<string, unknown>;
      if (this.tokenProvider) {
        // Refreshable token: a custom AuthClient that re-fetches proactively and
        // reactively. Shared with the GCS staging Storage client so both refresh.
        authOpts = { authClient: await this.getAuthClient() };
      } else if (this.accessToken) {
        const { OAuth2Client } = await import('google-auth-library');
        const oauthClient = new OAuth2Client();
        oauthClient.setCredentials({ access_token: this.accessToken });
        authOpts = { authClient: oauthClient };
      } else if (this.credentials) {
        authOpts = { credentials: this.credentials };
      } else if (this.keyFilename) {
        authOpts = { keyFilename: this.keyFilename };
      } else {
        authOpts = {};
      }
      this.cachedClient = new module.BigQuery({
        projectId: this.projectId,
        location: this.location,
        ...authOpts,
      }) as BigQueryClientLike;
      return this.cachedClient;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load @google-cloud/bigquery. Install it to use --dest bigquery. ${message}`
      );
    }
  }

  /**
   * Lazily build (and cache) the refreshable google-auth `AuthClient`. Shared
   * between the BigQuery SDK client and the GCS staging Storage client so a
   * single token refresh covers both.
   */
  private async getAuthClient(): Promise<unknown> {
    if (this.cachedAuthClient) {
      return this.cachedAuthClient;
    }
    if (!this.tokenSource) {
      throw new Error('getAuthClient called without a tokenProvider');
    }
    const { OAuth2Client } = await import('google-auth-library');
    this.cachedAuthClient = createRefreshableAuthClient({
      tokenSource: this.tokenSource,
      OAuth2Client,
    });
    return this.cachedAuthClient;
  }

  /**
   * Reactive auth backstop: if an operation fails with a 401 / "Invalid
   * Credentials" and a refreshable token provider is configured, force a token
   * refresh and retry the operation exactly once. When no provider is set this
   * is a transparent pass-through (zero behavior change for static-token,
   * SA-key, and ADC paths). Proactive refresh (the main fix) happens inside the
   * AuthClient's per-request `getRequestHeaders()`; this only covers the rare
   * window where a token expired between the skew check and the request.
   */
  private async authRetry<T>(op: () => Promise<T>): Promise<T> {
    this.throwIfCancelled();
    if (!this.tokenSource) {
      return op();
    }
    try {
      return await op();
    } catch (error) {
      if (!isInvalidCredentialsError(error)) {
        throw error;
      }
      this.logger?.warn('bq_auth_force_refresh', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.tokenSource.getToken(true);
      this.throwIfCancelled();
      return op();
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) {
      throw new Error('BigQuery destination operation cancelled.');
    }
  }

  /**
   * Compose the existing transient-error retry (`withRetry`) over the reactive
   * auth backstop. All BigQuery/GCS operations route through here.
   */
  private bqRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
    return withRetry(() => {
      this.throwIfCancelled();
      return this.authRetry(fn);
    }, opts);
  }

  /**
   * Poll a job's results through the same transient + auth retry as job
   * submission. Long-running DDL/MERGE/UPDATE jobs poll for completion, and a
   * token can expire between submission and the polling request — so the poll
   * must also force-refresh on a 401, not just the submission.
   */
  private async waitForJob(job: BigQueryJobLike): Promise<Record<string, unknown>[]> {
    this.activeJobs.add(job);
    try {
      await this.cancelLateJob(job, async () => {
        await job.getQueryResults();
      });
      return await this.bqRetry(() => job.getQueryResults().then(([result]) => result));
    } finally {
      this.activeJobs.delete(job);
    }
  }

  /**
   * Wait for a load/copy/extract job through the Job operation poller. Unlike
   * getQueryResults(), this is valid for non-query jobs and still leaves the
   * concrete Job reachable by cancel().
   */
  private async waitForLoadJob(job: BigQueryJobLike): Promise<void> {
    this.activeJobs.add(job);
    try {
      if (!job.promise) {
        await job.cancel?.().catch((error: unknown) => {
          throw new Error(
            'BigQuery load job does not expose promise(), and cancelling the submitted job failed.',
            { cause: error }
          );
        });
        throw new Error('BigQuery load job does not expose promise().');
      }
      await this.cancelLateJob(job, async () => {
        await job.promise!();
      });
      await job.promise();
      this.throwIfCancelled();
    } finally {
      this.activeJobs.delete(job);
    }
  }

  private async settleJob(job: BigQueryJobLike): Promise<void> {
    if (job.promise) {
      await job.promise();
      return;
    }
    if (job.getQueryResults) {
      await job.getQueryResults();
      return;
    }
    throw new Error('BigQuery job does not expose a terminal settlement method.');
  }

  /**
   * cancel() can run before an asynchronously-created Job handle exists. When
   * that late handle appears, acknowledge cancellation here. If the driver
   * rejects (or lacks) cancel(), wait for terminal settlement before returning
   * the error so no remote job is silently orphaned.
   */
  private async cancelLateJob(job: BigQueryJobLike, settle: () => Promise<void>): Promise<void> {
    if (!this.cancelRequested) return;
    if (!job.cancel) {
      await settle().catch(() => undefined);
      throw new Error('BigQuery job does not expose cancel().');
    }
    try {
      await job.cancel();
    } catch (error) {
      await settle().catch(() => undefined);
      throw error;
    }
    await settle().catch(() => undefined);
    throw new Error('BigQuery destination operation cancelled.');
  }

  /**
   * Convert a JSONL file to Parquet using DuckDB. Lazy-inits the DuckDbWriter.
   * Returns the path to the generated Parquet file.
   *
   * When columns are provided, DuckDB uses explicit types (no autodetect),
   * ensuring system columns like _time_extracted are typed as TIMESTAMP
   * in the Parquet output — required by BigQuery DAY partitioning.
   */
  private async convertToParquet(jsonlPath: string, columns?: SchemaColumn[]): Promise<string> {
    if (!this.duckDbWriter) {
      const { createDuckDbWriter } = await import('../duckdb-writer.js');
      this.duckDbWriter = await createDuckDbWriter();
    }
    const parquetPath = jsonlPath.replace(/\.jsonl$/, '.parquet');
    // If no .jsonl extension, append .parquet
    const outputPath = parquetPath === jsonlPath ? `${jsonlPath}.parquet` : parquetPath;

    // Augment user columns with _time_extracted so DuckDB types it as TIMESTAMP
    // in the Parquet output. _dogsled_loaded_at is NOT in the JSONL — it's set
    // by the database at load time, so we must not include it here.
    const allColumns: SchemaColumn[] | undefined = columns
      ? [...columns, { name: SYSTEM_COLUMNS.TIME_EXTRACTED, type: 'timestamp' }]
      : undefined;

    await this.duckDbWriter.convertFile({
      sourcePath: jsonlPath,
      outputPath,
      format: 'parquet',
      columns: allColumns,
    });
    return outputPath;
  }

  /**
   * Lazy-init and return the GCS staging manager.
   */
  private async getGcsStagingManager(): Promise<GcsStagingManager> {
    if (!this.gcsStagingManager) {
      const { GcsStagingManager: GcsStagingManagerClass } = await import('../gcs-staging.js');
      this.gcsStagingManager = new GcsStagingManagerClass({
        bucket: this.gcsStagingBucket!,
        prefix: this.gcsStagingPrefix,
        // Share the refreshing credential so staging uploads refresh too.
        authClient: this.tokenProvider ? await this.getAuthClient() : undefined,
      });
    }
    return this.gcsStagingManager;
  }

  /**
   * Prepare a file for BigQuery load: optionally convert to Parquet and/or
   * upload to GCS. Returns the source path/URI and the sourceFormat for the load job.
   */
  private async prepareForLoad(
    filePath: string,
    sourceEncoding: BatchEncoding,
    columns?: SchemaColumn[]
  ): Promise<{ loadSource: string; sourceFormat: string; tempParquetPath?: string }> {
    let currentPath = filePath;
    let sourceFormat = sourceEncoding.format === 'parquet' ? 'PARQUET' : 'NEWLINE_DELIMITED_JSON';
    let tempParquetPath: string | undefined;

    if (sourceEncoding.format === 'jsonl' && this.stagingFormat === 'parquet') {
      const convertStart = performance.now();
      currentPath = await this.convertToParquet(filePath, columns);
      tempParquetPath = currentPath;
      sourceFormat = 'PARQUET';
      this.logger?.metric('buffer_flush_ms', performance.now() - convertStart, {
        stage: 'parquet_convert',
      });
    }

    // Upload to GCS if configured
    if (this.gcsStagingBucket) {
      const uploadStart = performance.now();
      const manager = await this.getGcsStagingManager();
      const remoteName = path.basename(currentPath);
      const gcsUri = await this.bqRetry(() => manager.upload(currentPath, remoteName));
      this.logger?.metric('staging_upload_ms', performance.now() - uploadStart, {
        bucket: this.gcsStagingBucket,
      });
      // Clean up local Parquet temp file after GCS upload
      if (tempParquetPath) {
        await fs.rm(tempParquetPath, { force: true });
        tempParquetPath = undefined;
      }
      return { loadSource: gcsUri, sourceFormat };
    }

    return { loadSource: currentPath, sourceFormat, tempParquetPath };
  }

  async initialize(): Promise<void> {
    const client = await this.getClient();
    const dataset = client.dataset(this.datasetId);
    const [exists] = await this.bqRetry(() => dataset.exists());
    if (!exists) {
      await this.bqRetry(() => dataset.create());
    }
  }

  private async assertOwnedTable(schemaName: string, tableName: string): Promise<void> {
    const marker = this.tableOwnershipMarkers.get(`${schemaName}.${tableName}`);
    if (marker === undefined) return;
    const table = (await this.getClient()).dataset(schemaName).table(tableName);
    const [exists] = await this.bqRetry(() => table.exists());
    if (!exists) throw new CommandError('Reserved BigQuery table is missing.', 2);
    const [metadata] = await this.bqRetry(() => table.getMetadata());
    assertOwnedBigQueryMetadata(metadata, marker);
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    // Defense-in-depth: validate schema name even if caller already sanitized
    const safeSchema = sanitizeSchemaName(schemaName);
    const client = await this.getClient();
    const safeTable = sanitizeTableName(tableName);
    const cacheKey = `${safeSchema}.${safeTable}`;
    const ownershipMarker =
      options?.tableOwnershipMarker ?? this.tableOwnershipMarkers.get(cacheKey);
    if (ownershipMarker !== undefined) {
      validateOwnershipMarker(ownershipMarker);
      this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
    }

    // Check column cache — reuse cached column types to avoid API calls
    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      await this.assertOwnedTable(safeSchema, safeTable);
      // Defense-in-depth: the partition column cache is always set on the first
      // ensureTable call (from CREATE or metadata read). This fallback should never
      // fire, but guards against the merge partition-limit check using an undefined
      // column if the cache were somehow cleared between calls.
      if (!this.partitionColumnCache.has(cacheKey)) {
        this.partitionColumnCache.set(cacheKey, resolvePartitionColumn(columns, options));
      }
      const qualifiedTable = `${quoteBqIdentifier(safeSchema)}.${quoteBqIdentifier(safeTable)}`;

      // Build comparison from cached types
      const systemColumnNames: Set<string> = new Set([
        SYSTEM_COLUMNS.TIME_EXTRACTED,
        SYSTEM_COLUMNS.LOADED_AT,
      ]);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = cachedColumns.get(col.name);
        const expectedType = mapBigQueryType(col);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (normalizeBqType(existingType) !== normalizeBqType(expectedType)) {
          typeConflicts.push({
            column: col.name,
            existingType: existingType,
            expectedType: expectedType,
            existingColumnType: reverseMapDbType(existingType),
            expectedColumnType: col.type,
          });
        }
      }

      for (const existingName of cachedColumns.keys()) {
        if (!requestedNames.has(existingName) && !systemColumnNames.has(existingName)) {
          removedColumns.push(existingName);
        }
      }

      const comparison: SchemaComparisonResult = { newColumns, removedColumns, typeConflicts };
      const { columnsToAdd, columnsToWiden } = enforceSchemaContract(
        options?.schemaBehavior,
        comparison,
        qualifiedTable
      );

      if (columnsToAdd.length > 0) {
        const newColumnDefs = columnsToAdd.map(
          (col) => `ADD COLUMN ${quoteBqIdentifier(col.name)} ${mapBigQueryType(col)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.join(', ')}`;
        const [job] = await this.bqRetry(() =>
          client.createQueryJob({ query: ddl, location: this.location })
        );
        await this.waitForJob(job);
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapBigQueryType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteBqIdentifier(conflict.column)} SET DATA TYPE ${newSqlType}`;
        const [job] = await this.bqRetry(() =>
          client.createQueryJob({ query: widenDdl, location: this.location })
        );
        await this.waitForJob(job);
      }

      // Update cache after changes
      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapBigQueryType(col));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapBigQueryType(conflict.expectedColumnType));
      }

      return;
    }

    const dataset = client.dataset(safeSchema);
    const table = dataset.table(safeTable);
    const qualifiedTable = `${quoteBqIdentifier(safeSchema)}.${quoteBqIdentifier(safeTable)}`;

    const [exists] = await this.bqRetry(() => table.exists());
    if (!exists) {
      const colDefs = [
        ...columns.map((c) => `${quoteBqIdentifier(c.name)} ${mapBigQueryType(c)}`),
        `${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`,
        `${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP()`,
      ];
      let ddl = `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`;

      // Partition by resolved column: explicit partition_by > timestamp cursor_field > _time_extracted
      const partitionCol = resolvePartitionColumn(columns, options);
      ddl += ` PARTITION BY DATE(${quoteBqIdentifier(partitionCol)})`;

      // Cache resolved partition column for the merge partition-limit check
      this.partitionColumnCache.set(cacheKey, partitionCol);

      // Auto-cluster: cursor_field first, then key_properties (up to 4)
      // Exclude the partition column from clustering (BigQuery silently ignores it but the DDL is confusing)
      const clusterCols = buildClusterColumns(columns, options).filter(
        (col) => col !== partitionCol
      );
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: partitionCol,
        partitionSource: resolvePartitionSource(options),
        clusterColumns: clusterCols,
      });
      if (clusterCols.length > 0) {
        ddl += ` CLUSTER BY ${clusterCols.map(quoteBqIdentifier).join(', ')}`;
      }

      if (ownershipMarker !== undefined) {
        ddl += ` OPTIONS(labels=[("${OWNERSHIP_LABEL}", "${ownershipMarker}")])`;
      }

      const [job] = await this.bqRetry(() =>
        client.createQueryJob({ query: ddl, location: this.location })
      );
      await this.waitForJob(job);
      await this.assertOwnedTable(safeSchema, safeTable);

      if (ownershipMarker !== undefined) {
        // CREATE TABLE IF NOT EXISTS may have selected a concurrent table. Read its
        // physical schema before caching columns or allowing the load to continue.
        return this.ensureTable(safeSchema, safeTable, columns, options);
      }

      // Populate column cache after successful creation
      const columnMap = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapBigQueryType(c)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP'],
        [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP'],
      ]);
      this.columnCache.set(cacheKey, columnMap);
      return;
    }

    // Table exists — check for schema evolution
    const [metadata] = await this.bqRetry(() => table.getMetadata());
    if (ownershipMarker !== undefined) assertOwnedBigQueryMetadata(metadata, ownershipMarker);
    const existingFields = metadata.schema?.fields ?? [];
    const existingMap = new Map(existingFields.map((f) => [f.name, getExistingBigQueryType(f)]));

    // Read actual partition column from table metadata — cannot be ALTERed,
    // so the physical table may differ from the resolved column
    const actualPartitionCol = metadata.timePartitioning?.field ?? SYSTEM_COLUMNS.TIME_EXTRACTED;
    const availableCols = new Set([
      ...columns.map((c) => c.name),
      SYSTEM_COLUMNS.TIME_EXTRACTED,
      SYSTEM_COLUMNS.LOADED_AT,
    ]);
    if (!availableCols.has(actualPartitionCol)) {
      throw new CommandError(
        `Existing table ${qualifiedTable} is partitioned by '${actualPartitionCol}', but that column is no longer present in the incoming schema. Recreate the table or restore the partition column.`,
        2
      );
    }
    this.partitionColumnCache.set(cacheKey, actualPartitionCol);

    // Build schema comparison
    const systemColumnNames: Set<string> = new Set([
      SYSTEM_COLUMNS.TIME_EXTRACTED,
      SYSTEM_COLUMNS.LOADED_AT,
    ]);
    const newColumns: SchemaColumn[] = [];
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
    const requestedNames = new Set(columns.map((c) => c.name));
    const removedColumns: string[] = [];

    for (const col of columns) {
      const existingType = existingMap.get(col.name);
      const expectedType = mapBigQueryType(col);

      if (existingType === undefined) {
        newColumns.push(col);
      } else if (normalizeBqType(existingType) !== normalizeBqType(expectedType)) {
        typeConflicts.push({
          column: col.name,
          existingType: existingType,
          expectedType: expectedType,
          existingColumnType: reverseMapDbType(existingType),
          expectedColumnType: col.type,
        });
      }
    }

    for (const existingName of existingMap.keys()) {
      if (!requestedNames.has(existingName) && !systemColumnNames.has(existingName)) {
        removedColumns.push(existingName);
      }
    }

    const comparison: SchemaComparisonResult = { newColumns, removedColumns, typeConflicts };
    const { columnsToAdd, columnsToWiden } = enforceSchemaContract(
      options?.schemaBehavior,
      comparison,
      qualifiedTable
    );

    // Build DDL for new columns
    const newColumnDefs: string[] = columnsToAdd.map(
      (col) => `${quoteBqIdentifier(col.name)} ${mapBigQueryType(col)}`
    );

    // Ensure system columns exist
    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      newColumnDefs.push(`${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`);
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      newColumnDefs.push(
        `${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP()`
      );
    }

    // Batch all new columns into a single ALTER TABLE statement
    if (newColumnDefs.length > 0) {
      const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
      const [job] = await this.bqRetry(() =>
        client.createQueryJob({ query: ddl, location: this.location })
      );
      await this.waitForJob(job);
    }

    // Widen columns one at a time
    for (const conflict of columnsToWiden) {
      const newSqlType = mapBigQueryType(conflict.expectedColumnType);
      const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteBqIdentifier(conflict.column)} SET DATA TYPE ${newSqlType}`;
      const [job] = await this.bqRetry(() =>
        client.createQueryJob({ query: widenDdl, location: this.location })
      );
      await this.waitForJob(job);
    }

    // Update column cache
    const columnMap = new Map<string, string>(existingMap);
    for (const col of columnsToAdd) {
      columnMap.set(col.name, mapBigQueryType(col));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(conflict.column, mapBigQueryType(conflict.expectedColumnType));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP');
    this.columnCache.set(cacheKey, columnMap);

    // Update clustering if different (safe — BigQuery re-clusters in background)
    // Uses metadata API since ALTER TABLE SET OPTIONS doesn't support clustering_columns
    // Exclude partition column from clustering
    const desiredClustering = buildClusterColumns(columns, options).filter(
      (col) => col !== actualPartitionCol
    );
    logTableOptimization(this.logger, {
      stream: safeTable,
      partitionColumn: actualPartitionCol,
      partitionSource:
        metadata.timePartitioning?.field !== undefined
          ? 'existing_table'
          : resolvePartitionSource(options),
      clusterColumns: desiredClustering,
    });
    const currentClustering = metadata.clustering?.fields ?? [];
    if (
      desiredClustering.length > 0 &&
      JSON.stringify(currentClustering) !== JSON.stringify(desiredClustering)
    ) {
      // Re-fetch metadata if schema was altered — ALTER TABLE invalidates the etag,
      // causing setMetadata to fail with 412 Precondition Failed
      const schemaChanged = columnsToAdd.length > 0 || columnsToWiden.length > 0;
      const baseMetadata = schemaChanged
        ? (await this.bqRetry(() => table.getMetadata()))[0]
        : metadata;
      await this.bqRetry(() =>
        table.setMetadata({ ...baseMetadata, clustering: { fields: desiredClustering } })
      );
    }
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
    const client = await this.getClient();
    // Defense-in-depth: validate schema name even if caller already sanitized
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    await this.assertOwnedTable(safeSchema, safeTable);
    const dataset = client.dataset(safeSchema);

    const qualifiedTarget = `${quoteBqIdentifier(safeSchema)}.${quoteBqIdentifier(safeTable)}`;

    if (strategy === 'append' || strategy === 'full_refresh') {
      const table = dataset.table(safeTable);
      let writeDisposition: 'WRITE_APPEND' | 'WRITE_TRUNCATE' = 'WRITE_APPEND';

      if (strategy === 'full_refresh') {
        const qualifiedKey = `${safeSchema}.${safeTable}`;
        const alreadyTruncated = this.truncatedTables.has(qualifiedKey);
        writeDisposition = alreadyTruncated ? 'WRITE_APPEND' : 'WRITE_TRUNCATE';
        if (!alreadyTruncated) {
          this.truncatedTables.add(qualifiedKey);
        }
      }

      const { loadSource, sourceFormat, tempParquetPath } = await this.prepareForLoad(
        filePath,
        sourceEncoding,
        columns
      );

      try {
        const loadStart = performance.now();
        await this.assertOwnedTable(safeSchema, safeTable);
        const metadata = {
          sourceFormat,
          writeDisposition,
          ...(writeDisposition === 'WRITE_APPEND'
            ? { schemaUpdateOptions: ['ALLOW_FIELD_ADDITION'] }
            : {}),
          ...(sourceFormat === 'PARQUET' ? { parquetOptions: { enableListInference: true } } : {}),
          schema: {
            fields: [
              ...columns.map((column) => buildBigQuerySchemaField(column)),
              { name: SYSTEM_COLUMNS.TIME_EXTRACTED, type: 'TIMESTAMP' },
              { name: SYSTEM_COLUMNS.LOADED_AT, type: 'TIMESTAMP' },
            ],
          },
        };
        let job: BigQueryLoadJobResponse;
        if (table.createLoadJob) {
          const [loadJob] = await this.bqRetry(() => table.createLoadJob!(loadSource, metadata), {
            onRetry: (attempt, delay, error) => {
              this.logger?.warn('load_job_retry', {
                attempt,
                delay,
                error: error.message,
                stream: safeTable,
              });
            },
          });
          await this.waitForLoadJob(loadJob);
          const [loadMetadata] = loadJob.getMetadata
            ? await this.bqRetry(() => loadJob.getMetadata!())
            : [loadJob.metadata];
          job = {
            status: loadMetadata?.status ?? {},
            statistics: loadMetadata?.statistics,
          };
        } else {
          [job] = await this.bqRetry(() => table.load(loadSource, metadata), {
            onRetry: (attempt, delay, error) => {
              this.logger?.warn('load_job_retry', {
                attempt,
                delay,
                error: error.message,
                stream: safeTable,
              });
            },
          });
        }
        this.logger?.metric('load_job_ms', performance.now() - loadStart, { stream: safeTable });

        throwOnLoadErrors(job, 'load job errors');

        // BigQuery column DEFAULT CURRENT_TIMESTAMP() is NOT applied by load jobs,
        // only by DML. Backfill NULL values after successful load.
        const [updateJob] = await this.bqRetry(() =>
          dataset.createQueryJob({
            query: `UPDATE ${qualifiedTarget} SET ${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = CURRENT_TIMESTAMP() WHERE ${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} IS NULL`,
            location: this.location,
          })
        );
        await this.waitForJob(updateJob);

        const rowsAffected = parseInt(job.statistics?.load?.outputRows ?? '0', 10);
        return { rowsAffected };
      } finally {
        if (tempParquetPath) {
          await fs.rm(tempParquetPath, { force: true });
        }
        // Clean up GCS staging file immediately after load completes
        if (this.gcsStagingBucket && loadSource.startsWith('gs://')) {
          try {
            const manager = await this.getGcsStagingManager();
            const remoteName = path.basename(loadSource);
            await manager.cleanup(remoteName);
          } catch (cleanupErr) {
            // Best-effort cleanup — cleanupAll in close() is the safety net
            this.logger?.warn('gcs_staging_cleanup_failed', {
              file: path.basename(loadSource),
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
        }
      }
    }

    // Merge mode — keyColumns must be non-empty
    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const stagingName = `_dogsled_stg_${safeTable}_${randomUUID().replaceAll('-', '')}`;
    const stagingTable = dataset.table(stagingName);
    const qualifiedStaging = `${quoteBqIdentifier(safeSchema)}.${quoteBqIdentifier(stagingName)}`;

    const { loadSource, sourceFormat, tempParquetPath } = await this.prepareForLoad(
      filePath,
      sourceEncoding,
      columns
    );

    try {
      // Load into staging with explicit schema (not autodetect) for consistency with target
      const loadStart = performance.now();
      const [loadJob] = await this.bqRetry(
        () =>
          stagingTable.load(loadSource, {
            sourceFormat,
            writeDisposition: 'WRITE_TRUNCATE',
            // Without enableListInference, vector columns encoded as Parquet
            // 3-level LIST land as STRUCT<repeated element> instead of REPEATED,
            // so MERGE pulls in empty arrays for every row.
            ...(sourceFormat === 'PARQUET'
              ? { parquetOptions: { enableListInference: true } }
              : {}),
            // Parquet carries its own schema; explicit schema only needed for JSONL
            ...(sourceFormat === 'NEWLINE_DELIMITED_JSON'
              ? {
                  schema: {
                    fields: [
                      ...columns.map((c) => buildBigQuerySchemaField(c)),
                      { name: SYSTEM_COLUMNS.TIME_EXTRACTED, type: 'TIMESTAMP' },
                    ],
                  },
                }
              : {}),
          }),
        {
          onRetry: (attempt, delay, error) => {
            this.logger?.warn('staging_load_retry', {
              attempt,
              delay,
              error: error.message,
              stream: safeTable,
            });
          },
        }
      );
      this.logger?.metric('load_job_ms', performance.now() - loadStart, {
        stream: safeTable,
        phase: 'staging',
      });

      throwOnLoadErrors(loadJob, 'staging load errors');

      // Set a 1-hour expiration so the staging table is auto-dropped if cleanup fails
      await this.bqRetry(() =>
        stagingTable.setMetadata({
          expirationTime: String(Date.now() + 3_600_000),
        })
      );

      // Staging MIN/MAX partition dates, used only to warn when a batch risks
      // BigQuery's per-job partition modification limit. The span is a lower
      // bound: updated target rows can sit in other partitions. The dates must
      // never bound the MERGE target: see the ON clause below.
      const partCol =
        this.partitionColumnCache.get(`${safeSchema}.${safeTable}`) ??
        SYSTEM_COLUMNS.TIME_EXTRACTED;
      const [minMaxDateJob] = await this.bqRetry(() =>
        dataset.createQueryJob({
          query: `SELECT FORMAT_DATE('%Y-%m-%d', DATE(MIN(${quoteBqIdentifier(partCol)}))) AS min_date, FORMAT_DATE('%Y-%m-%d', DATE(MAX(${quoteBqIdentifier(partCol)}))) AS max_date FROM ${qualifiedStaging}`,
          location: this.location,
        })
      );
      const minMaxDateRows = await this.waitForJob(minMaxDateJob);
      const rawMinDate =
        typeof minMaxDateRows[0]?.['min_date'] === 'string' ? minMaxDateRows[0]['min_date'] : null;
      const rawMaxDate =
        typeof minMaxDateRows[0]?.['max_date'] === 'string' ? minMaxDateRows[0]['max_date'] : null;
      // Validate date format to prevent SQL injection — only allow YYYY-MM-DD literals
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const minDate = rawMinDate !== null && datePattern.test(rawMinDate) ? rawMinDate : null;
      const maxDate = rawMaxDate !== null && datePattern.test(rawMaxDate) ? rawMaxDate : null;
      if (minDate && maxDate) {
        const minTime = Date.parse(`${minDate}T00:00:00Z`);
        const maxTime = Date.parse(`${maxDate}T00:00:00Z`);
        if (Number.isFinite(minTime) && Number.isFinite(maxTime)) {
          const spanDays = Math.floor((maxTime - minTime) / 86_400_000) + 1;
          if (spanDays > 4_000) {
            this.logger?.warn('partition_limit_risk', {
              stream: safeTable,
              partitionColumn: partCol,
              minDate,
              maxDate,
              spanDays,
            });
          }
        }
      }

      // Build MERGE statement with QUALIFY dedup
      const dataCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
      const allCols = [...dataCols, SYSTEM_COLUMNS.LOADED_AT];
      const colList = allCols.map(quoteBqIdentifier).join(', ');
      const keyColList = keyColumns.map(quoteBqIdentifier).join(', ');

      // Match on keys only. A key's existing row can live in any partition: the
      // _time_extracted fallback changes every load and cursor or partition_by
      // values can move forward, so bounding T by the staging batch's partition
      // dates hides those rows and every update is inserted as a duplicate.
      // On-demand MERGE billing already covers only the partitions it updates;
      // the unpruned scan adds just the key and _time_extracted columns.
      const onClause = keyColumns
        .map((k) => `T.${quoteBqIdentifier(k)} = S.${quoteBqIdentifier(k)}`)
        .join(' AND ');

      const updateSet = allCols
        .filter((c) => !keyColumns.includes(c))
        .map((c) => `${quoteBqIdentifier(c)} = S.${quoteBqIdentifier(c)}`)
        .join(', ');

      const insertVals = allCols.map((c) => `S.${quoteBqIdentifier(c)}`).join(', ');

      // Select data columns from staging + CURRENT_TIMESTAMP() for _dogsled_loaded_at
      const dataColList = dataCols.map(quoteBqIdentifier).join(', ');
      // Tiebreaker: _dogsled_loaded_at provides cross-batch ordering (newer batches win).
      // Within a single batch, CURRENT_TIMESTAMP() is constant so ties remain non-deterministic.
      const usingClause = `USING (SELECT ${dataColList}, CURRENT_TIMESTAMP() AS ${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} FROM ${qualifiedStaging} QUALIFY ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST, ${quoteBqIdentifier(SYSTEM_COLUMNS.LOADED_AT)} DESC NULLS LAST) = 1) S`;

      const timeGuard = `(S.${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= T.${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR T.${quoteBqIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;
      const mergeSql = updateSet
        ? `MERGE ${qualifiedTarget} T ${usingClause} ON ${onClause} ` +
          `WHEN MATCHED AND ${timeGuard} THEN UPDATE SET ${updateSet} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`
        : `MERGE ${qualifiedTarget} T ${usingClause} ON ${onClause} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`;

      const mergeStart = performance.now();
      const [mergeJob] = await this.bqRetry(
        () =>
          client.createQueryJob({
            query: mergeSql,
            location: this.location,
            labels: { dogsled_stream: safeTable, dogsled_strategy: strategy },
          }),
        {
          onRetry: (attempt, delay, error) => {
            this.logger?.warn('merge_retry', {
              attempt,
              delay,
              error: error.message,
              stream: safeTable,
            });
          },
        }
      );
      await this.waitForJob(mergeJob);
      this.logger?.metric('merge_ms', performance.now() - mergeStart, { stream: safeTable });

      // numDmlAffectedRows only exists on COMPLETED job metadata; the
      // `mergeJob.metadata` snapshot is from job creation and never refreshed
      // by getQueryResults(), so reading it directly always yielded 0.
      let mergeStatistics = mergeJob.metadata?.statistics;
      if (mergeJob.getMetadata) {
        const [finalMetadata] = await this.bqRetry(() => mergeJob.getMetadata!());
        mergeStatistics = finalMetadata?.statistics ?? mergeStatistics;
      }
      const rowsAffected = parseInt(mergeStatistics?.query?.numDmlAffectedRows ?? '0', 10);
      return { rowsAffected };
    } finally {
      // Clean up temp Parquet file
      if (tempParquetPath) {
        await fs.rm(tempParquetPath, { force: true });
      }
      // Drop staging table
      try {
        const [dropJob] = await client.createQueryJob({
          query: `DROP TABLE IF EXISTS ${qualifiedStaging}`,
          location: this.location,
        });
        await this.waitForJob(dropJob);
      } catch (dropErr) {
        // Best-effort cleanup — staging table has 1-hour TTL as a safety net
        this.logger?.warn('staging_table_drop_failed', {
          table: stagingName,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
    }
  }

  async loadFromUri(
    schemaName: string,
    tableName: string,
    uris: string[],
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<LoadResult> {
    const client = await this.getClient();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteBqIdentifier(safeSchema)}.${quoteBqIdentifier(safeTable)}`;

    await this.ensureTable(safeSchema, safeTable, columns, options);
    await this.assertOwnedTable(safeSchema, safeTable);
    if (uris.length === 0) {
      const [truncateJob] = await this.bqRetry(() =>
        client.createQueryJob({
          query: `TRUNCATE TABLE ${qualifiedTable}`,
          location: this.location,
        })
      );
      await this.waitForJob(truncateJob);
      return { rowsAffected: 0 };
    }

    // Use `LOAD DATA ... FROM FILES` (not `table.load`) for GCS URIs: the SDK
    // treats a string source as a LOCAL file path, so a `gs://...` URI (incl. the
    // wildcards an UNLOAD/EXPORT emits) fails with ENOENT and crashes on the
    // stream's async error. We TRUNCATE + `LOAD DATA INTO` rather than OVERWRITE
    // so the stage table's auto DAY-partitioning (from `ensureTable`) is kept —
    // OVERWRITE rebuilds from the file's unpartitioned schema, which BigQuery
    // rejects. `enable_list_inference` preserves REPEATED-column (vector) loads.
    for (const uri of uris) {
      if (!uri.startsWith('gs://')) {
        throw new CommandError(`loadFromUri requires gs:// URIs; got "${uri}".`, 2);
      }
    }
    const [truncateJob] = await this.bqRetry(() =>
      client.createQueryJob({
        query: `TRUNCATE TABLE ${qualifiedTable}`,
        location: this.location,
      })
    );
    await this.waitForJob(truncateJob);

    const uriList = uris
      .map((u) => `'${u.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(', ');
    const [loadJob] = await this.bqRetry(() =>
      client.createQueryJob({
        query:
          `LOAD DATA INTO ${qualifiedTable}\n` +
          `FROM FILES (uris = [${uriList}], format = 'PARQUET', enable_list_inference = true)`,
        location: this.location,
      })
    );
    await this.waitForJob(loadJob);
    const [loadMeta] = (await loadJob.getMetadata?.()) ?? [undefined];
    const rowsAffected = parseInt(loadMeta?.statistics?.query?.numDmlAffectedRows ?? '0', 10);
    return { rowsAffected: Number.isNaN(rowsAffected) ? 0 : rowsAffected };
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const jobs = [...this.activeJobs];
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        if (!job.cancel) {
          await this.settleJob(job).catch(() => undefined);
          throw new Error('BigQuery job does not expose cancel().');
        }
        try {
          await job.cancel();
        } finally {
          await this.settleJob(job).catch(() => undefined);
        }
      })
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async close(): Promise<void> {
    if (this.duckDbWriter) {
      await this.duckDbWriter.close();
    }
    if (this.gcsStagingManager) {
      await this.gcsStagingManager.cleanupAll();
    }
  }
}
