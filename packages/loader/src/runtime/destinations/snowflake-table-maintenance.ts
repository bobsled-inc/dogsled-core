import { withRetry, type RetryOptions } from '../retry.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';
import type { LoaderLogger } from '../logger.js';
import {
  buildClusterColumns,
  SYSTEM_COLUMNS,
  type EnsureTableOptions,
  logTableOptimization,
} from './database.js';
import type { SnowflakeConnectionLike } from './snowflake.js';

/** State and operations shared by Snowflake schema maintenance helpers. */
export interface SnowflakeTableMaintenanceContext {
  readonly columnCache: Map<string, Map<string, string>>;
  readonly clusterCache: Map<string, string[]>;
  readonly logger?: LoaderLogger;
  readonly throwIfCancelled: () => void;
  readonly retryOpts: (context: string) => RetryOptions;
  readonly mapColumnType: (column: SchemaColumn | SchemaColumn['type']) => string;
  readonly normalizeType: (type: string) => string;
  readonly quoteIdentifier: (identifier: string) => string;
  readonly beforeMutation?: () => Promise<void>;
}

export function normalizeSnowflakeClusterColumns(columns: string[]): string[] {
  return columns.map((column) => column.toUpperCase());
}

export function parseSnowflakeClusteringKey(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const matches = [...value.matchAll(/"((?:[^"]|"")+)"/g)];
  if (matches.length > 0) {
    return matches.map((match) => match[1]!.replace(/""/g, '"').toUpperCase());
  }

  const linearMatch = value.match(/^LINEAR\((.*)\)$/i);
  if (!linearMatch || linearMatch[1]!.trim() === '') {
    return [];
  }

  return linearMatch[1]!
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^"+|"+$/g, '')
        .toUpperCase()
    )
    .filter((part) => part.length > 0);
}

export async function applySnowflakeClustering(
  context: SnowflakeTableMaintenanceContext,
  conn: SnowflakeConnectionLike,
  qualifiedTable: string,
  cacheKey: string,
  safeTable: string,
  columns: SchemaColumn[],
  options: EnsureTableOptions | undefined,
  force = false
): Promise<void> {
  const clusterCols = buildClusterColumns(columns, options);
  logTableOptimization(context.logger, {
    stream: safeTable,
    partitionColumn: null,
    partitionSource: 'not_supported',
    clusterColumns: clusterCols,
  });
  const normalizedClusterCols = normalizeSnowflakeClusterColumns(clusterCols);
  const currentCachedClustering = context.clusterCache.get(cacheKey);
  const clusteringChanged =
    force ||
    !currentCachedClustering ||
    currentCachedClustering.length !== normalizedClusterCols.length ||
    currentCachedClustering.some((c, i) => c !== normalizedClusterCols[i]);

  if (clusterCols.length > 0 && clusteringChanged) {
    context.throwIfCancelled();
    await withRetry(async () => {
      await context.beforeMutation?.();
      return conn.execute({
        sqlText: `ALTER TABLE ${qualifiedTable} CLUSTER BY (${clusterCols.map(context.quoteIdentifier).join(', ')})`,
      });
    }, context.retryOpts('cluster_table'));
  }
  context.clusterCache.set(cacheKey, normalizedClusterCols);
}

export async function replaceSnowflakeTable(
  context: SnowflakeTableMaintenanceContext,
  conn: SnowflakeConnectionLike,
  qualifiedTable: string,
  cacheKey: string,
  safeTable: string,
  columns: SchemaColumn[],
  options: EnsureTableOptions | undefined
): Promise<void> {
  const colDefs = columns.map(
    (col) => `${context.quoteIdentifier(col.name)} ${context.mapColumnType(col)}`
  );
  colDefs.push(
    `${context.quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP_TZ`,
    `${context.quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP_TZ`
  );

  context.throwIfCancelled();
  const ownershipComment =
    options?.tableOwnershipMarker === undefined
      ? ''
      : ` COMMENT = '${options.tableOwnershipMarker.replace(/'/g, "''")}'`;
  await withRetry(async () => {
    await context.beforeMutation?.();
    return conn.execute({
      sqlText: `CREATE OR REPLACE TABLE ${qualifiedTable} (${colDefs.join(', ')}) COPY GRANTS${ownershipComment}`,
    });
  }, context.retryOpts('replace_table'));
  context.throwIfCancelled();

  const columnMap = new Map<string, string>();
  for (const col of columns) {
    columnMap.set(col.name.toUpperCase(), context.normalizeType(context.mapColumnType(col)));
  }
  columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase(), 'TIMESTAMP_TZ');
  columnMap.set(SYSTEM_COLUMNS.LOADED_AT.toUpperCase(), 'TIMESTAMP_TZ');
  context.columnCache.set(cacheKey, columnMap);

  // CREATE OR REPLACE resets clustering metadata. Clear the old cache entry
  // and force the requested key back onto the replacement table.
  context.clusterCache.delete(cacheKey);
  await applySnowflakeClustering(
    context,
    conn,
    qualifiedTable,
    cacheKey,
    safeTable,
    columns,
    options,
    true
  );
}
