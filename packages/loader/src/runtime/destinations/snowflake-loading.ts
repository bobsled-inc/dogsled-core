import { randomUUID } from 'node:crypto';

import { CommandError, type BatchEncoding, type SchemaColumn } from '@bobsled-inc/protocol';
import {
  assertNonEmptyColumns,
  SYSTEM_COLUMNS,
  sanitizeSchemaName,
  sanitizeTableName,
  type EnsureTableOptions,
  type LoadResult,
} from './database.js';
import { withRetry, type RetryOptions } from '../retry.js';
import type { LoaderLogger } from '../logger.js';
import type { SnowflakeConnectionLike } from './snowflake.js';

/** Dependencies supplied by SnowflakeDestination to keep load execution isolated. */
export interface SnowflakeLoadContext {
  refreshConnectionIfNeeded(): Promise<void>;
  getConnection(): SnowflakeConnectionLike;
  throwIfCancelled(): void;
  retryOpts(context: string): RetryOptions;
  getOwnershipMarker(schemaName: string, tableName: string): string | undefined;
  assertTableOwnership(
    conn: SnowflakeConnectionLike,
    qualifiedTable: string,
    metadataSchema: string,
    metadataTable: string,
    marker: string
  ): Promise<void>;
  ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void>;
  isTableTruncated(key: string): boolean;
  markTableTruncated(key: string): void;
  logger?: LoaderLogger;
  sanitizeError(error: unknown): Error;
  mapColumnType(column: SchemaColumn | SchemaColumn['type']): string;
  quoteIdentifier(identifier: string): string;
  quoteIdentifierPreservingCase(identifier: string): string;
  quoteStringLiteral(value: string): string;
  escapeJsonFieldName(name: string): string;
  extractMergeAffectedRows(rows: Record<string, unknown>[]): number | undefined;
}

/** Reject columns that Snowflake resolves to the same upper-case identifier. */
export function assertUniqueSnowflakeColumnNames(tableName: string, columns: SchemaColumn[]): void {
  const seen = new Map<string, string>([
    [SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase(), SYSTEM_COLUMNS.TIME_EXTRACTED],
    [SYSTEM_COLUMNS.LOADED_AT.toUpperCase(), SYSTEM_COLUMNS.LOADED_AT],
  ]);
  for (const column of columns) {
    const normalized = column.name.toUpperCase();
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      throw new CommandError(
        `Snowflake table "${tableName}" has duplicate columns "${previous}" and "${column.name}" after case normalization; rename one column before loading.`,
        2
      );
    }
    seen.set(normalized, column.name);
  }
}

export async function loadSnowflakeAndFinalize(
  context: SnowflakeLoadContext,
  schemaName: string,
  tableName: string,
  filePath: string,
  columns: SchemaColumn[],
  strategy: 'append' | 'merge' | 'full_refresh',
  keyColumns: string[],
  sourceEncoding: BatchEncoding = { format: 'jsonl' }
): Promise<LoadResult> {
  assertNonEmptyColumns(tableName, columns);
  assertUniqueSnowflakeColumnNames(tableName, columns);
  await context.refreshConnectionIfNeeded();
  const conn = context.getConnection();
  const safeSchema = sanitizeSchemaName(schemaName);
  const safeTable = sanitizeTableName(tableName);
  const ownershipMarker = context.getOwnershipMarker(safeSchema, safeTable);
  const quoteTargetTable =
    ownershipMarker === undefined ? context.quoteIdentifier : context.quoteIdentifierPreservingCase;
  const qualifiedTable = `${context.quoteIdentifier(safeSchema)}.${quoteTargetTable(safeTable)}`;
  const assertLoadOwnership = async (connection: SnowflakeConnectionLike): Promise<void> => {
    if (ownershipMarker === undefined) return;
    await context.assertTableOwnership(
      connection,
      qualifiedTable,
      safeSchema.toUpperCase(),
      safeTable,
      ownershipMarker
    );
  };
  const executeOwned = async (
    connection: SnowflakeConnectionLike,
    sqlText: string,
    retryContext: string
  ) =>
    withRetry(async () => {
      await assertLoadOwnership(connection);
      return connection.execute({ sqlText });
    }, context.retryOpts(retryContext));
  if (ownershipMarker !== undefined) {
    // SCHEMA handling normally performs this check first. Repeat it here so
    // a table replaced between SCHEMA and the first buffered load cannot be
    // truncated, copied into, or used as a merge target by this run.
    await assertLoadOwnership(conn);
  }
  const fileName = filePath.split('/').pop();
  if (!fileName) {
    throw new Error(`Invalid file path "${filePath}": cannot extract file name`);
  }

  // Validate merge pre-conditions early so we can create the staging table
  // before uploading (Snowflake blocks cross-table stage access, so merge runs
  // must upload to the staging table's own internal stage — not the target's).
  if (strategy === 'merge' && keyColumns.length === 0) {
    throw new Error('merge strategy requires at least one key column');
  }

  // Pre-create staging table for merge so we can upload directly into its stage.
  let stagingName: string | undefined;
  let qualifiedStaging: string | undefined;
  if (strategy === 'merge') {
    stagingName = `_DOGSLED_STG_${safeTable}_${randomUUID().replaceAll('-', '')}`;
    qualifiedStaging = `${context.quoteIdentifier(safeSchema)}.${context.quoteIdentifier(stagingName)}`;
    const stagingColDefs = [
      ...columns.map((c) => `${context.quoteIdentifier(c.name)} ${context.mapColumnType(c)}`),
      `${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP_TZ`,
      `${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP_TZ`,
    ].join(', ');
    await withRetry(
      () =>
        conn.execute({
          sqlText: `CREATE OR REPLACE TRANSIENT TABLE ${qualifiedStaging} (${stagingColDefs})`,
        }),
      context.retryOpts('create_staging_table')
    );
    context.throwIfCancelled();
  }

  // Upload target: merge → staging table's stage; otherwise target table's stage.
  const uploadTable = stagingName ?? safeTable;
  // A quoted owner-guarded target must keep its exact case in the implicit
  // table-stage reference too. Unquoted @%<name> would resolve a mixed-case
  // table as its upper-case counterpart.
  const stageTableName =
    stagingName !== undefined || ownershipMarker === undefined
      ? uploadTable
      : context.quoteIdentifierPreservingCase(uploadTable);
  const stageName = `@%${stageTableName}`;

  // Upload file to internal stage
  const uploadStart = performance.now();
  await withRetry(
    () => conn.uploadFile({ srcPath: filePath, destLoc: `${stageName}/${fileName}` }),
    context.retryOpts('upload_file')
  );
  context.throwIfCancelled();
  // PUT only stages the file, but the following COPY mutates the target.
  // Recheck after the potentially slow upload so a replacement during PUT
  // cannot redirect this run into an unrelated table.
  await assertLoadOwnership(conn);
  context.logger?.metric('staging_upload_ms', performance.now() - uploadStart, {
    stream: safeTable,
  });

  // Build column expressions for COPY INTO transform.
  // JSON data is accessed via $1:"field_name"::TYPE in Snowflake staged file queries.
  const userSelectExprs = columns.map((column) => {
    const fieldRef = `$1:"${context.escapeJsonFieldName(column.name)}"`;
    if (column.type === 'vector') {
      return `${fieldRef}::ARRAY::VECTOR(FLOAT, ${column.dimension})`;
    }
    return `${fieldRef}::${context.mapColumnType(column)}`;
  });
  // _time_extracted comes from the extractor data (enriched by run.ts before buffering)
  const selectExprs = [
    ...userSelectExprs,
    `$1:"${context.escapeJsonFieldName(SYSTEM_COLUMNS.TIME_EXTRACTED)}"::TIMESTAMP_TZ`,
    `CURRENT_TIMESTAMP()`,
  ].join(', ');

  const userColList = columns.map((c) => context.quoteIdentifier(c.name)).join(', ');
  const allColList = `${userColList}, ${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}, ${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)}`;
  // Parquet COPY INTO relies on MATCH_BY_COLUMN_NAME and cannot inject CURRENT_TIMESTAMP()
  // for _dogsled_loaded_at in a single statement. The follow-up UPDATE backfills any NULLs.
  // NOTE: COPY + UPDATE are not atomic in a single transaction here — if UPDATE fails after
  // COPY succeeded, retried runs may leave _dogsled_loaded_at NULL until the next load flushes
  // them. The WHERE clause is idempotent (only touches NULL rows) so retries converge.
  const setLoadedAtSql = (qualifiedName: string) =>
    `UPDATE ${qualifiedName} SET ${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = CURRENT_TIMESTAMP() WHERE ${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} IS NULL`;
  const buildJsonCopyIntoSql = (qualifiedName: string, purge: boolean) => {
    const sourceExpr = `FROM (SELECT ${selectExprs} FROM ${stageName}/${fileName})`;
    return `COPY INTO ${qualifiedName} (${allColList}) ${sourceExpr} FILE_FORMAT = (TYPE = JSON) ON_ERROR = 'ABORT_STATEMENT'${purge ? ' PURGE = TRUE' : ''}`;
  };
  const buildParquetCopyIntoSql = (qualifiedName: string, purge: boolean) =>
    `COPY INTO ${qualifiedName} FROM ${stageName}/${fileName} FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = 'ABORT_STATEMENT'${purge ? ' PURGE = TRUE' : ''}`;

  if (strategy === 'append') {
    await assertLoadOwnership(conn);
    const loadStart = performance.now();
    const result = await executeOwned(
      conn,
      sourceEncoding.format === 'parquet'
        ? buildParquetCopyIntoSql(qualifiedTable, true)
        : buildJsonCopyIntoSql(qualifiedTable, true),
      'copy_into_append'
    );
    context.throwIfCancelled();
    if (sourceEncoding.format === 'parquet') {
      await assertLoadOwnership(conn);
      await executeOwned(conn, setLoadedAtSql(qualifiedTable), 'backfill_loaded_at');
    }
    context.logger?.metric('load_job_ms', performance.now() - loadStart, { stream: safeTable });
    return { rowsAffected: result.getAffectedRows() };
  }

  if (strategy === 'full_refresh') {
    const qualifiedKey = `${safeSchema}.${safeTable}`;
    const isFirst = !context.isTableTruncated(qualifiedKey);
    if (isFirst) {
      await assertLoadOwnership(conn);
      await executeOwned(conn, `TRUNCATE TABLE ${qualifiedTable}`, 'truncate');
      context.throwIfCancelled();
      context.markTableTruncated(qualifiedKey);
    }

    await assertLoadOwnership(conn);
    const loadStart = performance.now();
    const result = await executeOwned(
      conn,
      sourceEncoding.format === 'parquet'
        ? buildParquetCopyIntoSql(qualifiedTable, true)
        : buildJsonCopyIntoSql(qualifiedTable, true),
      'copy_into_full_refresh'
    );
    context.throwIfCancelled();
    if (sourceEncoding.format === 'parquet') {
      await assertLoadOwnership(conn);
      await executeOwned(conn, setLoadedAtSql(qualifiedTable), 'backfill_loaded_at');
    }
    context.logger?.metric('load_job_ms', performance.now() - loadStart, { stream: safeTable });
    return { rowsAffected: result.getAffectedRows() };
  }

  // Merge strategy — staging table was pre-created above so we could upload into
  // its internal stage (Snowflake refuses cross-table stage access, so uploading
  // to @%target and then COPY INTO staging would fail).
  if (!stagingName || !qualifiedStaging) {
    // Should be unreachable — merge branch guarantees these are set.
    throw new Error('internal: merge strategy reached load phase without a staging table');
  }

  try {
    // Load data into staging table
    const loadStart = performance.now();
    await executeOwned(
      conn,
      sourceEncoding.format === 'parquet'
        ? buildParquetCopyIntoSql(qualifiedStaging, false)
        : buildJsonCopyIntoSql(qualifiedStaging, false),
      'copy_into_staging'
    );
    context.throwIfCancelled();
    if (sourceEncoding.format === 'parquet') {
      await executeOwned(conn, setLoadedAtSql(qualifiedStaging), 'backfill_loaded_at');
    }
    context.logger?.metric('load_job_ms', performance.now() - loadStart, {
      stream: safeTable,
      phase: 'staging',
    });

    // Build MERGE statement
    const keyCols = keyColumns.map((k) => context.quoteIdentifier(k)).join(', ');
    const onClause = keyColumns
      .map((k) => `T.${context.quoteIdentifier(k)} = S.${context.quoteIdentifier(k)}`)
      .join(' AND ');

    const updateSet = [
      ...columns
        .filter((c) => !keyColumns.includes(c.name))
        .map((c) => `${context.quoteIdentifier(c.name)} = S.${context.quoteIdentifier(c.name)}`),
      `${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = S.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
      `${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = S.${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)}`,
    ].join(', ');

    const stagingColExprs = [
      ...columns.map((c) => `S.${context.quoteIdentifier(c.name)}`),
      `S.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
      `S.${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)}`,
    ].join(', ');

    const mergeSql =
      `MERGE INTO ${qualifiedTable} T USING (` +
      `SELECT ${stagingColExprs}, ROW_NUMBER() OVER (PARTITION BY ${keyCols} ORDER BY S.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn ` +
      `FROM ${qualifiedStaging} S` +
      `) S ON ${onClause} ` +
      `WHEN MATCHED AND (S.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= T.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR T.${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL) AND S._rn = 1 THEN UPDATE SET ${updateSet} ` +
      `WHEN NOT MATCHED AND S._rn = 1 THEN INSERT (${allColList}) VALUES (${stagingColExprs})`;

    context.throwIfCancelled();
    await assertLoadOwnership(conn);
    const mergeStart = performance.now();
    const mergeResult = await executeOwned(conn, mergeSql, 'merge');
    context.logger?.metric('merge_ms', performance.now() - mergeStart, { stream: safeTable });

    // Prefer the MERGE summary's inserted+updated total; fall back to the
    // driver's updates-only count only when the summary is unavailable.
    const rowsAffected =
      context.extractMergeAffectedRows(mergeResult.getRows()) ?? mergeResult.getAffectedRows();

    // Clean up staged file (merge COPY goes to staging table, so PURGE doesn't apply to main stage)
    context.throwIfCancelled();
    await withRetry(
      () => conn.execute({ sqlText: `REMOVE ${stageName}/${fileName}` }),
      context.retryOpts('remove_staged_file')
    );

    // Drop staging table
    context.throwIfCancelled();
    await withRetry(
      () => conn.execute({ sqlText: `DROP TABLE IF EXISTS ${qualifiedStaging}` }),
      context.retryOpts('drop_staging')
    );

    return { rowsAffected };
  } catch (error) {
    // Best-effort staging table cleanup on failure
    try {
      await conn.execute({ sqlText: `DROP TABLE IF EXISTS ${qualifiedStaging}` });
    } catch (dropErr) {
      // Swallow cleanup errors — the original error is more important
      context.logger?.warn('staging_table_drop_failed', {
        table: qualifiedStaging,
        error: context.sanitizeError(dropErr).message,
      });
    }
    throw context.sanitizeError(error);
  }
}

export async function loadSnowflakeFromUri(
  context: SnowflakeLoadContext,
  schemaName: string,
  tableName: string,
  uris: string[],
  columns: SchemaColumn[],
  options?: EnsureTableOptions
): Promise<LoadResult> {
  const safeSchema = sanitizeSchemaName(schemaName);
  const safeTable = sanitizeTableName(tableName);
  await context.ensureTable(safeSchema, safeTable, columns, options);
  // Reacquire after ensureTable because OAuth may reconnect there.
  await context.refreshConnectionIfNeeded();
  const conn = context.getConnection();
  const ownershipMarker = context.getOwnershipMarker(safeSchema, safeTable);
  const quoteTargetTable =
    ownershipMarker === undefined ? context.quoteIdentifier : context.quoteIdentifierPreservingCase;
  const qualifiedTable = `${context.quoteIdentifier(safeSchema)}.${quoteTargetTable(safeTable)}`;
  const assertLoadOwnership = async (connection: SnowflakeConnectionLike): Promise<void> => {
    if (ownershipMarker === undefined) return;
    await context.assertTableOwnership(
      connection,
      qualifiedTable,
      safeSchema.toUpperCase(),
      safeTable,
      ownershipMarker
    );
  };
  const executeOwned = async (
    connection: SnowflakeConnectionLike,
    sqlText: string,
    retryContext: string
  ) =>
    withRetry(async () => {
      await assertLoadOwnership(connection);
      return connection.execute({ sqlText });
    }, context.retryOpts(retryContext));
  if (ownershipMarker !== undefined) {
    await assertLoadOwnership(conn);
  }
  await executeOwned(conn, `TRUNCATE TABLE ${qualifiedTable}`, 'truncate_load_from_uri');
  context.throwIfCancelled();

  let rowsAffected = 0;
  for (const uri of uris) {
    context.throwIfCancelled();
    // Refresh before each COPY so short-lived OAuth sessions stay current.
    await context.refreshConnectionIfNeeded();
    const currentConn = context.getConnection();
    await assertLoadOwnership(currentConn);
    const result = await executeOwned(
      currentConn,
      `COPY INTO ${qualifiedTable} FROM ${context.quoteStringLiteral(uri)} ` +
        `FILE_FORMAT = (TYPE = PARQUET) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE ON_ERROR = 'ABORT_STATEMENT'`,
      'copy_from_uri'
    );
    rowsAffected += result.getAffectedRows();
  }
  return { rowsAffected };
}
