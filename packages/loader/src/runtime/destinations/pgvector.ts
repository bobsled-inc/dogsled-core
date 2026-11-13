import { assertDriverVersion } from '@bobsled-inc/connections';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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

// The ESM bundle has no global require; resolve the optional peer from this module.
const require = createRequire(import.meta.url);

export interface PgVectorPoolLike {
  connect(): Promise<PgVectorPoolClientLike>;
  end(): Promise<void>;
}

export interface PgVectorPoolClientLike {
  query(sql: string, params?: unknown[]): Promise<PgVectorQueryResultLike>;
  release(): void;
}

export interface PgVectorQueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface PgVectorDestinationOptions {
  host: string;
  port?: number;
  database: string;
  schema?: string;
  username: string;
  password: string;
  ssl?: boolean;
  logger?: LoaderLogger;
  poolFactory?: (config: PgVectorPoolConfig) => PgVectorPoolLike;
}

export interface PgVectorPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface VectorColumnConfig {
  columns: string[];
  dimension: number;
}

function serializeVectorComponent(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const numericValue = Number(trimmed);
    return Number.isFinite(numericValue) ? trimmed : null;
  }
  return null;
}

function serializeVectorComponents(values: readonly unknown[]): string | null {
  if (values.length === 0) {
    return null;
  }
  const components: string[] = [];
  for (const value of values) {
    const component = serializeVectorComponent(value);
    if (component === null) {
      return null;
    }
    components.push(component);
  }
  return `[${components.join(',')}]`;
}

function mapPostgresType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE PRECISION';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMPTZ';
    case 'string':
      return 'TEXT';
    case 'array':
      return 'TEXT';
    case 'object':
      return 'TEXT';
    case 'vector':
      return 'vector';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

export function serializeVectorValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return serializeVectorComponents(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return serializeVectorComponents(parsed);
      }
    } catch {
      // Not JSON, treat as string
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      if (inner.length === 0) {
        return null;
      }
      return serializeVectorComponents(inner.split(',').map((part) => part.trim()));
    }
    const scalar = serializeVectorComponent(trimmed);
    return scalar === null ? null : `[${scalar}]`;
  }
  const scalar = serializeVectorComponent(value);
  return scalar === null ? null : `[${scalar}]`;
}

const DELETE_BATCH_SIZE = 500;

function quoteIdentifier(identifier: string): string {
  const escaped = identifier.replace(/"/g, '""');
  return `"${escaped}"`;
}

function normalizePostgresType(type: string): string {
  const upper = type.toUpperCase();
  switch (upper) {
    case 'TIMESTAMP WITHOUT TIME ZONE':
      return 'TIMESTAMP';
    case 'TIMESTAMP WITH TIME ZONE':
      return 'TIMESTAMPTZ';
    case 'CHARACTER VARYING':
      return 'VARCHAR';
    case 'CHARACTER':
      return 'CHAR';
    case 'DOUBLE PRECISION':
      return 'DOUBLE PRECISION';
    default:
      return upper;
  }
}

function normalizeVectorType(type: string): string {
  const upper = type.toUpperCase();
  const match = upper.match(/^VECTOR\((\d+)\)$/);
  if (match) {
    return `vector(${match[1]})`;
  }
  return normalizePostgresType(type);
}

export class PgVectorDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly schema: string;
  private readonly username: string;
  private readonly password: string;
  private readonly ssl: boolean;
  private readonly logger?: LoaderLogger;
  private readonly poolFactory: (config: PgVectorPoolConfig) => PgVectorPoolLike;
  private pool?: PgVectorPoolLike;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  private vectorConfig?: VectorColumnConfig;

  constructor(options: PgVectorDestinationOptions, vectorConfig?: VectorColumnConfig) {
    this.host = options.host;
    this.port = options.port ?? 5432;
    this.database = options.database;
    this.schema = options.schema ?? 'public';
    this.username = options.username;
    this.password = options.password;
    this.ssl = options.ssl ?? false;
    this.logger = options.logger;
    this.vectorConfig = vectorConfig;
    this.poolFactory =
      options.poolFactory ??
      ((config: PgVectorPoolConfig) => {
        assertDriverVersion('pg', '8.4.0', createRequire(import.meta.url));
        const { Pool } = require('pg') as {
          Pool: new (config: PgVectorPoolConfig) => PgVectorPoolLike;
        };
        return new Pool(config);
      });
  }

  private getPool(): PgVectorPoolLike {
    if (!this.pool) {
      throw new Error('PgVectorDestination not initialized — call initialize() first');
    }
    return this.pool;
  }

  private buildPoolConfig(): PgVectorPoolConfig {
    return {
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.username,
      password: this.password,
      ssl: this.ssl,
    };
  }

  private getColumnType(column: { dimension?: number; name: string; type: ColumnType }): string {
    if (column.type === 'vector') {
      if (typeof column.dimension !== 'number') {
        throw new Error(`Vector column "${column.name}" requires a dimension`);
      }
      return `vector(${column.dimension})`;
    }
    if (this.vectorConfig?.columns.includes(column.name)) {
      return `vector(${this.vectorConfig.dimension})`;
    }
    return mapPostgresType(column.type);
  }

  async initialize(): Promise<void> {
    try {
      this.pool = this.poolFactory(this.buildPoolConfig());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      throw new Error(
        code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
          ? `Failed to load pg (node-postgres). Install it to use --dest pgvector. ${message}`
          : `Could not connect to pgvector: ${message}`
      );
    }
    try {
      const client = await this.pool.connect();
      try {
        await withRetry(() =>
          client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`)
        );
        await withRetry(() => client.query(`CREATE EXTENSION IF NOT EXISTS vector`));
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to pgvector database at ${this.host}:${this.port}. ${message}`
      );
    }
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const pool = this.getPool();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const cacheKey = `${safeSchema}.${safeTable}`;

    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

      const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = cachedColumns.get(col.name);
        const expectedType = this.getColumnType(col);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (normalizeVectorType(existingType) !== normalizeVectorType(expectedType)) {
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
          (col) => `${quoteIdentifier(col.name)} ${this.getColumnType(col)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
        const client = await pool.connect();
        try {
          await withRetry(() => client.query(ddl));
        } finally {
          client.release();
        }
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = this.getColumnType({
          name: conflict.column,
          type: conflict.expectedColumnType,
        });
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType}`;
        const client = await pool.connect();
        try {
          await withRetry(() => client.query(widenDdl));
        } finally {
          client.release();
        }
      }

      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, this.getColumnType(col));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(
          conflict.column,
          this.getColumnType({ name: conflict.column, type: conflict.expectedColumnType })
        );
      }

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(pool, qualifiedTable, safeTable, options.keyProperties);
      }

      return;
    }

    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

    const client = await pool.connect();
    try {
      const readColumns = async () => {
        const result = await withRetry(() =>
          client.query(
            `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
           JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
           WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
            [safeSchema, safeTable]
          )
        );
        return new Map(
          result.rows.map((row) => [
            String(row['column_name']),
            normalizeVectorType(String(row['data_type'])),
          ])
        );
      };
      const existingMap = await readColumns();

      if (existingMap.size === 0) {
        const colDefs = [
          ...columns.map((c) => `${quoteIdentifier(c.name)} ${this.getColumnType(c)}`),
          `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMPTZ`,
          `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMPTZ DEFAULT NOW()`,
        ];
        await withRetry(() =>
          client.query(`CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`)
        );
        const columnMap = new Map<string, string>([
          ...columns.map((c): [string, string] => [c.name, this.getColumnType(c)]),
          [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMPTZ'],
          [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMPTZ'],
        ]);
        this.columnCache.set(cacheKey, columnMap);

        if (options?.keyProperties && options.keyProperties.length > 0) {
          await this.ensureUniqueIndex(pool, qualifiedTable, safeTable, options.keyProperties);
        }

        return;
      }

      const takeover = await takeOverLegacyLoadedAt({
        table: qualifiedTable,
        existing: existingMap,
        current: SYSTEM_COLUMNS.LOADED_AT,
        rename: async (from, to) => {
          await client.query(
            `ALTER TABLE ${qualifiedTable} RENAME COLUMN ${quoteIdentifier(from)} TO ${quoteIdentifier(to)}`
          );
        },
        reread: readColumns,
        logger: this.logger,
      });
      const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = existingMap.get(col.name);
        const expectedType = this.getColumnType(col);
        if (existingType === undefined) {
          newColumns.push(col);
        } else if (normalizeVectorType(existingType) !== normalizeVectorType(expectedType)) {
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

      const newColumnDefs: string[] = columnsToAdd.map(
        (col) => `${quoteIdentifier(col.name)} ${this.getColumnType(col)}`
      );

      if (!existingMap.has(SYSTEM_COLUMNS.TIME_EXTRACTED)) {
        newColumnDefs.push(`${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMPTZ`);
      }
      if (!existingMap.has(SYSTEM_COLUMNS.LOADED_AT)) {
        newColumnDefs.push(
          `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMPTZ DEFAULT NOW()`
        );
      }

      if (newColumnDefs.length > 0) {
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
        await withRetry(() => client.query(ddl));
      }
      await fillLegacyLoadedAt(takeover, {
        table: qualifiedTable,
        current: SYSTEM_COLUMNS.LOADED_AT,
        fill: async (from, to) => {
          await client.query(loadedAtFillSql(qualifiedTable, quoteIdentifier, from, to));
        },
        marker: {
          done: async (from, note) =>
            (
              await client.query(
                `SELECT col_description(a.attrelid, a.attnum) AS note FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = $2`,
                [qualifiedTable, from]
              )
            ).rows[0]?.['note'] === note,
          mark: async (from, note) => {
            await client.query(
              `COMMENT ON COLUMN ${qualifiedTable}.${quoteIdentifier(from)} IS ${noteLiteral(note)}`
            );
          },
        },
        logger: this.logger,
      });

      for (const conflict of columnsToWiden) {
        const newSqlType = this.getColumnType({
          name: conflict.column,
          type: conflict.expectedColumnType,
        });
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType}`;
        await withRetry(() => client.query(widenDdl));
      }

      const columnMap = new Map<string, string>(existingMap);
      for (const col of columnsToAdd) {
        columnMap.set(col.name, this.getColumnType(col));
      }
      for (const conflict of columnsToWiden) {
        columnMap.set(
          conflict.column,
          this.getColumnType({ name: conflict.column, type: conflict.expectedColumnType })
        );
      }
      columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMPTZ');
      columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMPTZ');
      this.columnCache.set(cacheKey, columnMap);

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(pool, qualifiedTable, safeTable, options.keyProperties);
      }
    } finally {
      client.release();
    }
  }

  private async ensureUniqueIndex(
    pool: PgVectorPoolLike,
    qualifiedTable: string,
    tableName: string,
    keyProperties: string[]
  ): Promise<void> {
    if (keyProperties.length === 0) return;
    const keyColList = keyProperties.map((k) => quoteIdentifier(k)).join(', ');
    const indexName = quoteIdentifier(`${UNIQUE_INDEX_PREFIX}${tableName}`);
    const legacyIndexes = legacyUniqueIndexNames(tableName, UNIQUE_INDEX_PREFIX);
    const client = await pool.connect();
    try {
      if (legacyIndexes.length > 0) {
        const legacy = await withRetry(() =>
          client.query(
            `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1::regclass AND c.relname = ANY($2::text[])`,
            [qualifiedTable, legacyIndexes]
          )
        );
        if (legacy.rows.length > 0) return;
      }
      await withRetry(() =>
        client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${qualifiedTable} (${keyColList})`
        )
      );
    } finally {
      client.release();
    }
  }

  private serializeVectorValue(value: unknown): string | null {
    return serializeVectorValue(value);
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
    const pool = this.getPool();
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

    if (strategy === 'append' || strategy === 'full_refresh') {
      const qualifiedKey = `${safeSchema}.${safeTable}`;
      if (strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedKey)) {
        const client = await pool.connect();
        try {
          await withRetry(() => client.query(`TRUNCATE TABLE ${qualifiedTable}`));
          this.truncatedTables.add(qualifiedKey);
        } finally {
          client.release();
        }
      }

      const data = await fs.readFile(filePath, 'utf-8');
      const records = data
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));

      const paramCols = [
        ...columns.map((c) => quoteIdentifier(c.name)),
        quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ];
      const colList = [...paramCols, quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)].join(', ');

      const client = await pool.connect();
      try {
        if (records.length === 0) {
          return { rowsAffected: 0 };
        }

        const batchSize = 500;
        const colsPerRow = paramCols.length;
        let rowsAffected = 0;

        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const allValues: unknown[] = [];
          const tuples: string[] = [];

          for (let j = 0; j < batch.length; j++) {
            const record = batch[j]!;
            const rowValues: unknown[] = [
              ...columns.map((c) => {
                if (this.vectorConfig?.columns.includes(c.name)) {
                  return this.serializeVectorValue(record[c.name]);
                }
                return serializeValue(record[c.name], c.type);
              }),
              record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null,
            ];
            allValues.push(...rowValues);
            const offset = j * colsPerRow;
            const placeholders = rowValues.map((_, k) => `$${offset + k + 1}`).join(', ');
            tuples.push(`(${placeholders}, NOW())`);
          }

          const result = await client.query(
            `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${tuples.join(', ')}`,
            allValues
          );
          rowsAffected += result.rowCount ?? 0;
        }
        return { rowsAffected };
      } finally {
        client.release();
      }
    }

    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    const stagingName = `_dogsled_stg_${safeTable}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const quotedStaging = quoteIdentifier(stagingName);

    const client = await pool.connect();
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const records = data
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));

      await client.query('BEGIN');

      const stagingColDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${this.getColumnType(c)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMPTZ`,
      ].join(', ');

      await client.query(`CREATE TEMP TABLE ${quotedStaging} (${stagingColDefs})`);

      const stagingInsertCols = `${columns.map((c) => quoteIdentifier(c.name)).join(', ')}, ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const colsPerRow = columns.length + 1;
      const batchSize = 500;

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const allValues: unknown[] = [];
        const tuples: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const record = batch[j]!;
          const rowValues: unknown[] = columns.map((c) => {
            if (this.vectorConfig?.columns.includes(c.name)) {
              return this.serializeVectorValue(record[c.name]);
            }
            return serializeValue(record[c.name], c.type);
          });
          rowValues.push(record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null);
          allValues.push(...rowValues);
          const offset = j * colsPerRow;
          const placeholders = rowValues.map((_, k) => `$${offset + k + 1}`).join(', ');
          tuples.push(`(${placeholders})`);
        }

        await client.query(
          `INSERT INTO ${quotedStaging} (${stagingInsertCols}) VALUES ${tuples.join(', ')}`,
          allValues
        );
      }

      const keyColList = keyColumns.map((k) => quoteIdentifier(k)).join(', ');
      const dataColListWithTime = [
        ...columns.map((c) => quoteIdentifier(c.name)),
        quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ].join(', ');

      const allCols = [
        ...columns.map((c) => quoteIdentifier(c.name)),
        quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
        quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT),
      ].join(', ');

      const updateSet = [
        ...columns
          .filter((c) => !keyColumns.includes(c.name))
          .map((c) => `${quoteIdentifier(c.name)} = EXCLUDED.${quoteIdentifier(c.name)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = EXCLUDED.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = NOW()`,
      ].join(', ');

      const timeGuard = `(EXCLUDED.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= T.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR T.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;

      const dedupSelectCols = dataColListWithTime;
      const dedupSubquery = `(SELECT ${dedupSelectCols}, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn FROM ${quotedStaging}) S WHERE S._rn = 1`;
      const aliasedSelectCols = [
        ...columns.map((c) => `S.${quoteIdentifier(c.name)}`),
        `S.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
        'NOW()',
      ].join(', ');
      const mergeSql = `INSERT INTO ${qualifiedTable} AS T (${allCols}) SELECT ${aliasedSelectCols} FROM ${dedupSubquery} ON CONFLICT (${keyColList}) DO UPDATE SET ${updateSet} WHERE ${timeGuard}`;

      const result = await client.query(mergeSql);
      await client.query('COMMIT');
      return { rowsAffected: result.rowCount ?? 0 };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      throw err;
    } finally {
      try {
        await client.query(`DROP TABLE IF EXISTS ${quotedStaging}`);
      } catch (dropErr) {
        this.logger?.warn('staging_table_drop_failed', {
          table: quotedStaging,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
      client.release();
    }
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
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;
    const client = await this.getPool().connect();
    try {
      const existing = await withRetry(() =>
        client.query('SELECT to_regclass($1) AS table_oid', [qualifiedTable])
      );
      if (existing.rows[0]?.['table_oid'] == null) return;
      // Autocommit DELETE: committed (index entries included) before the next INSERT runs.
      for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
        const batch = values.slice(i, i + DELETE_BATCH_SIZE);
        await withRetry(() =>
          client.query(`DELETE FROM ${qualifiedTable} WHERE ${quoteIdentifier(column)} = ANY($1)`, [
            batch,
          ])
        );
      }
    } finally {
      client.release();
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
      await this.pool.end();
      this.pool = undefined;
    }
  }
}

function serializeValue(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'array' || type === 'object') {
    return JSON.stringify(value);
  }
  return value;
}
