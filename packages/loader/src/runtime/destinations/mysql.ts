import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { assertDriverVersion } from '@bobsled-inc/connections';

import { assertBacktickIdentifier, CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
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
  noteLiteral,
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

export interface MySqlConnectionLike {
  execute(query: string, params?: unknown[]): Promise<[unknown, unknown[]]>;
  release(): void;
}

export interface MySqlPoolLike {
  getConnection(): Promise<MySqlConnectionLike>;
  end(): Promise<void>;
}

export interface MySqlDestinationOptions {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean;
  pool?: MySqlPoolLike;
  logger?: LoaderLogger;
}

function buildUnsupportedVectorError(): CommandError {
  return new CommandError(
    JSON.stringify({
      code: 'UNSUPPORTED_COLUMN_TYPE',
      message: 'MySQL destination does not support vector columns',
      destination: 'mysql',
      columnType: 'vector',
    }),
    EXIT_VALIDATION
  );
}

/** Index prefix for TEXT key columns; longer key values are rejected before loading. */
const MYSQL_STRING_KEY_LENGTH = 255;

function buildKeyTooLongError(column: string): CommandError {
  return new CommandError(
    JSON.stringify({
      code: 'KEY_VALUE_TOO_LONG',
      message: `MySQL destination supports string key values up to ${MYSQL_STRING_KEY_LENGTH} characters`,
      destination: 'mysql',
      column,
    }),
    EXIT_VALIDATION
  );
}

function mapMySqlType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'TINYINT(1)';
    case 'timestamp':
      return 'DATETIME(6)';
    case 'string':
      return 'TEXT';
    case 'array':
      return 'JSON';
    case 'object':
      return 'JSON';
    case 'vector':
      throw buildUnsupportedVectorError();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

const DELETE_BATCH_SIZE = 500;

function quoteMySqlIdentifier(identifier: string): string {
  assertBacktickIdentifier(identifier, 'MySQL identifier');
  const escaped = identifier.replace(/`/g, '``');
  return `\`${escaped}\``;
}

export class MySqlDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly user: string;
  private readonly password?: string;
  private readonly ssl: boolean;
  private readonly logger?: LoaderLogger;
  private pool?: MySqlPoolLike;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();

  constructor(options: MySqlDestinationOptions) {
    this.host = options.host;
    this.port = options.port ?? 3306;
    this.database = options.database;
    this.user = options.user;
    this.password = options.password;
    this.ssl = options.ssl ?? false;
    this.logger = options.logger;
    if (options.pool) {
      this.pool = options.pool;
    }
  }

  private async getPool(): Promise<MySqlPoolLike> {
    if (this.pool) {
      return this.pool;
    }

    assertDriverVersion('mysql2', '3.22.0', createRequire(import.meta.url), 'mysql2/promise');
    try {
      const mysql = await import('mysql2/promise');
      const pool = mysql.createPool({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
        password: this.password,
        ssl: this.ssl ? { rejectUnauthorized: true } : undefined,
        waitForConnections: true,
        connectionLimit: 10,
      });
      this.pool = pool as unknown as MySqlPoolLike;
      return this.pool;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load mysql2. Install it to use --dest mysql. ${message}`);
    }
  }

  private async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    return withRetry(async () => {
      const pool = await this.getPool();
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.execute(sql, params);
        return rows as unknown[];
      } finally {
        conn.release();
      }
    });
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
      const qualifiedTable = `${quoteMySqlIdentifier(safeSchema)}.${quoteMySqlIdentifier(safeTable)}`;

      // Build comparison from cached types
      const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = cachedColumns.get(col.name);
        const expectedType = mapMySqlType(col.type);

        if (existingType === undefined) {
          newColumns.push(col);
        } else {
          const normalizedExisting = existingType.toUpperCase().split('(')[0]!;
          const normalizedExpected = expectedType.toUpperCase().split('(')[0]!;
          const isJsonCompatible =
            normalizedExisting === 'JSON' && (col.type === 'array' || col.type === 'object');
          if (normalizedExisting !== normalizedExpected && !isJsonCompatible) {
            typeConflicts.push({
              column: col.name,
              existingType: existingType,
              expectedType: expectedType,
              existingColumnType: reverseMapDbType(existingType),
              expectedColumnType: col.type,
            });
          }
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
          (col) => `${quoteMySqlIdentifier(col.name)} ${mapMySqlType(col.type)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
        await this.query(ddl);
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapMySqlType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quoteMySqlIdentifier(conflict.column)} ${newSqlType}`;
        await this.query(widenDdl);
      }

      // Update cache after changes
      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapMySqlType(col.type));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapMySqlType(conflict.expectedColumnType));
      }

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties, columns);
      }

      return;
    }

    const qualifiedTable = `${quoteMySqlIdentifier(safeSchema)}.${quoteMySqlIdentifier(safeTable)}`;

    type ExistingColumn = { COLUMN_NAME: string; DATA_TYPE: string; COLUMN_TYPE: string };
    const readColumns = async () =>
      (await this.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [safeSchema, safeTable]
      )) as ExistingColumn[];
    const byName = (rows: ExistingColumn[]) =>
      new Map(rows.map((row): [string, ExistingColumn] => [row.COLUMN_NAME, row]));
    let existingCols = await readColumns();

    if (existingCols.length === 0) {
      const colDefs = [
        ...columns.map((c) => `${quoteMySqlIdentifier(c.name)} ${mapMySqlType(c.type)}`),
        `${quoteMySqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DATETIME(6)`,
        `${quoteMySqlIdentifier(SYSTEM_COLUMNS.LOADED_AT)} DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)`,
      ];
      const ddl = `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`;
      await this.query(ddl);

      const columnMap = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapMySqlType(c.type)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'DATETIME(6)'],
        [SYSTEM_COLUMNS.LOADED_AT, 'DATETIME(6)'],
      ]);
      this.columnCache.set(cacheKey, columnMap);

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties, columns);
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
          `ALTER TABLE ${qualifiedTable} RENAME COLUMN ${quoteMySqlIdentifier(from)} TO ${quoteMySqlIdentifier(to)}`
        );
      },
      reread: async () => byName(await readColumns()),
      logger: this.logger,
    });
    existingCols = [...takeoverColumns].map(([name, row]) => ({ ...row, COLUMN_NAME: name }));

    // Build existing type map for comparison
    const existingTypeMap = new Map<string, string>();
    for (const col of existingCols) {
      existingTypeMap.set(col.COLUMN_NAME, col.DATA_TYPE);
    }

    // Build schema comparison
    const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
    const newColumns: SchemaColumn[] = [];
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
    const requestedNames = new Set(columns.map((c) => c.name));
    const removedColumns: string[] = [];

    const existingMap = new Map(existingCols.map((col) => [col.COLUMN_NAME, col]));

    for (const col of columns) {
      const existing = existingMap.get(col.name);
      const expectedType = mapMySqlType(col.type);

      if (!existing) {
        newColumns.push(col);
      } else {
        const existingType = existing.DATA_TYPE.toUpperCase();
        const normalizedExpected = expectedType.toUpperCase().split('(')[0]!;
        const isJsonCompatible =
          existingType === 'JSON' && (col.type === 'array' || col.type === 'object');
        if (existingType !== normalizedExpected && !isJsonCompatible) {
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
      (col) => `${quoteMySqlIdentifier(col.name)} ${mapMySqlType(col.type)}`
    );

    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      newColumnDefs.push(`${quoteMySqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DATETIME(6)`);
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      newColumnDefs.push(
        `${quoteMySqlIdentifier(SYSTEM_COLUMNS.LOADED_AT)} DATETIME(6)${takeover.fillFrom ? '' : ' DEFAULT CURRENT_TIMESTAMP(6)'}`
      );
    }

    if (newColumnDefs.length > 0) {
      const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
      await this.query(ddl);
    }
    await fillLegacyLoadedAt(takeover, {
      table: qualifiedTable,
      current: SYSTEM_COLUMNS.LOADED_AT,
      fill: async (from, to) => {
        await this.query(loadedAtFillSql(qualifiedTable, quoteMySqlIdentifier, from, to));
      },
      marker: {
        done: async (from, note) =>
          (
            (await this.query(
              `SELECT COLUMN_COMMENT AS note FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
              [safeSchema, safeTable, from]
            )) as Array<{ note: string }>
          )[0]?.note?.includes(note) === true,
        mark: async (from, note) => {
          // MySQL keeps a column comment only in a full column definition, so restate it as it is.
          const [column] = (await this.query(
            `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [safeSchema, safeTable, from]
          )) as Array<{ COLUMN_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null }>;
          if (!column) throw new Error(`column ${from} not found`);
          const fallback =
            column.COLUMN_DEFAULT == null || column.COLUMN_DEFAULT === 'NULL'
              ? ''
              : /^current_timestamp(\(\d*\))?$/i.test(column.COLUMN_DEFAULT)
                ? ` DEFAULT ${column.COLUMN_DEFAULT}`
                : ` DEFAULT ${noteLiteral(column.COLUMN_DEFAULT)}`;
          await this.query(
            `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quoteMySqlIdentifier(from)} ${column.COLUMN_TYPE} ${column.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}${fallback} COMMENT ${noteLiteral(note)}`
          );
        },
      },
      logger: this.logger,
    });

    // Widen columns one at a time
    for (const conflict of columnsToWiden) {
      const newSqlType = mapMySqlType(conflict.expectedColumnType);
      const widenDdl = `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quoteMySqlIdentifier(conflict.column)} ${newSqlType}`;
      await this.query(widenDdl);
    }

    // Update column cache
    const columnMap = new Map<string, string>(existingTypeMap);
    for (const col of columnsToAdd) {
      columnMap.set(col.name, mapMySqlType(col.type));
    }
    for (const conflict of columnsToWiden) {
      columnMap.set(conflict.column, mapMySqlType(conflict.expectedColumnType));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'DATETIME(6)');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'DATETIME(6)');
    this.columnCache.set(cacheKey, columnMap);

    if (options?.keyProperties && options.keyProperties.length > 0) {
      await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties, columns);
    }
  }

  private async ensureUniqueIndex(
    qualifiedTable: string,
    tableName: string,
    keyProperties: string[],
    columns: SchemaColumn[]
  ): Promise<void> {
    if (keyProperties.length === 0) return;
    // MySQL cannot index a whole TEXT column; loadAndFinalize rejects longer key values,
    // so the prefix covers the full key and two keys never share one index entry.
    const stringKeys = new Set(columns.filter((c) => c.type === 'string').map((c) => c.name));
    const keyColList = keyProperties
      .map((k) =>
        stringKeys.has(k)
          ? `${quoteMySqlIdentifier(k)}(${MYSQL_STRING_KEY_LENGTH})`
          : quoteMySqlIdentifier(k)
      )
      .join(', ');
    const legacyIndexes = legacyUniqueIndexNames(tableName, UNIQUE_INDEX_PREFIX);
    if (legacyIndexes.length > 0) {
      const legacy = (await this.query(
        `SHOW INDEX FROM ${qualifiedTable} WHERE Key_name IN (${legacyIndexes.map((name) => `'${name}'`).join(', ')})`
      )) as unknown[];
      if (legacy.length > 0) return;
    }
    const indexName = quoteMySqlIdentifier(`${UNIQUE_INDEX_PREFIX}${tableName}`);
    await this.query(`CREATE UNIQUE INDEX ${indexName} ON ${qualifiedTable} (${keyColList})`).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('Duplicate key name')) throw err;
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
    const qualifiedTable = `${quoteMySqlIdentifier(safeSchema)}.${quoteMySqlIdentifier(safeTable)}`;

    const dataCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
    const allCols = [...dataCols, SYSTEM_COLUMNS.LOADED_AT];
    const colList = allCols.map(quoteMySqlIdentifier).join(', ');

    const data = await fs.readFile(filePath, 'utf-8');
    const rows: unknown[][] = [];

    for (const line of data.trim().split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line);
      const rowParams: unknown[] = [];
      for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci]!;
        const val = record[col.name];
        if (
          col.type === 'string' &&
          keyColumns.includes(col.name) &&
          typeof val === 'string' &&
          [...val].length > MYSQL_STRING_KEY_LENGTH
        ) {
          throw buildKeyTooLongError(col.name);
        }
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
        await this.query(`TRUNCATE TABLE ${qualifiedTable}`);
        this.truncatedTables.add(qualifiedKey);
      }
    }

    if (strategy === 'append' || strategy === 'full_refresh') {
      if (rows.length === 0) {
        return { rowsAffected: 0 };
      }
      const batchSize = 500;
      const rowPlaceholder = `(${dataCols.map(() => '?').join(', ')}, CURRENT_TIMESTAMP(6))`;
      let rowsAffected = 0;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const placeholders = batch.map(() => rowPlaceholder).join(', ');
        const flatParams = batch.flat();
        const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${placeholders}`;
        await this.query(sql, flatParams);
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

      const timeGuardExpr = `(VALUES(${quoteMySqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}) >= ${quoteMySqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR ${quoteMySqlIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;
      const updateSet = allCols
        .filter((c) => !keyColumns.includes(c))
        .map((c) => {
          const col = quoteMySqlIdentifier(c);
          return `${col} = IF(${timeGuardExpr}, VALUES(${col}), ${col})`;
        })
        .join(', ');

      const batchSize = 500;
      const rowPlaceholder = `(${dataCols.map(() => '?').join(', ')}, CURRENT_TIMESTAMP(6))`;
      let rowsAffected = 0;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const placeholders = batch.map(() => rowPlaceholder).join(', ');
        const flatParams = batch.flat();
        const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateSet}`;
        await this.query(sql, flatParams);
        rowsAffected += batch.length;
      }
      return { rowsAffected };
    }

    return { rowsAffected: 0 };
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
    const existing = await this.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [safeSchema, safeTable]
    );
    if (existing.length === 0) return;
    const qualifiedTable = `${quoteMySqlIdentifier(safeSchema)}.${quoteMySqlIdentifier(safeTable)}`;
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      await this.query(
        `DELETE FROM ${qualifiedTable} WHERE ${quoteMySqlIdentifier(column)} IN (${batch.map(() => '?').join(', ')})`,
        batch
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
        await this.pool.end();
      } catch {
        // Best-effort cleanup
      }
      this.pool = undefined;
    }
  }
}
