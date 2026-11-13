import * as fs from 'node:fs/promises';

import {
  sanitizeSchemaName,
  sanitizeTableName,
  SYSTEM_COLUMNS,
  SYSTEM_COLUMN_NAMES,
  UNIQUE_INDEX_PREFIX,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';
import {
  fillLegacyLoadedAt,
  legacyUniqueIndexNames,
  loadedAtFillSql,
  takeOverLegacyLoadedAt,
} from './loaded-at-takeover.js';
import { withRetry } from '../retry.js';

import type { BatchEncoding, SchemaColumn, ColumnType } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { LoaderLogger } from '../logger.js';
import type { DataType } from 'tedious/lib/data-type.js';

export interface MsSqlConnectionLike {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>;
  close(): Promise<void>;
}

export interface MsSqlConnectionPoolLike {
  acquire(): Promise<MsSqlConnectionLike>;
  release(connection: MsSqlConnectionLike): void;
  close(): Promise<void>;
}

export interface MsSqlDestinationOptions {
  host: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  schema?: string;
  pool?: MsSqlConnectionPoolLike;
  logger?: LoaderLogger;
}

function mapMsSqlType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'FLOAT';
    case 'boolean':
      return 'BIT';
    case 'timestamp':
      return 'DATETIME2(6)';
    case 'string':
      return 'NVARCHAR(4000)';
    case 'array':
      return 'NVARCHAR(MAX)';
    case 'object':
      return 'NVARCHAR(MAX)';
    case 'vector':
      throw new Error('MSSQL destination does not support vector columns');
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

const DELETE_BATCH_SIZE = 500;

function quoteMsSqlIdentifier(identifier: string): string {
  const escaped = identifier.replace(/]/g, ']]');
  return `[${escaped}]`;
}

function normalizeMsSqlType(type: string): string {
  return type
    .toUpperCase()
    .replace(/\(.*\)/, '')
    .trim();
}

export class MsSqlDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly encrypt: boolean;
  private readonly trustServerCertificate: boolean;
  private readonly schema: string;
  private readonly logger?: LoaderLogger;
  private pool?: MsSqlConnectionPoolLike;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();

  constructor(options: MsSqlDestinationOptions) {
    this.host = options.host;
    this.port = options.port ?? 1433;
    this.database = options.database;
    this.username = options.username;
    this.password = options.password;
    this.encrypt = options.encrypt ?? true;
    this.trustServerCertificate = options.trustServerCertificate ?? false;
    this.schema = options.schema ?? 'dbo';
    this.logger = options.logger;
    if (options.pool) {
      this.pool = options.pool;
    }
  }

  private async getPool(): Promise<MsSqlConnectionPoolLike> {
    if (this.pool) {
      return this.pool;
    }

    try {
      const tds = await import('tedious');
      const { Connection } = tds;

      const connection = new Connection({
        server: this.host,
        authentication: {
          type: 'default',
          options: {
            userName: this.username ?? '',
            password: this.password ?? '',
          },
        },
        options: {
          port: this.port,
          database: this.database,
          encrypt: this.encrypt,
          trustServerCertificate: this.trustServerCertificate,
        },
      });

      return new Promise((resolve, reject) => {
        const poolConnections: MsSqlConnectionLike[] = [];
        const pending: Array<(conn: MsSqlConnectionLike) => void> = [];

        connection.on('connect', (err) => {
          if (err) {
            reject(new Error(`Failed to connect to MSSQL: ${err.message}`));
            return;
          }

          const adapter: MsSqlConnectionLike = {
            execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]> {
              return new Promise((resolve, reject) => {
                const request = new tds.Request(sql, (err, _rowCount, rows) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  resolve([rows ?? [], {}]);
                });
                if (params) {
                  for (let i = 0; i < params.length; i++) {
                    const p = params[i];
                    request.addParameter(`p${i}`, getTediousType(p), p ?? null);
                  }
                }
                connection.execSql(request);
              });
            },
            close(): Promise<void> {
              return Promise.resolve();
            },
          };

          function getTediousType(value: unknown): DataType {
            if (value === null || value === undefined) {
              return tds.TYPES.NVarChar;
            }
            if (typeof value === 'number') {
              return Number.isInteger(value) ? tds.TYPES.Int : tds.TYPES.Float;
            }
            if (typeof value === 'boolean') {
              return tds.TYPES.Bit;
            }
            if (value instanceof Date) {
              return tds.TYPES.DateTime2;
            }
            return tds.TYPES.NVarChar;
          }

          poolConnections.push(adapter);

          const pool: MsSqlConnectionPoolLike = {
            async acquire(): Promise<MsSqlConnectionLike> {
              if (poolConnections.length > 0) {
                return poolConnections.pop()!;
              }
              return new Promise((res) => {
                pending.push(res);
              });
            },
            release(conn: MsSqlConnectionLike): void {
              pending.length > 0 ? pending.shift()!(conn) : poolConnections.push(conn);
            },
            async close(): Promise<void> {
              connection.close();
            },
          };

          resolve(pool);
        });

        connection.connect();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load tedious. Install it to use --dest mssql. ${message}`);
    }
  }

  private async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    const pool = await this.getPool();
    const conn = await pool.acquire();
    try {
      const [rows] = await conn.execute(sql, params);
      return rows as unknown[];
    } finally {
      pool.release(conn);
    }
  }

  async initialize(): Promise<void> {
    await this.query('SELECT 1');
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const cacheKey = `${safeSchema}.${safeTable}`;

    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      const qualifiedTable = `${quoteMsSqlIdentifier(safeSchema)}.${quoteMsSqlIdentifier(safeTable)}`;

      const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = cachedColumns.get(col.name);
        const expectedType = mapMsSqlType(col.type);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (
          normalizeMsSqlType(existingType) !== normalizeMsSqlType(expectedType) &&
          !(
            existingType.includes('NVARCHAR') &&
            expectedType.includes('NVARCHAR') &&
            (col.type === 'array' || col.type === 'object')
          )
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
          (col) => `${quoteMsSqlIdentifier(col.name)} ${mapMsSqlType(col.type)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD ${d}`).join(', ')}`;
        await withRetry(() => this.query(ddl));
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapMsSqlType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteMsSqlIdentifier(conflict.column)} ${newSqlType}`;
        await withRetry(() => this.query(widenDdl));
      }

      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapMsSqlType(col.type));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapMsSqlType(conflict.expectedColumnType));
      }

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties);
      }

      return;
    }

    const qualifiedTable = `${quoteMsSqlIdentifier(safeSchema)}.${quoteMsSqlIdentifier(safeTable)}`;

    type ExistingColumn = { COLUMN_NAME: string; DATA_TYPE: string };
    const readColumns = async () =>
      (await this.query(
        `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table`,
        [safeSchema, safeTable]
      )) as ExistingColumn[];
    const byName = (rows: ExistingColumn[]) =>
      new Map(rows.map((row): [string, ExistingColumn] => [row.COLUMN_NAME, row]));
    let existingCols = await readColumns();

    if (existingCols.length === 0) {
      const colDefs = [
        ...columns.map((c) => `${quoteMsSqlIdentifier(c.name)} ${mapMsSqlType(c.type)}`),
        `${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DATETIME2(6)`,
        `${quoteMsSqlIdentifier(SYSTEM_COLUMNS.LOADED_AT)} DATETIME2(6) DEFAULT SYSDATETIME()`,
      ];
      const ddl = `CREATE TABLE ${qualifiedTable} (${colDefs.join(', ')})`;
      await this.query(ddl);

      const columnMap = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapMsSqlType(c.type)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'DATETIME2(6)'],
        [SYSTEM_COLUMNS.LOADED_AT, 'DATETIME2(6)'],
      ]);
      this.columnCache.set(cacheKey, columnMap);

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties);
      }

      return;
    }

    // Take over an earlier loaded-at column before any schema check
    const takeoverColumns = byName(existingCols);
    const takeover = await takeOverLegacyLoadedAt({
      table: qualifiedTable,
      existing: takeoverColumns,
      current: SYSTEM_COLUMNS.LOADED_AT,
      rename: async (from, to) => {
        await this.query(
          `EXEC sp_rename N'${safeSchema}.${safeTable}.${from}', N'${to}', N'COLUMN'`
        );
      },
      reread: async () => byName(await readColumns()),
      logger: this.logger,
    });
    existingCols = [...takeoverColumns].map(([name, row]) => ({ ...row, COLUMN_NAME: name }));

    const existingTypeMap = new Map<string, string>();
    for (const col of existingCols) {
      existingTypeMap.set(col.COLUMN_NAME, col.DATA_TYPE);
    }

    const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
    const newColumns: SchemaColumn[] = [];
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
    const requestedNames = new Set(columns.map((c) => c.name));
    const removedColumns: string[] = [];

    const existingMap = new Map(existingCols.map((col) => [col.COLUMN_NAME, col]));

    for (const col of columns) {
      const existing = existingMap.get(col.name);
      const expectedType = mapMsSqlType(col.type);

      if (!existing) {
        newColumns.push(col);
      } else {
        const normalizedExisting = normalizeMsSqlType(existing.DATA_TYPE);
        const normalizedExpected = normalizeMsSqlType(expectedType);
        if (normalizedExisting !== normalizedExpected) {
          typeConflicts.push({
            column: col.name,
            existingType: existing.DATA_TYPE,
            expectedType: expectedType,
            existingColumnType: reverseMapDbType(existing.DATA_TYPE),
            expectedColumnType: col.type,
          });
        }
      }
    }

    for (const existingName of existingTypeMap.keys()) {
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

    const newColumnDefs: string[] = columnsToAdd.map(
      (col) => `${quoteMsSqlIdentifier(col.name)} ${mapMsSqlType(col.type)}`
    );

    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      newColumnDefs.push(`${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DATETIME2(6)`);
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      newColumnDefs.push(
        `${quoteMsSqlIdentifier(SYSTEM_COLUMNS.LOADED_AT)} DATETIME2(6) DEFAULT SYSDATETIME()`
      );
    }

    if (newColumnDefs.length > 0) {
      const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD ${d}`).join(', ')}`;
      await withRetry(() => this.query(ddl));
    }
    await fillLegacyLoadedAt(takeover, {
      table: qualifiedTable,
      current: SYSTEM_COLUMNS.LOADED_AT,
      fill: async (from, to) => {
        await this.query(loadedAtFillSql(qualifiedTable, quoteMsSqlIdentifier, from, to));
      },
      logger: this.logger,
    });

    for (const conflict of columnsToWiden) {
      const newSqlType = mapMsSqlType(conflict.expectedColumnType);
      const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteMsSqlIdentifier(conflict.column)} ${newSqlType}`;
      await withRetry(() => this.query(widenDdl));
    }

    const columnMap = new Map<string, string>(existingTypeMap);
    for (const col of columnsToAdd) {
      columnMap.set(col.name, mapMsSqlType(col.type));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(conflict.column, mapMsSqlType(conflict.expectedColumnType));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'DATETIME2(6)');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'DATETIME2(6)');
    this.columnCache.set(cacheKey, columnMap);

    if (options?.keyProperties && options.keyProperties.length > 0) {
      await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties);
    }
  }

  private async ensureUniqueIndex(
    qualifiedTable: string,
    tableName: string,
    keyProperties: string[]
  ): Promise<void> {
    if (keyProperties.length === 0) return;
    const keyColList = keyProperties.map(quoteMsSqlIdentifier).join(', ');
    const legacyIndexes = legacyUniqueIndexNames(tableName, UNIQUE_INDEX_PREFIX);
    if (legacyIndexes.length > 0) {
      const legacy = (await this.query(
        `SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID(N'${qualifiedTable}') AND name IN (${legacyIndexes.map((name) => `N'${name}'`).join(', ')})`
      )) as unknown[];
      if (legacy.length > 0) return;
    }
    const indexName = quoteMsSqlIdentifier(`${UNIQUE_INDEX_PREFIX}${tableName}`);
    await this.query(`CREATE UNIQUE INDEX ${indexName} ON ${qualifiedTable} (${keyColList})`).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) throw err;
      }
    );
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
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteMsSqlIdentifier(safeSchema)}.${quoteMsSqlIdentifier(safeTable)}`;

    const dataCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
    const allCols = [...dataCols, SYSTEM_COLUMNS.LOADED_AT];
    const colList = allCols.map(quoteMsSqlIdentifier).join(', ');

    const data = await fs.readFile(filePath, 'utf-8');
    const rows: unknown[][] = [];

    for (const line of data.trim().split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line);
      const rowParams: unknown[] = [];
      for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci]!;
        const val = record[col.name];
        if (val === null || val === undefined) {
          rowParams.push(null);
        } else if (col.type === 'array' || col.type === 'object') {
          rowParams.push(JSON.stringify(val));
        } else {
          rowParams.push(val);
        }
      }
      rowParams.push(record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null);
      rows.push(rowParams);
    }

    if (strategy === 'full_refresh') {
      const qualifiedKey = `${safeSchema}.${safeTable}`;
      const alreadyTruncated = this.truncatedTables.has(qualifiedKey);
      if (!alreadyTruncated) {
        await withRetry(() => this.query(`TRUNCATE TABLE ${qualifiedTable}`));
        this.truncatedTables.add(qualifiedKey);
      }
    }

    if (strategy === 'append' || strategy === 'full_refresh') {
      if (rows.length === 0) {
        return { rowsAffected: 0 };
      }
      const batchSize = 500;
      const rowPlaceholder = `(${dataCols.map(() => '?').join(', ')}, SYSDATETIME())`;
      let rowsAffected = 0;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const placeholders = batch.map(() => rowPlaceholder).join(', ');
        const flatParams = batch.flat();
        const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${placeholders}`;
        await withRetry(() => this.query(sql, flatParams));
        rowsAffected += batch.length;
      }
      return { rowsAffected };
    }

    if (strategy === 'merge') {
      if (keyColumns.length === 0) {
        throw new Error('merge strategy requires at least one key column');
      }

      if (rows.length === 0) {
        return { rowsAffected: 0 };
      }

      const stagingName = `_dogsled_stg_${safeTable}`;
      const quotedStaging = `${quoteMsSqlIdentifier(this.schema)}.${quoteMsSqlIdentifier(stagingName)}`;

      const stagingColDefs = [
        ...columns.map((c) => `${quoteMsSqlIdentifier(c.name)} ${mapMsSqlType(c.type)}`),
        `${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DATETIME2(6)`,
      ].join(', ');

      await withRetry(() => this.query(`CREATE TABLE ${quotedStaging} (${stagingColDefs})`));

      const stagingInsertCols = `${columns.map((c) => quoteMsSqlIdentifier(c.name)).join(', ')}, ${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const colsPerRow = columns.length + 1;
      const batchSize = 500;

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const allValues: unknown[] = [];
        const tuples: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const record = batch[j]!;
          const rowValues: unknown[] = columns.map((c, ci) => {
            const val = (record as unknown[])[ci];
            if (val === null || val === undefined) return null;
            if (c.type === 'array' || c.type === 'object') return JSON.stringify(val);
            return val;
          });
          rowValues.push((record as unknown[])[columns.length] ?? null);
          allValues.push(...rowValues);
          const offset = j * colsPerRow;
          const placeholders = rowValues.map((_, k) => `@p${offset + k}`).join(', ');
          tuples.push(`(${placeholders})`);
        }

        const insertSql = `INSERT INTO ${quotedStaging} (${stagingInsertCols}) VALUES ${tuples.join(', ')}`;
        await withRetry(() => this.query(insertSql, allValues));
      }

      const keyColList = keyColumns.map((k) => quoteMsSqlIdentifier(k)).join(', ');
      const dataColList = [
        ...columns.map((c) => quoteMsSqlIdentifier(c.name)),
        quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ].join(', ');

      const allColsList = [
        ...columns.map((c) => quoteMsSqlIdentifier(c.name)),
        quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
        quoteMsSqlIdentifier(SYSTEM_COLUMNS.LOADED_AT),
      ].join(', ');

      const selectCols = [
        ...columns.map((c) => `S.${quoteMsSqlIdentifier(c.name)}`),
        `S.${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
      ].join(', ');

      const updateSet = [
        ...columns
          .filter((c) => !keyColumns.includes(c.name))
          .map((c) => `T.${quoteMsSqlIdentifier(c.name)} = S.${quoteMsSqlIdentifier(c.name)}`),
        `T.${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = S.${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
        `T.${quoteMsSqlIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = SYSDATETIME()`,
      ].join(', ');

      const dedupSubquery = `(SELECT ${dataColList}, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteMsSqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC) AS _rn FROM ${quotedStaging}) S WHERE S._rn = 1`;

      const mergeSql = `MERGE ${qualifiedTable} WITH (HOLDLOCK) AS T USING ${dedupSubquery} ON ${keyColumns.map((k) => `T.${quoteMsSqlIdentifier(k)} = S.${quoteMsSqlIdentifier(k)}`).join(' AND ')} WHEN MATCHED THEN UPDATE SET ${updateSet} WHEN NOT MATCHED THEN INSERT (${allColsList}) VALUES (${selectCols}, SYSDATETIME())`;

      try {
        await withRetry(() => this.query(mergeSql));
      } finally {
        try {
          await this.query(`DROP TABLE ${quotedStaging}`);
        } catch (dropErr) {
          this.logger?.warn('staging_table_drop_failed', {
            table: quotedStaging,
            error: dropErr instanceof Error ? dropErr.message : String(dropErr),
          });
        }
      }
    }

    return { rowsAffected: rows.length };
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
    // The tedious adapter binds params[i] as @p{i}.
    const existing = await withRetry(() =>
      this.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1`,
        [safeSchema, safeTable]
      )
    );
    if (existing.length === 0) return;
    const qualifiedTable = `${quoteMsSqlIdentifier(safeSchema)}.${quoteMsSqlIdentifier(safeTable)}`;
    // 500 per statement stays well under SQL Server's 2100-parameter cap.
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      const placeholders = batch.map((_, k) => `@p${k}`).join(', ');
      await withRetry(() =>
        this.query(
          `DELETE FROM ${qualifiedTable} WHERE ${quoteMsSqlIdentifier(column)} IN (${placeholders})`,
          batch
        )
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
    if (this.pool) {
      try {
        await this.pool.close();
      } catch {
        // Best-effort cleanup
      }
      this.pool = undefined;
    }
  }
}
