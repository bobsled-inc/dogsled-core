import { randomUUID } from 'node:crypto';

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

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DuckLakeDestinationOptions {
  catalogUrl: string;
  dataPath?: string;
  attachAlias?: string;
  /**
   * Schema in the catalog DB for DuckLake's own metadata tables, emitted as the
   * `METADATA_SCHEMA` ATTACH option (keeps the `ducklake_*` tables out of
   * `public`). Defaults to DuckLake's behavior when omitted.
   */
  metadataSchema?: string;
  memoryLimit?: string;
  logger?: LoaderLogger;
  databaseFactory?: (dbPath: string) => Promise<DuckDbDatabaseLike>;
}

function tempMainTableRef(tableName: string): string {
  return `temp.main.${quoteIdentifier(tableName)}`;
}

function sanitizeAttachAlias(name: string): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid attach alias "${name}": must start with a letter or underscore, followed by alphanumeric characters or underscores`
    );
  }
  return name;
}

export class DuckLakeDestination implements DatabaseDestination {
  private readonly catalogUrl: string;
  private readonly dataPath?: string;
  private readonly attachAlias: string;
  private readonly metadataSchema?: string;
  private readonly memoryLimit?: string;
  private readonly logger?: LoaderLogger;
  private readonly databaseFactory: (dbPath: string) => Promise<DuckDbDatabaseLike>;
  private db: DuckDbDatabaseLike | null = null;
  private conn: DuckDbConnectionLike | null = null;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  private clusterColumnCache = new Map<string, string[]>();

  constructor(options: DuckLakeDestinationOptions) {
    this.catalogUrl = options.catalogUrl;
    this.dataPath = options.dataPath;
    this.attachAlias = sanitizeAttachAlias(options.attachAlias ?? 'lake');
    this.metadataSchema = options.metadataSchema;
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
    this.db = await this.databaseFactory(':memory:');
    this.conn = await this.db.connect();

    if (this.memoryLimit) {
      await runStatement(this.conn, `SET memory_limit = '${escapeSqlString(this.memoryLimit)}'`);
    }

    // ducklake is a core DuckDB extension as of 1.3 (bundled in 1.4.x). The
    // community build is not published for 1.4.x and 404s, so install the core
    // extension first and only fall back to the community repo for older engines.
    try {
      await runStatement(this.conn, 'INSTALL ducklake');
    } catch {
      await runStatement(this.conn, 'INSTALL ducklake FROM community');
    }
    await runStatement(this.conn, 'LOAD ducklake');

    const attachOptionParts: string[] = [];
    if (this.dataPath) {
      attachOptionParts.push(`DATA_PATH '${escapeSqlString(this.dataPath)}'`);
    }
    if (this.metadataSchema) {
      attachOptionParts.push(`METADATA_SCHEMA '${escapeSqlString(this.metadataSchema)}'`);
    }
    const attachOptions = attachOptionParts.length > 0 ? ` (${attachOptionParts.join(', ')})` : '';
    await runStatement(
      this.conn,
      `ATTACH '${escapeSqlString(this.catalogUrl)}' AS ${quoteIdentifier(this.attachAlias)}${attachOptions}`
    );
  }

  private getConn(): DuckDbConnectionLike {
    if (!this.conn) {
      throw new Error('DuckLakeDestination not initialized — call initialize() first');
    }
    return this.conn;
  }

  private buildQualifiedTable(schemaName: string, tableName: string): string {
    return `${quoteIdentifier(this.attachAlias)}.${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
  }

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
          existingType,
          expectedType,
          existingColumnType: reverseMapDbType(existingType),
          expectedColumnType: col.type,
        });
      }
    }

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
    const qualifiedTable = this.buildQualifiedTable(safeSchema, safeTable);

    await runStatement(
      conn,
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.attachAlias)}.${quoteIdentifier(safeSchema)}`
    );

    const cachedColumns = this.columnCache.get(qualifiedTable);
    if (cachedColumns) {
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

    const existingCols = await allRows(
      conn,
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = '${escapeSqlString(this.attachAlias)}' AND table_schema = '${escapeSqlString(safeSchema)}' AND table_name = '${escapeSqlString(safeTable)}'`
    );

    if (existingCols.length === 0) {
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
      const colTypes = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapDuckDbType(c)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMP'],
        [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMP'],
      ]);
      this.columnCache.set(qualifiedTable, colTypes);
      this.clusterColumnCache.set(qualifiedTable, clusterCols);
      return;
    }

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

    const dataCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
    const dataColList = dataCols.map(quoteIdentifier).join(', ');

    const allCols = [...dataCols, SYSTEM_COLUMNS.LOADED_AT];
    const colList = allCols.map(quoteIdentifier).join(', ');

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
    const selectWithLoadedAt = `${dataColList}, CURRENT_TIMESTAMP AS ${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)}`;

    if (strategy === 'append' || strategy === 'full_refresh') {
      if (strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedTable)) {
        await runStatement(conn, `TRUNCATE TABLE ${qualifiedTable}`);
        this.truncatedTables.add(qualifiedTable);
      }

      const beforeResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${qualifiedTable}`);
      const beforeCount = Number(beforeResult[0]?.['c'] ?? 0);

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

    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const stagingName = `_dogsled_stg_${safeTable}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const stagingTable = tempMainTableRef(stagingName);

    try {
      const keyColList = keyColumns.map(quoteIdentifier).join(', ');
      await runStatement(
        conn,
        `CREATE TEMP TABLE ${stagingTable} AS ` +
          `SELECT ${selectWithLoadedAt} FROM (` +
          `  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn ` +
          `  FROM ${readSource}` +
          `) WHERE _rn = 1`
      );

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
      const stagingExtracted = `${stagingTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const targetExtracted = `${qualifiedTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const timeGuard = `${targetExtracted} IS NULL OR ${stagingExtracted} >= ${targetExtracted}`;

      const mergeSql = updateSet
        ? `MERGE INTO ${qualifiedTable} USING ${stagingTable} ON ${onClause} ` +
          `WHEN MATCHED AND ${timeGuard} THEN UPDATE SET ${updateSet} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`
        : `MERGE INTO ${qualifiedTable} USING ${stagingTable} ON ${onClause} ` +
          `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals})`;

      await runStatement(conn, mergeSql);

      const countResult = await allRows(conn, `SELECT COUNT(*) AS c FROM ${stagingTable}`);
      const rowsAffected = Number(countResult[0]?.['c'] ?? 0);
      return { rowsAffected };
    } finally {
      try {
        await runStatement(conn, `DROP TABLE IF EXISTS ${stagingTable}`);
      } catch (dropErr) {
        this.logger?.warn('staging_table_drop_failed', {
          table: stagingTable,
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
    const conn = this.conn;
    const db = this.db;
    this.conn = null;
    this.db = null;
    if (conn) {
      try {
        await runStatement(conn, `DETACH ${quoteIdentifier(this.attachAlias)}`);
      } catch (err) {
        this.logger?.warn('DETACH failed — catalog may not be fully flushed', {
          error: String(err),
        });
      }
    }
    await closeDuckDbResources(conn, db);
  }
}
