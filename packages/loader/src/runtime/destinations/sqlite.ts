import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import {
  sanitizeSchemaName,
  sanitizeTableName,
  SYSTEM_COLUMNS,
  enforceSchemaContract,
  reverseMapDbType,
} from './database.js';

import type { BatchEncoding, SchemaColumn, ColumnType, LoadStrategy } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { LoaderLogger } from '../logger.js';

// The ESM bundle has no global require; resolve the optional peer from this module.
const require = createRequire(import.meta.url);

// ── DI interfaces for testability ──

export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
  close(): void;
  pragma(source: string): unknown;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
}

export interface SqliteDestinationOptions {
  dbPath: string;
  logger?: LoaderLogger;
  databaseFactory?: (dbPath: string) => SqliteDatabaseLike;
}

function buildUnsupportedVectorError(): CommandError {
  return new CommandError(
    JSON.stringify({
      code: 'UNSUPPORTED_COLUMN_TYPE',
      message: 'SQLite destination does not support vector columns',
      destination: 'sqlite',
      columnType: 'vector',
    }),
    EXIT_VALIDATION
  );
}

// ── Type mapping ──

function mapSqliteType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'INTEGER';
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    case 'timestamp':
      return 'TEXT';
    case 'string':
      return 'TEXT';
    case 'array':
      return 'TEXT';
    case 'object':
      return 'TEXT';
    case 'vector':
      throw buildUnsupportedVectorError();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

function quoteIdentifier(identifier: string): string {
  const escaped = identifier.replace(/"/g, '""');
  return `"${escaped}"`;
}

function normalizeSqliteType(type: string): string {
  const upper = type.toUpperCase();
  switch (upper) {
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
    case 'TINYINT':
      return 'INTEGER';
    case 'FLOAT':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
      return 'REAL';
    case 'VARCHAR':
    case 'NVARCHAR':
    case 'CHAR':
    case 'CLOB':
      return 'TEXT';
    default:
      return upper;
  }
}

function serializeValue(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'boolean') {
    return value ? 1 : 0;
  }
  if (type === 'array' || type === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

const JSONL_BATCH_SIZE = 5000;
const DELETE_BATCH_SIZE = 500;
const JSONL_CHUNK_SIZE = 64 * 1024;

/**
 * Split JSONL input only on \n to preserve U+2028/U+2029 inside JSON strings.
 */
function* readJsonlLines(filePath: string): Generator<string> {
  const fd = openSync(filePath, 'r');
  const chunkBuffer = Buffer.allocUnsafe(JSONL_CHUNK_SIZE);
  const pending: Buffer[] = [];
  let pendingLength = 0;

  try {
    while (true) {
      const bytesRead = readSync(fd, chunkBuffer, 0, JSONL_CHUNK_SIZE, null);
      if (bytesRead === 0) {
        break;
      }

      const chunk = Buffer.from(chunkBuffer.subarray(0, bytesRead));
      pending.push(chunk);
      pendingLength += chunk.length;

      const combined = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLength);
      pending.length = 0;
      pendingLength = 0;

      let start = 0;
      let idx: number;
      while ((idx = combined.indexOf(0x0a, start)) !== -1) {
        yield combined.subarray(start, idx).toString('utf8');
        start = idx + 1;
      }

      if (start < combined.length) {
        const remainder = Buffer.from(combined.subarray(start));
        pending.push(remainder);
        pendingLength = remainder.length;
      }
    }

    if (pendingLength > 0) {
      yield Buffer.concat(pending, pendingLength).toString('utf8');
    }
  } finally {
    closeSync(fd);
  }
}

function* readJsonlRecords(filePath: string): Generator<Record<string, unknown>> {
  let lineNumber = 0;

  for (const rawLine of readJsonlLines(filePath)) {
    lineNumber += 1;

    if (rawLine.length === 0 || rawLine === '\r') {
      continue;
    }

    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON on JSONL line ${lineNumber}: ${message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid JSON record on JSONL line ${lineNumber}: expected object`);
    }

    yield parsed as Record<string, unknown>;
  }
}

function runStatementBatch(
  stmt: SqliteStatementLike,
  records: Record<string, unknown>[],
  getValues: (record: Record<string, unknown>) => unknown[]
): number {
  let rowsAffected = 0;
  for (const record of records) {
    rowsAffected += stmt.run(...getValues(record)).changes;
  }
  return rowsAffected;
}

// ── SQLite Destination ──

export class SqliteDestination implements DatabaseDestination {
  private readonly dbPath: string;
  private readonly logger?: LoaderLogger;
  private readonly databaseFactory: (dbPath: string) => SqliteDatabaseLike;
  private db: SqliteDatabaseLike | null = null;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();

  constructor(options: SqliteDestinationOptions) {
    this.dbPath = path.resolve(options.dbPath);
    this.logger = options.logger;
    this.databaseFactory =
      options.databaseFactory ??
      ((p: string) => {
        // Dynamic require to keep better-sqlite3 as optional peer dep
        const Database = require('better-sqlite3') as new (path: string) => SqliteDatabaseLike;
        return new Database(p);
      });
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    this.db = this.databaseFactory(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  private getDb(): SqliteDatabaseLike {
    if (!this.db) {
      throw new Error('SqliteDestination not initialized — call initialize() first');
    }
    return this.db;
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
      const expectedType = mapSqliteType(col.type);

      if (existingType === undefined) {
        newColumns.push(col);
      } else if (normalizeSqliteType(existingType) !== normalizeSqliteType(expectedType)) {
        typeConflicts.push({
          column: col.name,
          existingType: existingType,
          expectedType: expectedType,
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
    const db = this.getDb();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;
    const cacheKey = `${safeSchema}.${safeTable}`;

    // Check column cache first
    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      const comparison = this.buildComparison(columns, cachedColumns);
      const { columnsToAdd } = enforceSchemaContract(
        options?.schemaBehavior,
        comparison,
        qualifiedTable
      );

      for (const col of columnsToAdd) {
        db.exec(
          `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(col.name)} ${mapSqliteType(col.type)}`
        );
        cachedColumns.set(col.name, mapSqliteType(col.type));
      }

      if (options?.keyProperties && options.keyProperties.length > 0) {
        this.ensureUniqueIndex(db, safeTable, options.keyProperties);
      }

      return;
    }

    // Cold path: query table_info for existing columns (schema-qualified)
    const existingCols = db
      .prepare(`PRAGMA ${quoteIdentifier(safeSchema)}.table_info(${quoteIdentifier(safeTable)})`)
      .all() as Array<{ name: string; type: string }>;

    if (existingCols.length === 0) {
      const colDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapSqliteType(c.type)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TEXT`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TEXT`,
      ];
      db.exec(`CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`);

      const colTypes = new Map<string, string>([
        ...columns.map((c): [string, string] => [c.name, mapSqliteType(c.type)]),
        [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TEXT'],
        [SYSTEM_COLUMNS.LOADED_AT, 'TEXT'],
      ]);
      this.columnCache.set(cacheKey, colTypes);

      if (options?.keyProperties && options.keyProperties.length > 0) {
        this.ensureUniqueIndex(db, safeTable, options.keyProperties);
      }

      return;
    }

    // Table exists — build comparison
    const existingMap = new Map<string, string>(
      existingCols.map((row): [string, string] => [
        String(row.name),
        normalizeSqliteType(String(row.type)),
      ])
    );

    const comparison = this.buildComparison(columns, existingMap);
    const { columnsToAdd } = enforceSchemaContract(
      options?.schemaBehavior,
      comparison,
      qualifiedTable
    );

    for (const col of columnsToAdd) {
      db.exec(
        `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(col.name)} ${mapSqliteType(col.type)}`
      );
    }

    // Ensure system columns exist
    if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
      db.exec(
        `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TEXT`
      );
    }
    if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
      db.exec(
        `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TEXT`
      );
    }

    // Populate cache
    const colTypes = new Map(existingMap);
    for (const col of columnsToAdd) {
      colTypes.set(col.name, mapSqliteType(col.type));
    }
    colTypes.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TEXT');
    colTypes.set(SYSTEM_COLUMNS.LOADED_AT, 'TEXT');
    this.columnCache.set(cacheKey, colTypes);

    if (options?.keyProperties && options.keyProperties.length > 0) {
      this.ensureUniqueIndex(db, safeTable, options.keyProperties);
    }
  }

  private ensureUniqueIndex(
    db: SqliteDatabaseLike,
    tableName: string,
    keyProperties: string[]
  ): void {
    if (keyProperties.length === 0) return;
    const keyColList = keyProperties.map((k) => quoteIdentifier(k)).join(', ');
    const indexName = quoteIdentifier(`_dogsled_uq_${tableName}`);
    // SQLite CREATE INDEX ON clause takes bare table name, not schema-qualified
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${quoteIdentifier(tableName)} (${keyColList})`
    );
  }

  async loadAndFinalize(
    schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: LoadStrategy,
    keyColumns: string[],
    _sourceEncoding?: BatchEncoding
  ): Promise<LoadResult> {
    const db = this.getDb();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;
    const qualifiedKey = `${safeSchema}.${safeTable}`;

    const now = new Date().toISOString();

    if (strategy === 'append' || strategy === 'full_refresh') {
      const paramCols = [
        ...columns.map((c) => c.name),
        SYSTEM_COLUMNS.TIME_EXTRACTED,
        SYSTEM_COLUMNS.LOADED_AT,
      ];
      const colList = paramCols.map(quoteIdentifier).join(', ');
      const placeholders = paramCols.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES (${placeholders})`;
      const stmt = db.prepare(insertSql);
      const shouldTruncate = strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedKey);
      const loadAppend = db.transaction((truncateOnFirstWrite: boolean) => {
        let rowsAffected = 0;
        let truncated = false;
        const batch: Record<string, unknown>[] = [];

        const flushBatch = (): void => {
          if (batch.length === 0) {
            return;
          }

          if (truncateOnFirstWrite && !truncated) {
            db.exec(`DELETE FROM ${qualifiedTable}`);
            truncated = true;
          }

          rowsAffected += runStatementBatch(stmt, batch, (record) => [
            ...columns.map((c) => serializeValue(record[c.name], c.type)),
            record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null,
            now,
          ]);
          batch.length = 0;
        };

        for (const record of readJsonlRecords(filePath)) {
          batch.push(record);
          if (batch.length >= JSONL_BATCH_SIZE) {
            flushBatch();
          }
        }

        flushBatch();
        return { rowsAffected, truncated };
      });

      const result = loadAppend(shouldTruncate);
      if (result.truncated) {
        this.truncatedTables.add(qualifiedKey);
      }

      return { rowsAffected: result.rowsAffected };
    }

    // Merge strategy
    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const stagingName = `_dogsled_stg_${safeTable}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const quotedStaging = quoteIdentifier(stagingName);

    try {
      const stagingColDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapSqliteType(c.type)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TEXT`,
      ].join(', ');
      const stagingCols = [...columns.map((c) => c.name), SYSTEM_COLUMNS.TIME_EXTRACTED];
      const stagingPlaceholders = stagingCols.map(() => '?').join(', ');
      const stagingInsertSql = `INSERT INTO ${quotedStaging} (${stagingCols.map(quoteIdentifier).join(', ')}) VALUES (${stagingPlaceholders})`;

      const mergeIntoTarget = db.transaction(() => {
        db.exec(`CREATE TEMP TABLE ${quotedStaging} (${stagingColDefs})`);
        const stagingStmt = db.prepare(stagingInsertSql);
        const batch: Record<string, unknown>[] = [];

        const flushBatch = (): void => {
          if (batch.length === 0) {
            return;
          }

          runStatementBatch(stagingStmt, batch, (record) => [
            ...columns.map((c) => serializeValue(record[c.name], c.type)),
            record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null,
          ]);
          batch.length = 0;
        };

        for (const record of readJsonlRecords(filePath)) {
          batch.push(record);
          if (batch.length >= JSONL_BATCH_SIZE) {
            flushBatch();
          }
        }

        flushBatch();

        const keyColList = keyColumns.map(quoteIdentifier).join(', ');
        db.exec(
          `DELETE FROM ${quotedStaging} WHERE rowid NOT IN (` +
            ` SELECT rowid FROM (` +
            `  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC, rowid DESC) AS _rn` +
            `  FROM ${quotedStaging}` +
            ` ) WHERE _rn = 1)`
        );

        const countResult = db.prepare(`SELECT COUNT(*) AS c FROM ${quotedStaging}`).get() as
          { c: number } | undefined;
        const rowsAffected = countResult?.c ?? 0;
        if (rowsAffected === 0) {
          return { rowsAffected: 0 };
        }

        const escapedNow = now.replace(/'/g, "''");
        const updateSetParts = [
          ...columns
            .filter((c) => !keyColumns.includes(c.name))
            .map((c) => `${quoteIdentifier(c.name)} = ${quotedStaging}.${quoteIdentifier(c.name)}`),
          `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = ${quotedStaging}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
          `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = '${escapedNow}'`,
        ].join(', ');

        const keyMatchClause = keyColumns
          .map(
            (k) =>
              `${qualifiedTable}.${quoteIdentifier(k)} = ${quotedStaging}.${quoteIdentifier(k)}`
          )
          .join(' AND ');

        const timeGuard = `(${quotedStaging}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= ${qualifiedTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR ${qualifiedTable}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;

        db.exec(
          `UPDATE ${qualifiedTable} SET ${updateSetParts}` +
            ` FROM ${quotedStaging}` +
            ` WHERE ${keyMatchClause} AND ${timeGuard}`
        );

        const targetCols = [
          ...columns.map((c) => quoteIdentifier(c.name)),
          quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
          quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT),
        ].join(', ');

        const selectCols = [
          ...columns.map((c) => `${quotedStaging}.${quoteIdentifier(c.name)}`),
          `${quotedStaging}.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
          `'${escapedNow}'`,
        ].join(', ');

        const notExistsClause = keyColumns
          .map(
            (k) =>
              `${qualifiedTable}.${quoteIdentifier(k)} = ${quotedStaging}.${quoteIdentifier(k)}`
          )
          .join(' AND ');

        db.exec(
          `INSERT INTO ${qualifiedTable} (${targetCols})` +
            ` SELECT ${selectCols} FROM ${quotedStaging}` +
            ` WHERE NOT EXISTS (SELECT 1 FROM ${qualifiedTable} WHERE ${notExistsClause})`
        );

        return { rowsAffected };
      });

      return mergeIntoTarget();
    } finally {
      try {
        db.exec(`DROP TABLE IF EXISTS ${quotedStaging}`);
      } catch (dropErr) {
        // Best-effort cleanup
        this.logger?.warn('staging_table_drop_failed', {
          table: quotedStaging,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
    }
  }

  async deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    const db = this.getDb();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const existingCols = db
      .prepare(`PRAGMA ${quoteIdentifier(safeSchema)}.table_info(${quoteIdentifier(safeTable)})`)
      .all();
    if (existingCols.length === 0) return;
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;
    db.transaction(() => {
      for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
        const batch = values.slice(i, i + DELETE_BATCH_SIZE);
        db.prepare(
          `DELETE FROM ${qualifiedTable} WHERE ${quoteIdentifier(column)} IN (${batch.map(() => '?').join(', ')})`
        ).run(...batch);
      }
    })();
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (db) {
      try {
        db.close();
      } catch (err) {
        this.logger?.warn('SQLite close failed', { error: String(err) });
      }
    }
  }
}
