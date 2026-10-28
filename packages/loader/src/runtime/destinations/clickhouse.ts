import { randomUUID } from 'node:crypto';

import { assertBacktickIdentifier, CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import {
  buildClusterColumns,
  logTableOptimization,
  resolvePartitionColumn,
  resolvePartitionSource,
  SYSTEM_COLUMNS,
  sanitizeSchemaName,
  sanitizeTableName,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';
import { readJsonlRecords } from '../jsonl.js';
import { withRetry } from '../retry.js';

import type {
  BatchEncoding,
  SchemaColumn,
  ColumnType,
  VectorSchemaColumn,
} from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { LoaderLogger } from '../logger.js';

export interface ClickHouseClientLike {
  query(options: { query: string; params?: unknown[] }): Promise<{
    json(): Promise<unknown[]>;
  }>;
  command?(options: { query: string }): Promise<void>;
  exec(options: { query: string }): Promise<void>;
  insert(options: {
    table: string;
    values: Array<Record<string, unknown>>;
    format: 'JSONEachRow';
    clickhouse_settings?: Record<string, string | number | boolean | undefined>;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface ClickHouseDestinationOptions {
  host: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  vectorIndex?: boolean;
  connectionFactory?: () => Promise<ClickHouseClientLike>;
  logger?: LoaderLogger;
}

async function executeLegacyClickHouseCommand(
  client: unknown,
  options: { query: string }
): Promise<void> {
  const legacyExec = (client as { exec?: (options: { query: string }) => Promise<void> }).exec;
  if (typeof legacyExec !== 'function') {
    throw new Error('ClickHouse client does not provide command or exec');
  }
  await legacyExec.call(client, options);
}

function mapClickHouseType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'Nullable(Int64)';
    case 'number':
      return 'Nullable(Float64)';
    case 'boolean':
      return 'Nullable(UInt8)';
    case 'timestamp':
      return 'Nullable(DateTime64(3))';
    case 'string':
    case 'array':
    case 'object':
      return 'Nullable(String)';
    case 'vector':
      return 'Array(Float32)';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

function normalizeClickHouseType(type: string): string {
  // Strip Nullable() wrapper for comparison
  let upper = type.toUpperCase();
  const nullableMatch = upper.match(/^NULLABLE\((.+)\)$/);
  if (nullableMatch) {
    upper = nullableMatch[1]!;
  }
  const arrayMatch = upper.match(/^ARRAY\((FLOAT32|FLOAT64|BFLOAT16)\)$/);
  if (arrayMatch) {
    return 'ARRAY(FLOAT32)';
  }
  if (upper.startsWith('ARRAY(')) {
    return upper;
  }
  if (
    upper.includes('INT') &&
    !upper.includes('UINT') &&
    !upper.includes('INT32') &&
    !upper.includes('INT16') &&
    !upper.includes('INT8')
  ) {
    return 'INT64';
  }
  if (upper.includes('FLOAT') || upper === 'DOUBLE') {
    return 'FLOAT64';
  }
  if (upper.includes('UINT8') || upper === 'BOOLEAN') {
    return 'UINT8';
  }
  if (upper.includes('DATETIME')) {
    return 'DATETIME64';
  }
  if (
    upper.includes('CHAR') ||
    upper.includes('VARCHAR') ||
    upper.includes('TEXT') ||
    upper === 'STRING'
  ) {
    return 'STRING';
  }
  return upper;
}

function quoteIdentifier(identifier: string): string {
  assertBacktickIdentifier(identifier, 'ClickHouse identifier');
  const escaped = identifier.replace(/`/g, '``');
  return `\`${escaped}\``;
}

function escapeStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '');
}

function parseSortingKey(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'tuple()') {
    return [];
  }

  const unwrapped =
    trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  return unwrapped
    .split(',')
    .map((part) => part.trim().replace(/`/g, ''))
    .filter((part) => part.length > 0);
}

function sameIdentifierList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value.toLowerCase() === right[index]?.toLowerCase());
}

export class ClickHouseDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly username: string;
  private readonly password: string;
  private readonly ssl: boolean;
  private readonly vectorIndex: boolean;
  private readonly logger?: LoaderLogger;
  private readonly connectionFactory: () => Promise<ClickHouseClientLike>;
  private client: ClickHouseClientLike | null = null;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();

  constructor(options: ClickHouseDestinationOptions) {
    this.host = options.host;
    this.port = options.port ?? 8123;
    this.database = options.database;
    this.username = options.username ?? 'default';
    this.password = options.password ?? '';
    this.ssl = options.ssl ?? false;
    this.vectorIndex = options.vectorIndex ?? false;
    this.logger = options.logger;
    this.connectionFactory = options.connectionFactory ?? this.defaultConnectionFactory.bind(this);
  }

  private async defaultConnectionFactory(): Promise<ClickHouseClientLike> {
    try {
      const { createClient } = await import('@clickhouse/client');
      const client = createClient({
        host: `${this.ssl ? 'https' : 'http'}://${this.host}:${this.port}`,
        database: this.database,
        username: this.username,
        password: this.password,
        request_timeout: 60_000,
      });
      return {
        async query(options) {
          return client.query({ ...options, format: 'JSONEachRow' }) as unknown as Promise<{
            json(): Promise<unknown[]>;
          }>;
        },
        async command(options) {
          if (typeof client.command === 'function') {
            await client.command(options);
          } else {
            await executeLegacyClickHouseCommand(client, options);
          }
        },
        async exec(options) {
          if (typeof client.command === 'function') {
            await client.command(options);
          } else {
            await executeLegacyClickHouseCommand(client, options);
          }
        },
        async insert(options) {
          await client.insert(options);
        },
        async close() {
          return client.close();
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load @clickhouse/client. Install it to use --dest clickhouse. ${message}`
      );
    }
  }

  private getClient(): ClickHouseClientLike {
    if (!this.client) {
      throw new Error('ClickHouseDestination not initialized — call initialize() first');
    }
    return this.client;
  }

  async initialize(): Promise<void> {
    try {
      this.client = await this.connectionFactory();
      await this.client.exec({
        query: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(this.database)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to ClickHouse at ${this.host}:${this.port}. ${message}`);
    }
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const client = this.getClient();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const cacheKey = `${safeSchema}.${safeTable}`;
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
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
        const expectedType = mapClickHouseType(col.type);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (
          normalizeClickHouseType(existingType) !== normalizeClickHouseType(expectedType)
        ) {
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
          (col) => `ADD COLUMN ${quoteIdentifier(col.name)} ${mapClickHouseType(col.type)}`
        );
        await withRetry(() =>
          client.exec({
            query: `ALTER TABLE ${qualifiedTable} ${newColumnDefs.join(', ')}`,
          })
        );
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapClickHouseType(conflict.expectedColumnType);
        await withRetry(() =>
          client.exec({
            query: `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quoteIdentifier(conflict.column)} ${newSqlType}`,
          })
        );
      }

      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapClickHouseType(col.type));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapClickHouseType(conflict.expectedColumnType));
      }

      return;
    }

    await withRetry(() =>
      client.exec({
        query: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(safeSchema)}`,
      })
    );

    const existingResult = await client.query({
      query: `SELECT name, type FROM system.columns WHERE database = '${escapeStringLiteral(safeSchema)}' AND table = '${escapeStringLiteral(safeTable)}'`,
    });
    const existingRows = (await existingResult.json()) as Array<{ name: string; type: string }>;
    const existingMap = new Map<string, string>(existingRows.map((row) => [row.name, row.type]));

    if (existingMap.size === 0) {
      // ORDER BY defines the sparse primary index and sort order
      // Cannot be changed after table creation (unlike Snowflake CLUSTER BY)
      const clusterCols = buildClusterColumns(columns, options);
      const partCol = resolvePartitionColumn(columns, options);
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: partCol,
        partitionSource: resolvePartitionSource(options),
        clusterColumns: clusterCols,
      });
      const orderByClause =
        clusterCols.length > 0
          ? `ORDER BY (${clusterCols.map(quoteIdentifier).join(', ')})`
          : 'ORDER BY tuple()';

      // PARTITION BY monthly granularity when an explicit or cursor-inferred partition
      // column is available. We intentionally skip PARTITION BY when the only candidate
      // is _time_extracted (the fallback): ClickHouse PARTITION BY affects data file
      // layout, mutation performance, and part merge scheduling. Partitioning by a
      // system column that doesn't reflect business time would create unpredictable
      // part boundaries and degrade ALTER/DELETE performance. BigQuery uses
      // _time_extracted as its fallback partition column because BQ partitioning is
      // metadata-only with no physical layout cost.
      let partitionClause = '';
      if (partCol !== SYSTEM_COLUMNS.TIME_EXTRACTED) {
        partitionClause = ` PARTITION BY toYYYYMM(${quoteIdentifier(partCol)})`;
      }

      const engineClause = `ENGINE = MergeTree()${partitionClause} ${orderByClause}`;
      const colDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapClickHouseType(c.type)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} Nullable(DateTime64(3))`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} Nullable(DateTime64(3))`,
      ];
      const vectorColumns = columns.filter((c): c is VectorSchemaColumn => c.type === 'vector');
      const constraintDefs = this.vectorIndex
        ? vectorColumns.map(
            (c) =>
              `CONSTRAINT ${quoteIdentifier(`${c.name}_len`)} CHECK length(${quoteIdentifier(c.name)}) = ${c.dimension}`
          )
        : [];
      const indexDefs = this.vectorIndex
        ? vectorColumns.map(
            (c) =>
              `INDEX ${quoteIdentifier(`${c.name}_ann`)} ${quoteIdentifier(c.name)} TYPE vector_similarity('hnsw', '${clickHouseDistanceFunction(c)}', ${c.dimension})`
          )
        : [];
      await withRetry(() =>
        client.exec({
          query: `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${[
            ...colDefs,
            ...constraintDefs,
            ...indexDefs,
          ].join(', ')}) ${engineClause} SETTINGS allow_nullable_key = 1`,
        })
      );

      const columnMap = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapClickHouseType(c.type)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'Nullable(DateTime64(3))'],
        [SYSTEM_COLUMNS.LOADED_AT, 'Nullable(DateTime64(3))'],
      ]);
      this.columnCache.set(cacheKey, columnMap);
      return;
    }

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
      const expectedType = mapClickHouseType(col.type);

      if (existingType === undefined) {
        newColumns.push(col);
      } else if (normalizeClickHouseType(existingType) !== normalizeClickHouseType(expectedType)) {
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

    const desiredClusterCols = buildClusterColumns(columns, options);
    const desiredPartitionCol = resolvePartitionColumn(columns, options);
    logTableOptimization(this.logger, {
      stream: safeTable,
      partitionColumn: desiredPartitionCol,
      partitionSource: resolvePartitionSource(options),
      clusterColumns: desiredClusterCols,
    });
    const sortingKeyResult = await client.query({
      query: `SELECT sorting_key FROM system.tables WHERE database = '${escapeStringLiteral(safeSchema)}' AND name = '${escapeStringLiteral(safeTable)}'`,
    });
    const sortingKeyRows = (await sortingKeyResult.json()) as Array<{ sorting_key?: unknown }>;
    const currentOrderBy = parseSortingKey(sortingKeyRows[0]?.sorting_key);
    if (!sameIdentifierList(currentOrderBy, desiredClusterCols)) {
      this.logger?.warn('clickhouse_order_by_mismatch', {
        stream: safeTable,
        currentOrderBy,
        desiredOrderBy: desiredClusterCols,
      });
    }

    const newColumnDefs: string[] = columnsToAdd.map(
      (col) => `ADD COLUMN ${quoteIdentifier(col.name)} ${mapClickHouseType(col.type)}`
    );

    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      newColumnDefs.push(
        `ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} Nullable(DateTime64(3))`
      );
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      newColumnDefs.push(
        `ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} Nullable(DateTime64(3))`
      );
    }

    if (newColumnDefs.length > 0) {
      await withRetry(() =>
        client.exec({
          query: `ALTER TABLE ${qualifiedTable} ${newColumnDefs.join(', ')}`,
        })
      );
    }

    for (const conflict of columnsToWiden) {
      const newSqlType = mapClickHouseType(conflict.expectedColumnType);
      await withRetry(() =>
        client.exec({
          query: `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quoteIdentifier(conflict.column)} ${newSqlType}`,
        })
      );
    }

    const columnMap = new Map<string, string>(existingMap);
    for (const col of columnsToAdd) {
      columnMap.set(col.name, mapClickHouseType(col.type));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(conflict.column, mapClickHouseType(conflict.expectedColumnType));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'Nullable(DateTime64(3))');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'Nullable(DateTime64(3))');
    this.columnCache.set(cacheKey, columnMap);
  }

  async loadAndFinalize(
    schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: 'append' | 'merge' | 'full_refresh',
    keyColumns: string[],
    _sourceEncoding?: BatchEncoding
  ): Promise<LoadResult> {
    const client = this.getClient();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

    if (strategy === 'merge' && keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const batchSize = 500;
    const loadedAt = new Date().toISOString();
    const truncateIfNeeded = async (): Promise<void> => {
      if (strategy !== 'full_refresh') {
        return;
      }

      const qualifiedKey = `${safeSchema}.${safeTable}`;
      if (this.truncatedTables.has(qualifiedKey)) {
        return;
      }

      await withRetry(() =>
        client.exec({
          query: `TRUNCATE TABLE ${qualifiedTable}`,
        })
      );
      this.truncatedTables.add(qualifiedKey);
    };

    if (strategy === 'append' || strategy === 'full_refresh') {
      let rowsAffected = 0;
      let batch: Array<Record<string, unknown>> = [];
      for await (const record of readJsonlRecords(filePath)) {
        batch.push(buildClickHouseRow(record, columns, loadedAt));
        if (batch.length < batchSize) {
          continue;
        }

        await truncateIfNeeded();
        await withRetry(() => insertBatchNoRetry(client, qualifiedTable, batch));
        rowsAffected += batch.length;
        batch = [];
      }

      if (batch.length > 0) {
        await truncateIfNeeded();
        await withRetry(() => insertBatchNoRetry(client, qualifiedTable, batch));
        rowsAffected += batch.length;
      }

      return { rowsAffected };
    }

    const recordIterator = readJsonlRecords(filePath);
    const firstRecord = await recordIterator.next();
    if (firstRecord.done) {
      return { rowsAffected: 0 };
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const stagingTable = `_dogsled_stg_${safeTable}_${suffix}`;
    const qualifiedStaging = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(stagingTable)}`;
    const winnersTable = `_dogsled_win_${safeTable}_${suffix}`;
    const qualifiedWinners = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(winnersTable)}`;

    try {
      const engineClause = 'ENGINE = MergeTree() ORDER BY tuple()';
      const stagingColDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapClickHouseType(c.type)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} Nullable(DateTime64(3))`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} Nullable(DateTime64(3))`,
      ].join(', ');

      await withRetry(() =>
        client.exec({
          query: `CREATE TABLE ${qualifiedStaging} (${stagingColDefs}) ${engineClause}`,
        })
      );

      let batch: Array<Record<string, unknown>> = [
        buildClickHouseRow(firstRecord.value, columns, loadedAt),
      ];
      for await (const record of recordIterator) {
        batch.push(buildClickHouseRow(record, columns, loadedAt));
        if (batch.length < batchSize) {
          continue;
        }

        await withRetry(() => insertBatchNoRetry(client, qualifiedStaging, batch));
        batch = [];
      }
      if (batch.length > 0) {
        await withRetry(() => insertBatchNoRetry(client, qualifiedStaging, batch));
      }

      const keyList = keyColumns.map((k) => quoteIdentifier(k)).join(', ');
      const timeCol = quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED);
      const joinOn = keyColumns
        .map((k) => `D.${quoteIdentifier(k)} = T.${quoteIdentifier(k)}`)
        .join(' AND ');
      const insertCols = [
        ...columns.map((c) => quoteIdentifier(c.name)),
        timeCol,
        quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT),
      ].join(', ');

      // Newest staging row per key (in-batch dedup) that is not older than the target row.
      // join_use_nulls=1 makes unmatched target columns NULL so T.<time> IS NULL means no target row.
      await withRetry(() =>
        client.exec({
          query:
            `CREATE TABLE ${qualifiedWinners} ENGINE = MergeTree() ORDER BY tuple() AS ` +
            `SELECT D.* FROM (SELECT * FROM ${qualifiedStaging} ORDER BY ${timeCol} DESC NULLS LAST LIMIT 1 BY ${keyList}) AS D ` +
            `LEFT JOIN (SELECT ${keyList}, ${timeCol} FROM ${qualifiedTable} WHERE (${keyList}) IN (SELECT ${keyList} FROM ${qualifiedStaging})) AS T ON ${joinOn} ` +
            `WHERE T.${timeCol} IS NULL OR D.${timeCol} >= T.${timeCol} ` +
            `SETTINGS join_use_nulls = 1`,
        })
      );

      // mutations_sync = 1 makes DELETE synchronous, avoiding the async race between DELETE and INSERT.
      await withRetry(() =>
        client.exec({
          query:
            `ALTER TABLE ${qualifiedTable} DELETE WHERE (${keyList}) IN ` +
            `(SELECT ${keyList} FROM ${qualifiedWinners}) SETTINGS mutations_sync = 1`,
        })
      );

      await withRetry(() =>
        client.exec({
          query: `INSERT INTO ${qualifiedTable} (${insertCols}) SELECT ${insertCols} FROM ${qualifiedWinners}`,
        })
      );

      const countResult = await client.query({
        query: `SELECT count() AS cnt FROM ${qualifiedWinners}`,
      });
      const countRows = (await countResult.json()) as Array<{ cnt: number }>;
      const rowsAffected = countRows[0]?.cnt ?? 0;

      return { rowsAffected };
    } finally {
      try {
        await client.exec({
          query: `DROP TABLE IF EXISTS ${qualifiedStaging}`,
        });
      } catch (dropErr) {
        this.logger?.warn('staging_table_drop_failed', {
          table: qualifiedStaging,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
      try {
        await client.exec({
          query: `DROP TABLE IF EXISTS ${qualifiedWinners}`,
        });
      } catch (dropErr) {
        this.logger?.warn('staging_table_drop_failed', {
          table: qualifiedWinners,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
    }
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

const CLICKHOUSE_INSERT_SETTINGS = {
  date_time_input_format: 'best_effort',
};

async function insertBatchNoRetry(
  client: ClickHouseClientLike,
  table: string,
  batch: Array<Record<string, unknown>>
): Promise<void> {
  await client.insert({
    table,
    values: batch,
    format: 'JSONEachRow',
    clickhouse_settings: CLICKHOUSE_INSERT_SETTINGS,
  });
}

function buildClickHouseRow(
  record: Record<string, unknown>,
  columns: SchemaColumn[],
  loadedAt: string
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    row[column.name] = convertClickHouseValue(record[column.name], column.type);
  }
  row[SYSTEM_COLUMNS.TIME_EXTRACTED] = record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null;
  row[SYSTEM_COLUMNS.LOADED_AT] = loadedAt;
  return row;
}

function convertClickHouseValue(value: unknown, type: ColumnType): unknown {
  if (type === 'vector') {
    if (!Array.isArray(value)) {
      throw new CommandError(
        JSON.stringify({
          code: 'INVALID_VECTOR_VALUE',
          message: 'ClickHouse vector columns require a non-null numeric array',
          destination: 'clickhouse',
        }),
        EXIT_VALIDATION
      );
    }
    const numbers = value.map((v) => Number(v));
    if (!numbers.every((n) => Number.isFinite(n))) {
      throw new CommandError(
        JSON.stringify({
          code: 'INVALID_VECTOR_VALUE',
          message: 'ClickHouse vector columns require finite numeric values',
          destination: 'clickhouse',
        }),
        EXIT_VALIDATION
      );
    }
    return numbers;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'string') {
    return String(value);
  }
  if (type === 'boolean') {
    return value ? 1 : 0;
  }
  if (type === 'array' || type === 'object') {
    return JSON.stringify(value);
  }
  if (type === 'integer') {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string' && value.trim() === '') return null;
    // Preserve precision for Int64 values that exceed Number.MAX_SAFE_INTEGER
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }
    const str = String(value).trim();
    if (/^-?\d+$/.test(str)) {
      return str;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return Math.trunc(num);
  }
  if (type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return num;
  }
  if (type === 'timestamp') {
    return String(value);
  }
  return String(value);
}

function clickHouseDistanceFunction(column: VectorSchemaColumn): string {
  switch (column.embedded_from?.distance_metric) {
    case 'l2':
      return 'L2Distance';
    case 'dot':
      return 'dotProduct';
    case 'cosine':
    default:
      return 'cosineDistance';
  }
}
