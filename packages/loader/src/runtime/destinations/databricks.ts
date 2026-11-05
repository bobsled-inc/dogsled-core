import { assertBacktickIdentifier, quoteWarehouseLiteral } from '@bobsled-inc/protocol';
import { assertDriverVersion } from '@bobsled-inc/connections';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import {
  buildClusterColumns,
  logTableOptimization,
  sanitizeSchemaName,
  sanitizeTableName,
  validateColumnName,
  SYSTEM_COLUMNS,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';
import { withRetry } from '../retry.js';

import type { BatchEncoding, SchemaColumn, ColumnType } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { LoaderLogger } from '../logger.js';

export interface DatabricksOperationLike {
  fetchAll(): Promise<Record<string, unknown>[]>;
  cancel?(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabricksSessionLike {
  executeStatement(
    statement: string,
    options?: { ordinalParameters?: string[] }
  ): Promise<DatabricksOperationLike>;
  close(): Promise<void>;
}

export interface DatabricksConnectionLike {
  openSession(): Promise<DatabricksSessionLike>;
  close(): Promise<void>;
}

export interface DatabricksDestinationOptions {
  serverHostname: string;
  httpPath: string;
  accessToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTokenFetcher?: (host: string, clientId: string, clientSecret: string) => Promise<string>;
  catalog: string;
  schema: string;
  logger?: LoaderLogger;
  clientFactory?: (
    serverHostname: string,
    httpPath: string,
    accessToken: string
  ) => Promise<DatabricksConnectionLike>;
}

/** Values per DELETE statement for REPLACE. */
const DELETE_BATCH_SIZE = 500;

function mapDatabricksType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'string':
      return 'STRING';
    case 'array':
      return 'STRING';
    case 'object':
      return 'STRING';
    case 'vector':
      throw new CommandError(
        JSON.stringify({
          code: 'UNSUPPORTED_COLUMN_TYPE',
          message: 'Databricks destination does not support vector columns',
          destination: 'databricks',
          columnType: 'vector',
        }),
        EXIT_VALIDATION
      );
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

function quoteDatabricksIdentifier(identifier: string): string {
  if (identifier.includes('`')) {
    throw new Error(`Invalid Databricks identifier "${identifier}": backticks are not allowed`);
  }
  assertBacktickIdentifier(identifier, 'Databricks identifier');
  return `\`${identifier}\``;
}

function quoteDatabricksStringLiteral(value: string): string {
  return quoteWarehouseLiteral(value);
}

function formatDatabricksLiteral(value: unknown, type: ColumnType | 'timestamp'): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  switch (type) {
    case 'integer':
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return 'NULL';
      return String(n);
    }
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'timestamp':
      return `TIMESTAMP ${quoteDatabricksStringLiteral(String(value))}`;
    case 'string':
      return quoteDatabricksStringLiteral(String(value));
    case 'array':
    case 'object':
      return quoteDatabricksStringLiteral(JSON.stringify(value));
    default:
      return quoteDatabricksStringLiteral(String(value));
  }
}

function readDatabricksRowCount(rows: Record<string, unknown>[]): number {
  const keys = ['rows_loaded', 'num_affected_rows', 'num_inserted_rows', 'row_count'];
  let total = 0;
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        break;
      }
      if (typeof value === 'bigint') {
        total += Number(value);
        break;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          total += parsed;
          break;
        }
      }
    }
  }
  return total;
}

export class DatabricksDestination implements DatabaseDestination {
  private readonly serverHostname: string;
  private readonly httpPath: string;
  private readonly accessToken?: string;
  private readonly oauthClientId?: string;
  private readonly oauthClientSecret?: string;
  private readonly oauthTokenFetcher?: DatabricksDestinationOptions['oauthTokenFetcher'];
  private readonly catalog: string;
  private readonly schema: string;
  private readonly logger?: LoaderLogger;
  private readonly clientFactory: (
    serverHostname: string,
    httpPath: string,
    accessToken: string
  ) => Promise<DatabricksConnectionLike>;
  private cachedConnection?: DatabricksConnectionLike;
  private cachedSession?: DatabricksSessionLike;
  private activeOperation?: DatabricksOperationLike;
  private cancelRequested = false;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  private tableOwnershipMarkers = new Map<string, string>();
  /** Cache of applied cluster columns per table to avoid redundant ALTER CLUSTER BY. */
  private clusterCache = new Map<string, string[]>();

  constructor(options: DatabricksDestinationOptions) {
    this.serverHostname = options.serverHostname;
    this.httpPath = options.httpPath;
    this.accessToken = options.accessToken;
    this.oauthClientId = options.oauthClientId;
    this.oauthClientSecret = options.oauthClientSecret;
    this.oauthTokenFetcher = options.oauthTokenFetcher;
    if (
      (this.accessToken !== undefined) ===
      (this.oauthClientId !== undefined && this.oauthClientSecret !== undefined)
    ) {
      throw new CommandError(
        'Databricks destination requires exactly one PAT or OAuth M2M credential set.',
        2
      );
    }
    if ((this.oauthClientId === undefined) !== (this.oauthClientSecret === undefined)) {
      throw new CommandError('Databricks OAuth M2M requires both client ID and client secret.', 2);
    }
    this.catalog = options.catalog;
    this.schema = options.schema;
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ??
      (async (sh, hp, at) => {
        assertDriverVersion('@databricks/sql', '2.0.0', createRequire(import.meta.url));
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
        ).connect({
          host: sh,
          path: hp,
          token: at,
        });
        return connection as unknown as DatabricksConnectionLike;
      });
  }

  private async getSession(): Promise<DatabricksSessionLike> {
    this.throwIfCancelled();
    if (this.cachedSession) {
      return this.cachedSession;
    }
    try {
      const token =
        this.accessToken ??
        (await (
          this.oauthTokenFetcher ??
          (async (host, clientId, clientSecret) => {
            const { fetchDatabricksOAuthToken } = await import('@bobsled-inc/connections');
            return fetchDatabricksOAuthToken(host, clientId, clientSecret);
          })
        )(this.serverHostname, this.oauthClientId!, this.oauthClientSecret!));
      this.throwIfCancelled();
      this.cachedConnection = await this.clientFactory(this.serverHostname, this.httpPath, token);
      this.throwIfCancelled();
      this.cachedSession = await withRetry(() => {
        this.throwIfCancelled();
        return this.cachedConnection!.openSession();
      });
      this.throwIfCancelled();
      return this.cachedSession;
    } catch (error) {
      if (this.cancelRequested) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to Databricks. Install @databricks/sql to use --dest databricks. ${message}`
      );
    }
  }

  async initialize(): Promise<void> {
    await this.query(`USE CATALOG ${quoteDatabricksIdentifier(this.catalog)}`);
    await this.query(`USE SCHEMA ${quoteDatabricksIdentifier(this.schema)}`);
  }

  private async query(
    sql: string,
    ordinalParameters?: string[]
  ): Promise<Record<string, unknown>[]> {
    const session = await this.getSession();
    this.throwIfCancelled();
    const operation = await withRetry(() => {
      this.throwIfCancelled();
      return ordinalParameters
        ? session.executeStatement(sql, { ordinalParameters })
        : session.executeStatement(sql);
    });
    this.activeOperation = operation;
    let operationClosed = false;
    const closeOperation = async (): Promise<void> => {
      if (operationClosed) return;
      operationClosed = true;
      await operation.close();
    };
    try {
      if (this.cancelRequested) {
        if (!operation.cancel) {
          await Promise.allSettled([closeOperation(), this.close()]);
          throw new Error('Databricks destination operation does not expose cancel().');
        }
        try {
          await operation.cancel();
        } catch (error) {
          // A rejected cancellation is not an acknowledgement. Close the
          // operation plus its session/connection before surfacing the failure
          // so a late-created handle is not left attached to live work.
          await Promise.allSettled([closeOperation(), this.close()]);
          throw error;
        }
        this.throwIfCancelled();
      }
      return await operation.fetchAll();
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
      await closeOperation();
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) {
      throw new Error('Databricks destination operation cancelled.');
    }
  }

  private async readTableType(schemaName: string, tableName: string): Promise<string | undefined> {
    const rows = await this.query(
      `SELECT table_type FROM system.information_schema.tables WHERE table_catalog = ${quoteDatabricksStringLiteral(this.catalog.toLowerCase())} AND table_schema = ${quoteDatabricksStringLiteral(schemaName.toLowerCase())} AND table_name = ${quoteDatabricksStringLiteral(tableName.toLowerCase())} LIMIT 1`
    );
    const row = rows[0];
    if (!row) return undefined;
    const type = row['table_type'] ?? row['TABLE_TYPE'];
    if (typeof type !== 'string') {
      throw new CommandError('Databricks table metadata did not include table_type.', 2);
    }
    return type;
  }

  private async assertTableOwnership(
    schemaName: string,
    tableName: string,
    marker: string
  ): Promise<void> {
    const qualifiedTable = `${quoteDatabricksIdentifier(this.catalog)}.${quoteDatabricksIdentifier(schemaName)}.${quoteDatabricksIdentifier(tableName)}`;
    const type = await this.readTableType(schemaName, tableName);
    if (type !== 'MANAGED') {
      throw new CommandError(
        `Databricks table ${qualifiedTable} is not an owned managed table; refusing to mutate it.`,
        2
      );
    }
    const rows = await this.query(`SHOW TBLPROPERTIES ${qualifiedTable} ('dogsled_temp_dataset')`);
    const value = rows[0]?.['value'] ?? rows[0]?.['VALUE'];
    if (value !== marker) {
      throw new CommandError(
        `Databricks table ${qualifiedTable} is not owned by the requested dataset; refusing to mutate it.`,
        2
      );
    }
  }

  private async assertOwnershipBeforeMutation(
    schemaName: string,
    tableName: string
  ): Promise<void> {
    const marker = this.tableOwnershipMarkers.get(`${schemaName}.${tableName}`);
    if (marker !== undefined) {
      await this.assertTableOwnership(schemaName, tableName, marker);
    }
  }

  private async getExistingColumns(
    schemaName: string,
    tableName: string
  ): Promise<Map<string, string>> {
    const rows = await this.query(
      `SELECT column_name, data_type FROM system.information_schema.columns WHERE table_catalog = ${quoteDatabricksStringLiteral(this.catalog.toLowerCase())} AND table_schema = ${quoteDatabricksStringLiteral(schemaName.toLowerCase())} AND table_name = ${quoteDatabricksStringLiteral(tableName.toLowerCase())}`
    );
    return new Map(rows.map((row) => [String(row['column_name']), String(row['data_type'])]));
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    for (const col of columns) {
      validateColumnName(col.name);
    }
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteDatabricksIdentifier(safeSchema)}.${quoteDatabricksIdentifier(safeTable)}`;
    const cacheKey = `${safeSchema}.${safeTable}`;
    const requestedMarker = options?.tableOwnershipMarker;
    if (
      requestedMarker !== undefined &&
      (requestedMarker.length === 0 ||
        requestedMarker.length > 256 ||
        requestedMarker.trim() !== requestedMarker ||
        /[\u0000-\u001f\u007f]/.test(requestedMarker))
    ) {
      throw new CommandError('Invalid Databricks table ownership marker.', 2);
    }
    const marker = requestedMarker ?? this.tableOwnershipMarkers.get(cacheKey);

    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      if (marker !== undefined) {
        await this.assertTableOwnership(safeSchema, safeTable, marker);
        this.tableOwnershipMarkers.set(cacheKey, marker);
      }
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
        const expectedType = mapDatabricksType(col.type);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (existingType.toUpperCase() !== expectedType.toUpperCase()) {
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
          (col) => `${quoteDatabricksIdentifier(col.name)} ${mapDatabricksType(col.type)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ADD COLUMNS (${newColumnDefs.join(', ')})`;
        await withRetry(async () => {
          await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
          return this.query(ddl);
        });
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapDatabricksType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteDatabricksIdentifier(conflict.column)} TYPE ${newSqlType}`;
        await withRetry(async () => {
          await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
          return this.query(widenDdl);
        });
      }

      // Update cache after changes
      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapDatabricksType(col.type));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapDatabricksType(conflict.expectedColumnType));
      }

      return;
    }

    const existingType = await this.readTableType(safeSchema, safeTable);
    const exists = existingType !== undefined;

    if (exists && marker !== undefined) {
      await this.assertTableOwnership(safeSchema, safeTable, marker);
      this.tableOwnershipMarkers.set(cacheKey, marker);
    }

    if (!exists) {
      const colDefs = [
        ...columns.map((c) => `${quoteDatabricksIdentifier(c.name)} ${mapDatabricksType(c.type)}`),
        `${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`,
        `${quoteDatabricksIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      ];
      // Liquid clustering replaces legacy PARTITION BY + ZORDER BY
      const clusterCols = buildClusterColumns(columns, options);
      const clusterClause =
        clusterCols.length > 0
          ? ` CLUSTER BY (${clusterCols.map(quoteDatabricksIdentifier).join(', ')})`
          : '';
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: null,
        partitionSource: 'not_supported',
        clusterColumns: clusterCols,
      });

      const ownershipProperties =
        marker === undefined
          ? ''
          : ` TBLPROPERTIES ('dogsled_temp_dataset' = ${quoteDatabricksStringLiteral(marker)})`;
      const ddl = `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})${clusterClause}${ownershipProperties}`;
      await withRetry(() => this.query(ddl));
      if (marker !== undefined) {
        await this.assertTableOwnership(safeSchema, safeTable, marker);
        this.tableOwnershipMarkers.set(cacheKey, marker);
      }

      // Set Delta optimization properties for write coalescing and auto-compaction
      if (clusterCols.length > 0) {
        await withRetry(async () => {
          await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
          return this.query(
            `ALTER TABLE ${qualifiedTable} SET TBLPROPERTIES ('delta.autoOptimize.optimizeWrite' = 'true', 'delta.autoOptimize.autoCompact' = 'true')`
          );
        });
      }

      const columnMap = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapDatabricksType(c.type)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP'],
        [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP'],
      ]);
      this.columnCache.set(cacheKey, columnMap);
      this.clusterCache.set(cacheKey, clusterCols);
      return;
    }

    const existingMap = await this.getExistingColumns(safeSchema, safeTable);

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
      const expectedType = mapDatabricksType(col.type);

      if (existingType === undefined) {
        newColumns.push(col);
      } else if (existingType.toUpperCase() !== expectedType.toUpperCase()) {
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

    // Add new columns
    const newColumnDefs: string[] = columnsToAdd.map(
      (col) => `${quoteDatabricksIdentifier(col.name)} ${mapDatabricksType(col.type)}`
    );

    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      newColumnDefs.push(`${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`);
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      newColumnDefs.push(
        `${quoteDatabricksIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
      );
    }

    if (newColumnDefs.length > 0) {
      const ddl = `ALTER TABLE ${qualifiedTable} ADD COLUMNS (${newColumnDefs.join(', ')})`;
      await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(ddl);
      });
    }

    // Widen columns one at a time
    for (const conflict of columnsToWiden) {
      const newSqlType = mapDatabricksType(conflict.expectedColumnType);
      const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteDatabricksIdentifier(conflict.column)} TYPE ${newSqlType}`;
      await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(widenDdl);
      });
    }

    // Update column cache
    const columnMap = new Map<string, string>(existingMap);
    for (const col of columnsToAdd) {
      columnMap.set(col.name, mapDatabricksType(col.type));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(conflict.column, mapDatabricksType(conflict.expectedColumnType));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP');
    this.columnCache.set(cacheKey, columnMap);

    // Apply liquid clustering — skip if already matching to avoid redundant DDL
    const clusterCols = buildClusterColumns(columns, options);
    logTableOptimization(this.logger, {
      stream: safeTable,
      partitionColumn: null,
      partitionSource: 'not_supported',
      clusterColumns: clusterCols,
    });
    const currentClustering = this.clusterCache.get(cacheKey);
    const clusteringChanged =
      !currentClustering ||
      currentClustering.length !== clusterCols.length ||
      currentClustering.some((c, i) => c !== clusterCols[i]);

    if (clusterCols.length > 0 && clusteringChanged) {
      await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(
          `ALTER TABLE ${qualifiedTable} CLUSTER BY (${clusterCols.map(quoteDatabricksIdentifier).join(', ')})`
        );
      });
    }
    this.clusterCache.set(cacheKey, clusterCols);
  }

  private async loadJsonl(
    schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: 'append' | 'merge' | 'full_refresh',
    keyColumns: string[]
  ): Promise<LoadResult> {
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteDatabricksIdentifier(safeSchema)}.${quoteDatabricksIdentifier(safeTable)}`;

    const allCols = [
      ...columns.map((c) => c.name),
      SYSTEM_COLUMNS.TIME_EXTRACTED,
      SYSTEM_COLUMNS.LOADED_AT,
    ];

    // Read JSONL file from local filesystem
    const data = await fs.readFile(filePath, 'utf-8');
    const records = data
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    if (records.length === 0) {
      return { rowsAffected: 0 };
    }

    if (strategy === 'full_refresh') {
      const qualifiedKey = `${safeSchema}.${safeTable}`;
      if (!this.truncatedTables.has(qualifiedKey)) {
        await withRetry(async () => {
          await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
          return this.query(`DELETE FROM ${qualifiedTable}`);
        });
        this.truncatedTables.add(qualifiedKey);
      }
    }

    if (strategy === 'append' || strategy === 'full_refresh') {
      // Direct INSERT with VALUES for append/full_refresh
      const paramCols = [
        ...columns.map((c) => quoteDatabricksIdentifier(c.name)),
        quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ];
      const insertColList = [
        ...paramCols,
        quoteDatabricksIdentifier(SYSTEM_COLUMNS.LOADED_AT),
      ].join(', ');

      const valueTuples = records.map((record) => {
        const vals = columns.map((c) => formatDatabricksLiteral(record[c.name], c.type));
        vals.push(formatDatabricksLiteral(record[SYSTEM_COLUMNS.TIME_EXTRACTED], 'timestamp'));
        vals.push('CURRENT_TIMESTAMP');
        return `(${vals.join(', ')})`;
      });

      // Batch in groups of 500 to avoid overly large statements
      const batchSize = 500;
      let rowsAffected = 0;
      for (let i = 0; i < valueTuples.length; i += batchSize) {
        const batch = valueTuples.slice(i, i + batchSize);
        const sql = `INSERT INTO ${qualifiedTable} (${insertColList}) VALUES ${batch.join(', ')}`;
        await withRetry(async () => {
          await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
          return this.query(sql);
        });
        rowsAffected += batch.length;
      }
      return { rowsAffected };
    }

    // Merge strategy — use staging table
    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const stagingName = `_dogsled_stg_${safeTable}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const qualifiedStaging = `${quoteDatabricksIdentifier(safeSchema)}.${quoteDatabricksIdentifier(stagingName)}`;

    try {
      const stagingColDefs = [
        ...columns.map((c) => `${quoteDatabricksIdentifier(c.name)} ${mapDatabricksType(c.type)}`),
        `${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`,
      ].join(', ');
      await withRetry(() =>
        this.query(`CREATE OR REPLACE TABLE ${qualifiedStaging} (${stagingColDefs})`)
      );

      // Insert records into staging table in batches
      const stagingCols = [
        ...columns.map((c) => quoteDatabricksIdentifier(c.name)),
        quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ].join(', ');

      const batchSize = 500;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const valueTuples = batch.map((record) => {
          const vals = columns.map((c) => formatDatabricksLiteral(record[c.name], c.type));
          vals.push(formatDatabricksLiteral(record[SYSTEM_COLUMNS.TIME_EXTRACTED], 'timestamp'));
          return `(${vals.join(', ')})`;
        });
        const sql = `INSERT INTO ${qualifiedStaging} (${stagingCols}) VALUES ${valueTuples.join(', ')}`;
        await withRetry(() => this.query(sql));
      }

      const onClause = keyColumns
        .map((k) => `T.${quoteDatabricksIdentifier(k)} = S.${quoteDatabricksIdentifier(k)}`)
        .join(' AND ');

      const updateSet = allCols
        .filter((c) => !keyColumns.includes(c))
        .map((c) => {
          if (c === SYSTEM_COLUMNS.LOADED_AT) {
            return `${quoteDatabricksIdentifier(c)} = CURRENT_TIMESTAMP`;
          }
          return `${quoteDatabricksIdentifier(c)} = S.${quoteDatabricksIdentifier(c)}`;
        })
        .join(', ');

      const insertCols = allCols.map(quoteDatabricksIdentifier).join(', ');
      const insertVals = allCols
        .map((c) => {
          if (c === SYSTEM_COLUMNS.LOADED_AT) {
            return 'CURRENT_TIMESTAMP';
          }
          return `S.${quoteDatabricksIdentifier(c)}`;
        })
        .join(', ');

      const timeGuard = `(S.${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= T.${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR T.${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;

      // Always update system columns even when all data columns are keys
      const systemUpdate = `${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = S.${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}, ${quoteDatabricksIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = CURRENT_TIMESTAMP`;
      const fullUpdateSet = updateSet ? updateSet : systemUpdate;

      const keyColList = keyColumns.map((k) => quoteDatabricksIdentifier(k)).join(', ');
      const dedupSource = `(SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteDatabricksIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn FROM ${qualifiedStaging}) S`;
      const mergeSql =
        `MERGE INTO ${qualifiedTable} T USING ${dedupSource} ON S._rn = 1 AND ${onClause} ` +
        `WHEN MATCHED AND ${timeGuard} THEN UPDATE SET ${fullUpdateSet} ` +
        `WHEN NOT MATCHED AND S._rn = 1 THEN INSERT (${insertCols}) VALUES (${insertVals})`;

      await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(mergeSql);
      });
      return { rowsAffected: records.length };
    } finally {
      try {
        await withRetry(() => this.query(`DROP TABLE IF EXISTS ${qualifiedStaging}`));
      } catch (dropErr) {
        // Best-effort cleanup
        this.logger?.warn('staging_table_drop_failed', {
          table: qualifiedStaging,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
    }
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
    const loadStart = performance.now();
    try {
      return await this.loadJsonl(schemaName, tableName, filePath, columns, strategy, keyColumns);
    } finally {
      const loadMs = performance.now() - loadStart;
      this.logger?.metric('databricks_load_ms', loadMs, { stream: tableName });
    }
  }

  async loadFromUri(
    schemaName: string,
    tableName: string,
    uris: string[],
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<LoadResult> {
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteDatabricksIdentifier(safeSchema)}.${quoteDatabricksIdentifier(safeTable)}`;
    await this.ensureTable(safeSchema, safeTable, columns, options);
    await withRetry(async () => {
      await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
      return this.query(`DELETE FROM ${qualifiedTable}`);
    });

    let rowsAffected = 0;
    for (const uri of uris) {
      const rows = await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(
          `COPY INTO ${qualifiedTable} FROM ${quoteDatabricksStringLiteral(uri)} FILEFORMAT = PARQUET FORMAT_OPTIONS ('mergeSchema' = 'true')`
        );
      });
      rowsAffected += readDatabricksRowCount(rows);
    }
    return { rowsAffected };
  }

  async deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    if ((await this.readTableType(safeSchema, safeTable)) === undefined) return;
    const qualifiedTable = `${quoteDatabricksIdentifier(safeSchema)}.${quoteDatabricksIdentifier(safeTable)}`;
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      // A Delta DELETE commits before the statement returns, so the next INSERT sees it.
      await withRetry(async () => {
        await this.assertOwnershipBeforeMutation(safeSchema, safeTable);
        return this.query(
          `DELETE FROM ${qualifiedTable} WHERE ${quoteDatabricksIdentifier(column)} IN (${batch.map(() => '?').join(', ')})`,
          batch
        );
      });
    }
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const operation = this.activeOperation;
    if (!operation) return;
    if (!operation.cancel) {
      throw new Error('Databricks destination operation does not expose cancel().');
    }
    await operation.cancel();
  }

  async close(): Promise<void> {
    if (this.cachedSession) {
      try {
        await this.cachedSession.close();
      } catch {
        // Best-effort cleanup
      }
      this.cachedSession = undefined;
    }
    if (this.cachedConnection) {
      try {
        await this.cachedConnection.close();
      } catch {
        // Best-effort cleanup
      }
      this.cachedConnection = undefined;
    }
  }
}
