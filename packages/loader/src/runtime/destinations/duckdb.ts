import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  allRows,
  buildColumnDef,
  closeDuckDbResources,
  escapeSqlString,
  MEMORY_LIMIT_PATTERN,
  mapDuckDbType,
  openDuckDb,
  quoteDuckDbTypeLiteral,
  quoteIdentifier,
  runStatement,
} from '../duckdb-primitives.js';
import {
  buildClusterColumns,
  logTableOptimization,
  sanitizeSchemaName,
  sanitizeTableName,
  SYSTEM_COLUMNS,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';

import type { DuckDbConnectionLike, DuckDbDatabaseLike } from '../duckdb-primitives.js';
import type { LoaderLogger } from '../logger.js';
import type { BatchEncoding, SchemaColumn } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';

export interface DuckDbDestinationOptions {
  dbPath: string;
  memoryLimit?: string;
  logger?: LoaderLogger;
  databaseFactory?: (dbPath: string) => Promise<DuckDbDatabaseLike>;
}

/** Values per DELETE statement for REPLACE. */
const DELETE_BATCH_SIZE = 500;

function tempMainTableRef(tableName: string): string {
  return `temp.main.${quoteIdentifier(tableName)}`;
}

export class DuckDbDestination implements DatabaseDestination {
  private readonly dbPath: string;
  private readonly memoryLimit?: string;
  private readonly logger?: LoaderLogger;
  private readonly databaseFactory: (dbPath: string) => Promise<DuckDbDatabaseLike>;
  private db: DuckDbDatabaseLike | null = null;
  private conn: DuckDbConnectionLike | null = null;
  private catalogName: string | null = null;
  private cancelRequested = false;
  private truncatedTables = new Set<string>();
  /** Cache of known columns and types per qualified table name to avoid repeated information_schema queries. */
  private columnCache = new Map<string, Map<string, string>>();
  /** Cache of cluster columns per table for sorted INSERTs (zone map optimization). */
  private clusterColumnCache = new Map<string, string[]>();

  constructor(options: DuckDbDestinationOptions) {
    this.dbPath = path.resolve(options.dbPath);
    this.logger = options.logger;
    if (options.memoryLimit !== undefined && !MEMORY_LIMIT_PATTERN.test(options.memoryLimit)) {
      throw new Error(
        `Invalid memoryLimit "${options.memoryLimit}": must be a valid memory size (e.g. "512MB", "2GB")`
      );
    }
    this.memoryLimit = options.memoryLimit;
    this.databaseFactory = options.databaseFactory ?? openDuckDb;
  }

  async initialize(): Promise<void> {
    this.throwIfCancelled();
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    this.throwIfCancelled();
    const db = await this.databaseFactory(this.dbPath);
    this.db = db;
    if (this.cancelRequested) {
      await closeDuckDbResources(null, db);
      this.db = null;
      this.throwIfCancelled();
    }
    const conn = await db.connect();
    this.conn = conn;
    if (this.cancelRequested) {
      this.conn = null;
      this.db = null;
      conn.interrupt?.();
      await closeDuckDbResources(conn, db).catch(() => undefined);
      this.throwIfCancelled();
    }
    if (this.memoryLimit) {
      await runStatement(conn, `SET memory_limit = '${escapeSqlString(this.memoryLimit)}'`);
    }
    const catalogRows = await allRows(conn, 'SELECT current_database() AS catalog_name');
    this.catalogName = String(catalogRows[0]?.['catalog_name'] ?? 'memory');
  }

  private getConn(): DuckDbConnectionLike {
    this.throwIfCancelled();
    if (!this.conn) {
      throw new Error('DuckDbDestination not initialized — call initialize() first');
    }
    return this.conn;
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) {
      throw new Error('DuckDB destination operation cancelled.');
    }
  }

  private getCatalogName(): string {
    if (!this.catalogName) {
      throw new Error('DuckDbDestination not initialized — catalog name unavailable');
    }
    return this.catalogName;
  }

  private buildQualifiedSchema(schemaName: string): string {
    return `${quoteIdentifier(this.getCatalogName())}.${quoteIdentifier(schemaName)}`;
  }

  private buildQualifiedTable(schemaName: string, tableName: string): string {
    return `${this.buildQualifiedSchema(schemaName)}.${quoteIdentifier(tableName)}`;
  }

  /**
   * Build a SchemaComparisonResult by comparing requested columns against an existing column map.
   * System columns are excluded from the removedColumns check since they are loader-managed.
   */
  private buildComparison(
    columns: SchemaColumn[],
    existingMap: Map<string, string>
  ): SchemaComparisonResult {
    const systemColumnNames: Set<string> = new Set([
      SYSTEM_COLUMNS.TIME_EXTRACTED,
      SYSTEM_COLUMNS.LOADED_AT,
    ]);
    const newColumns: SchemaColumn[] = [];
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];

    for (const col of columns) {
      const existingType = existingMap.get(col.name);
      const expectedType = mapDuckDbType(col);

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

    // Check for columns in existing table but not in the new schema (excluding system columns)
    const requestedNames = new Set(columns.map((c) => c.name));
    const removedColumns: string[] = [];
    for (const existingName of existingMap.keys()) {
      if (!requestedNames.has(existingName) && !systemColumnNames.has(existingName)) {
        removedColumns.push(existingName);
      }
    }

    return { newColumns, removedColumns, typeConflicts };
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const catalogName = this.getCatalogName();
    const qualifiedSchema = this.buildQualifiedSchema(safeSchema);
    const qualifiedTable = this.buildQualifiedTable(safeSchema, safeTable);

    // Create schema if not exists
    await runStatement(conn, `CREATE SCHEMA IF NOT EXISTS ${qualifiedSchema}`);

    // Check column cache first to avoid repeated information_schema queries
    const cachedColumns = this.columnCache.get(qualifiedTable);
    if (cachedColumns) {
      // Fast path: reuse cached column types
      const comparison = this.buildComparison(columns, cachedColumns);
      const { columnsToAdd, columnsToWiden } = enforceSchemaContract(
        options?.schemaBehavior,
        comparison,
        qualifiedTable
      );

      for (const col of columnsToAdd) {
        await runStatement(conn, `ALTER TABLE ${qualifiedTable} ADD COLUMN ${buildColumnDef(col)}`);
        cachedColumns.set(col.name, mapDuckDbType(col));
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapDuckDbType(conflict.expectedColumnType);
        await runStatement(
          conn,
          `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType}`
        );
        cachedColumns.set(conflict.column, newSqlType);
      }

      return;
    }

    // Cold path: query information_schema for existing columns
    const existingCols = await allRows(
      conn,
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = '${escapeSqlString(catalogName)}' AND table_schema = '${escapeSqlString(safeSchema)}' AND table_name = '${escapeSqlString(safeTable)}'`
    );

    if (existingCols.length === 0) {
      // Create new table with all columns + system columns
      const clusterCols = buildClusterColumns(columns, options);
      logTableOptimization(this.logger, {
        stream: safeTable,
        partitionColumn: null,
        partitionSource: 'not_supported',
        clusterColumns: clusterCols,
      });
      const colDefs = [
        ...columns.map(buildColumnDef),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP`,
      ];
      await runStatement(
        conn,
        `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`
      );
      // Populate cache with the columns we just created
      const colTypes = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapDuckDbType(c)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP'],
        [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP'],
      ]);
      this.columnCache.set(qualifiedTable, colTypes);
      this.clusterColumnCache.set(qualifiedTable, clusterCols);
      return;
    }

    // Table exists — build comparison and enforce schema contract
    const existingMap = new Map<string, string>(
      existingCols.map((row): [string, string] => [
        String(row['column_name']),
        String(row['data_type']),
      ])
    );

    const comparison = this.buildComparison(columns, existingMap);
    const { columnsToAdd, columnsToWiden } = enforceSchemaContract(
      options?.schemaBehavior,
      comparison,
      qualifiedTable
    );
    const clusterCols = buildClusterColumns(columns, options);
    logTableOptimization(this.logger, {
      stream: safeTable,
      partitionColumn: null,
      partitionSource: 'not_supported',
      clusterColumns: clusterCols,
    });

    for (const col of columnsToAdd) {
      await runStatement(conn, `ALTER TABLE ${qualifiedTable} ADD COLUMN ${buildColumnDef(col)}`);
    }

    for (const conflict of columnsToWiden) {
      const newSqlType = mapDuckDbType(conflict.expectedColumnType);
      await runStatement(
        conn,
        `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType}`
      );
    }

    // Also ensure system columns exist
    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      await runStatement(
        conn,
        `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMP`
      );
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      await runStatement(
        conn,
        `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMP`
      );
    }

    // Populate cache with all known columns (including widened types)
    const colTypes = new Map(existingMap);
    for (const col of columnsToAdd) {
      colTypes.set(col.name, mapDuckDbType(col));
    }
    for (const conflict of columnsToWiden) {
      colTypes.set(conflict.column, mapDuckDbType(conflict.expectedColumnType));
    }
    colTypes.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP');
    colTypes.set(SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP');
    this.columnCache.set(qualifiedTable, colTypes);
    this.clusterColumnCache.set(qualifiedTable, clusterCols);
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
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = this.buildQualifiedTable(safeSchema, safeTable);

    // Columns from the JSONL file (read_json sees these)
    const dataCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
    const dataColList = dataCols.map(quoteIdentifier).join(', ');

    // All target columns including _bobsled_loaded_at (set via CURRENT_TIMESTAMP in SELECT)
    const allCols = [...dataCols, SYSTEM_COLUMNS.LOADED_AT];
    const colList = allCols.map(quoteIdentifier).join(', ');

    // Build typed read_json expression (excludes _bobsled_loaded_at — not in JSONL)
    const escapedPath = escapeSqlString(filePath);
    const typedColumns = [
      ...columns.map(
        (c) => `${quoteIdentifier(c.name)}: ${quoteDuckDbTypeLiteral(mapDuckDbType(c))}`
      ),
      `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}: ${quoteDuckDbTypeLiteral('TIMESTAMP')}`,
    ];
    const readSource =
      sourceEncoding.format === 'parquet'
        ? `read_parquet('${escapedPath}')`
        : `read_json('${escapedPath}', format = 'newline_delimited', auto_detect = false, columns = {${typedColumns.join(', ')}})`;

    // DuckDB: set _bobsled_loaded_at via CURRENT_TIMESTAMP in SELECT (free — no extra query).
    // DuckDB cannot use column DEFAULT because function-based defaults corrupt persistent files.
    const selectWithLoadedAt = `${dataColList}, CURRENT_TIMESTAMP AS ${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)}`;

    if (strategy === 'append' || strategy === 'full_refresh') {
      if (strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedTable)) {
        await runStatement(conn, `TRUNCATE TABLE ${qualifiedTable}`);
        this.truncatedTables.add(qualifiedTable);
      }

      // Count rows before INSERT, then after, to derive rowsAffected without
      // reading the JSONL file twice (avoids doubling I/O).
      const beforeResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${qualifiedTable}`);
      const beforeCount = Number(beforeResult[0]?.['c'] ?? 0);

      // Sort by cluster columns for zone map optimization — sorted row groups enable
      // DuckDB's min/max statistics to skip irrelevant row groups during scans
      const clusterCols = this.clusterColumnCache.get(qualifiedTable) ?? [];
      const orderByClause =
        clusterCols.length > 0 ? ` ORDER BY ${clusterCols.map(quoteIdentifier).join(', ')}` : '';

      await runStatement(
        conn,
        `INSERT INTO ${qualifiedTable} (${colList}) SELECT ${selectWithLoadedAt} FROM ${readSource}${orderByClause}`
      );

      const afterResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${qualifiedTable}`);
      const afterCount = Number(afterResult[0]?.['c'] ?? 0);

      return { rowsAffected: afterCount - beforeCount };
    }

    // Merge mode — keyColumns must be non-empty
    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    // 16 hex chars = 64 bits of entropy — short enough for DuckDB identifiers, collision-resistant.
    const stagingName = `_bobsled_stg_${safeTable}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const stagingTable = tempMainTableRef(stagingName);

    try {
      // Create TEMP staging table with deduped data + _bobsled_loaded_at
      const keyColList = keyColumns.map(quoteIdentifier).join(', ');
      await runStatement(
        conn,
        `CREATE TEMP TABLE ${stagingTable} AS ` +
          `SELECT ${selectWithLoadedAt} FROM (` +
          `  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn ` +
          `  FROM ${readSource}` +
          `) WHERE _rn = 1`
      );

      // Build MERGE INTO
      const onClause = keyColumns
        .map(
          (k) => `${qualifiedTable}.${quoteIdentifier(k)} = ${stagingTable}.${quoteIdentifier(k)}`
        )
        .join(' AND ');

      const updateSet = allCols
        .filter((c) => !keyColumns.includes(c))
        .map((c) => `${quoteIdentifier(c)} = ${stagingTable}.${quoteIdentifier(c)}`)
        .join(', ');

      const insertVals = allCols.map((c) => `${stagingTable}.${quoteIdentifier(c)}`).join(', ');

      const timeGuard = `${stagingTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= ${qualifiedTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const mergeSql = updateSet
        ? `MERGE INTO ${qualifiedTable} USING ${stagingTable} ON ${onClause} ` +
          `WHEN MATCHED AND ${timeGuard} THEN UPDATE SET ${updateSet} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`
        : `MERGE INTO ${qualifiedTable} USING ${stagingTable} ON ${onClause} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`;

      await runStatement(conn, mergeSql);

      // Use staging row count as total affected (exact insert/update split unavailable)
      const countResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${stagingTable}`);
      const rowsAffected = Number(countResult[0]?.['c'] ?? 0);

      return { rowsAffected };
    } finally {
      try {
        await runStatement(conn, `DROP TABLE IF EXISTS ${stagingTable}`);
      } catch (dropErr) {
        // Best-effort cleanup — temp tables are auto-dropped on connection close
        this.logger?.warn('staging_table_drop_failed', {
          table: stagingTable,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
    }
  }

  async loadFromUri(
    schemaName: string,
    tableName: string,
    uris: string[],
    columns: SchemaColumn[]
  ): Promise<LoadResult> {
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedSchema = this.buildQualifiedSchema(safeSchema);
    const qualifiedTable = this.buildQualifiedTable(safeSchema, safeTable);
    if (uris.length === 0) {
      await this.ensureTable(safeSchema, safeTable, columns);
      await runStatement(conn, `TRUNCATE TABLE ${qualifiedTable}`);
      return { rowsAffected: 0 };
    }
    const uriList = `[${uris.map((uri) => `'${escapeSqlString(uri)}'`).join(', ')}]`;
    const selectList = columns.map((column) => quoteIdentifier(column.name)).join(', ');

    await runStatement(conn, `CREATE SCHEMA IF NOT EXISTS ${qualifiedSchema}`);
    await runStatement(
      conn,
      `CREATE OR REPLACE TABLE ${qualifiedTable} AS SELECT ${selectList} FROM read_parquet(${uriList})`
    );
    const countResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${qualifiedTable}`);
    return { rowsAffected: Number(countResult[0]?.['c'] ?? 0) };
  }

  async deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    const conn = this.getConn();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const existing = await allRows(
      conn,
      `SELECT 1 FROM information_schema.tables WHERE table_catalog = '${escapeSqlString(this.getCatalogName())}' AND table_schema = '${escapeSqlString(safeSchema)}' AND table_name = '${escapeSqlString(safeTable)}'`
    );
    if (existing.length === 0) return;
    const qualifiedTable = this.buildQualifiedTable(safeSchema, safeTable);
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const list = values
        .slice(i, i + DELETE_BATCH_SIZE)
        .map((value) => `'${escapeSqlString(value)}'`)
        .join(', ');
      await runStatement(
        conn,
        `DELETE FROM ${qualifiedTable} WHERE ${quoteIdentifier(column)} IN (${list})`
      );
    }
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async close(): Promise<void> {
    const conn = this.conn;
    const db = this.db;
    this.conn = null;
    this.db = null;
    this.catalogName = null;
    if (conn) {
      try {
        await runStatement(conn, 'CHECKPOINT');
      } catch (err) {
        this.logger?.warn('CHECKPOINT failed — database may not be fully flushed', {
          error: String(err),
        });
      }
    }
    await closeDuckDbResources(conn, db);
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const connection = this.conn;
    if (!connection) {
      return;
    }
    if (!connection.interrupt) {
      throw new Error('DuckDB destination connection does not expose interrupt().');
    }
    connection.interrupt();
  }
}
