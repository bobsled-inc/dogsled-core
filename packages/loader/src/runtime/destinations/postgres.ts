import { assertDriverVersion } from '@bobsled-inc/connections';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { CommandError } from '@bobsled-inc/protocol';
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
import { serializeVectorValue } from './pgvector.js';
import { withRetry } from '../retry.js';

import type { BatchEncoding, SchemaColumn, ColumnType } from '@bobsled-inc/protocol';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import type { LoaderLogger } from '../logger.js';

const require = createRequire(import.meta.url);

export interface PostgresPoolLike {
  connect(): Promise<PostgresPoolClientLike>;
  end(): Promise<void>;
}

export interface PostgresPoolClientLike {
  query(sql: string, params?: unknown[]): Promise<PostgresQueryResultLike>;
  release(destroy?: boolean): void;
}

export interface PostgresQueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface PostgresDestinationOptions {
  host: string;
  port?: number;
  database: string;
  schema?: string;
  username: string;
  password: string;
  ssl?: boolean;
  logger?: LoaderLogger;
  poolFactory?: (config: PostgresPoolConfig) => PostgresPoolLike;
}

export interface PostgresPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

type VectorSchemaColumn = Extract<SchemaColumn, { type: 'vector' }>;

export function mapPostgresType(column: ColumnType | SchemaColumn): string {
  const type = typeof column === 'string' ? column : column.type;
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
      if (typeof column === 'string') {
        return 'vector';
      }
      return `vector(${(column as VectorSchemaColumn).dimension})`;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
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

export class PostgresDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly schema: string;
  private readonly username: string;
  private readonly password: string;
  private readonly ssl: boolean;
  private readonly logger?: LoaderLogger;
  private readonly poolFactory: (config: PostgresPoolConfig) => PostgresPoolLike;
  private pool?: PostgresPoolLike;
  private readonly activeClients = new Set<PostgresPoolClientLike>();
  private cancelRequested = false;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();
  private tableOwnershipMarkers = new Map<string, string>();
  private vectorExtensionEnsured = false;

  constructor(options: PostgresDestinationOptions) {
    this.host = options.host;
    this.port = options.port ?? 5432;
    this.database = options.database;
    this.schema = options.schema ?? 'public';
    this.username = options.username;
    this.password = options.password;
    this.ssl = options.ssl ?? false;
    this.logger = options.logger;
    this.poolFactory =
      options.poolFactory ??
      ((config: PostgresPoolConfig) => {
        assertDriverVersion('pg', '8.4.0', createRequire(import.meta.url));
        const { Pool } = require('pg') as {
          Pool: new (config: PostgresPoolConfig) => PostgresPoolLike;
        };
        return new Pool(config);
      });
  }

  private getPool(): PostgresPoolLike {
    if (!this.pool) {
      throw new Error('PostgresDestination not initialized — call initialize() first');
    }
    return this.pool;
  }

  private buildPoolConfig(): PostgresPoolConfig {
    return {
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.username,
      password: this.password,
      ssl: this.ssl,
    };
  }

  private async connectClient(): Promise<PostgresPoolClientLike> {
    if (this.cancelRequested) {
      throw new Error('Postgres destination operation cancelled.');
    }
    const client = await this.getPool().connect();
    this.activeClients.add(client);
    if (this.cancelRequested) {
      this.releaseClient(client, true);
      throw new Error('Postgres destination operation cancelled.');
    }
    return client;
  }

  private releaseClient(client: PostgresPoolClientLike, destroy = false): void {
    if (!this.activeClients.has(client)) return;
    this.activeClients.delete(client);
    client.release(destroy);
  }

  async initialize(): Promise<void> {
    try {
      this.pool = this.poolFactory(this.buildPoolConfig());
      const client = await this.connectClient();
      try {
        await withRetry(() =>
          client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`)
        );
      } finally {
        this.releaseClient(client);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      throw new Error(
        code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
          ? `Failed to load pg (node-postgres). Install it to use --dest postgres. ${message}`
          : `Could not connect to Postgres: ${message}`
      );
    }
  }

  private async assertOwnedTable(
    schemaName: string,
    tableName: string,
    client?: PostgresPoolClientLike
  ): Promise<void> {
    const marker = this.tableOwnershipMarkers.get(`${schemaName}.${tableName}`);
    if (marker === undefined) return;
    const ownClient = client === undefined;
    const active = client ?? (await this.connectClient());
    try {
      const qualified = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
      const result = await active.query(
        "SELECT obj_description(c.oid, 'pg_class') AS marker, c.relkind, c.relpersistence FROM pg_class c WHERE c.oid = to_regclass($1)",
        [qualified]
      );
      if (
        result.rows[0]?.['marker'] !== marker ||
        result.rows[0]?.['relkind'] !== 'r' ||
        result.rows[0]?.['relpersistence'] !== 'p'
      ) {
        throw new CommandError('Postgres table ownership marker does not match.', 2);
      }
    } finally {
      if (ownClient) this.releaseClient(active);
    }
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
    const ownershipMarker =
      options?.tableOwnershipMarker ?? this.tableOwnershipMarkers.get(cacheKey);
    if (ownershipMarker !== undefined) {
      if (
        ownershipMarker.trim() !== ownershipMarker ||
        ownershipMarker.length === 0 ||
        ownershipMarker.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(ownershipMarker)
      ) {
        throw new CommandError('Postgres table ownership marker is invalid.', 2);
      }
      this.tableOwnershipMarkers.set(cacheKey, ownershipMarker);
    }

    if (columns.some((column) => column.type === 'vector')) {
      await this.ensureVectorExtension();
    }

    const cachedColumns = this.columnCache.get(cacheKey);
    if (cachedColumns) {
      await this.assertOwnedTable(safeSchema, safeTable);
      const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

      // Build comparison from cached types
      const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
      const requestedNames = new Set(columns.map((c) => c.name));
      const removedColumns: string[] = [];

      for (const col of columns) {
        const existingType = cachedColumns.get(col.name);
        const expectedType = mapPostgresType(col);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (normalizePostgresType(existingType) !== normalizePostgresType(expectedType)) {
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
          (col) => `${quoteIdentifier(col.name)} ${mapPostgresType(col)}`
        );
        const ddl = `ALTER TABLE ${qualifiedTable} ${newColumnDefs.map((d) => `ADD COLUMN ${d}`).join(', ')}`;
        const client = await this.connectClient();
        try {
          await withRetry(() => client.query(ddl));
        } finally {
          this.releaseClient(client);
        }
      }

      for (const conflict of columnsToWiden) {
        const newSqlType = mapPostgresType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType} USING ${quoteIdentifier(conflict.column)}::${newSqlType}`;
        const client = await this.connectClient();
        try {
          await withRetry(() => client.query(widenDdl));
        } finally {
          this.releaseClient(client);
        }
      }

      // Update cache after changes
      for (const col of columnsToAdd) {
        cachedColumns.set(col.name, mapPostgresType(col));
      }
      for (const conflict of columnsToWiden) {
        cachedColumns.set(conflict.column, mapPostgresType(conflict.expectedColumnType));
      }

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties);
      }

      return;
    }

    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;

    const client = await this.connectClient();
    try {
      const readColumns = async () => {
        const result = await withRetry(() =>
          client.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
            [safeSchema, safeTable]
          )
        );
        return new Map(
          result.rows.map((row) => [
            String(row['column_name']),
            normalizePostgresType(String(row['data_type'])),
          ])
        );
      };
      const existingMap = await readColumns();

      if (existingMap.size === 0) {
        const colDefs = [
          ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapPostgresType(c)}`),
          `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMPTZ`,
          `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} TIMESTAMPTZ DEFAULT NOW()`,
        ];
        if (ownershipMarker === undefined) {
          await withRetry(() =>
            client.query(`CREATE TABLE IF NOT EXISTS ${qualifiedTable} (${colDefs.join(', ')})`)
          );
        } else {
          await client.query('BEGIN');
          try {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [qualifiedTable]);
            const existing = await client.query('SELECT to_regclass($1) AS table_oid', [
              qualifiedTable,
            ]);
            if (existing.rows[0]?.['table_oid'] === null) {
              await client.query(`CREATE TABLE ${qualifiedTable} (${colDefs.join(', ')})`);
              await client.query(
                `COMMENT ON TABLE ${qualifiedTable} IS '${ownershipMarker.replaceAll("'", "''")}'`
              );
            }
            await this.assertOwnedTable(safeSchema, safeTable, client);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }
        const actual =
          ownershipMarker === undefined
            ? null
            : await client.query(
                `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
                [safeSchema, safeTable]
              );
        const columnMap =
          actual === null
            ? new Map<string, string>([
                ...columns.map((c): [string, string] => [c.name, mapPostgresType(c)]),
                [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMPTZ'],
                [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMPTZ'],
              ])
            : new Map<string, string>(
                actual.rows.map((row) => [
                  String(row['column_name']),
                  normalizePostgresType(String(row['data_type'])),
                ])
              );
        if (ownershipMarker !== undefined) {
          const expected = new Map<string, string>([
            ...columns.map((c): [string, string] => [
              c.name,
              normalizePostgresType(mapPostgresType(c)),
            ]),
            [SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMPTZ'],
            [SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMPTZ'],
          ]);
          if (
            columnMap.size !== expected.size ||
            [...expected].some(([name, type]) => columnMap.get(name) !== type)
          ) {
            throw new CommandError(
              'Reserved Postgres table schema does not match the requested columns.',
              2
            );
          }
        }
        this.columnCache.set(cacheKey, columnMap);

        if (options?.keyProperties && options.keyProperties.length > 0) {
          await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties, client);
        }

        return;
      }

      // Take over an earlier loaded-at column, then build the schema comparison
      await this.assertOwnedTable(safeSchema, safeTable, client);
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
        const expectedType = mapPostgresType(col);
        if (existingType === undefined) {
          newColumns.push(col);
        } else if (normalizePostgresType(existingType) !== normalizePostgresType(expectedType)) {
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
        (col) => `${quoteIdentifier(col.name)} ${mapPostgresType(col)}`
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
        logger: this.logger,
      });

      // Widen columns one at a time
      for (const conflict of columnsToWiden) {
        const newSqlType = mapPostgresType(conflict.expectedColumnType);
        const widenDdl = `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(conflict.column)} TYPE ${newSqlType} USING ${quoteIdentifier(conflict.column)}::${newSqlType}`;
        await withRetry(() => client.query(widenDdl));
      }

      // Update column cache
      const columnMap = new Map<string, string>(existingMap);
      for (const col of columnsToAdd) {
        columnMap.set(col.name, mapPostgresType(col));
      }
      for (const conflict of columnsToWiden) {
        columnMap.set(conflict.column, mapPostgresType(conflict.expectedColumnType));
      }
      columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'TIMESTAMPTZ');
      columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'TIMESTAMPTZ');
      this.columnCache.set(cacheKey, columnMap);

      if (options?.keyProperties && options.keyProperties.length > 0) {
        await this.ensureUniqueIndex(qualifiedTable, safeTable, options.keyProperties, client);
      }
    } finally {
      this.releaseClient(client);
    }
  }

  private async ensureVectorExtension(): Promise<void> {
    if (this.vectorExtensionEnsured) {
      return;
    }

    const client = await this.connectClient();
    try {
      await withRetry(() => client.query('CREATE EXTENSION IF NOT EXISTS vector'));
      this.vectorExtensionEnsured = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CommandError(
        'Postgres destination requires the pgvector extension for vector columns. ' +
          'Ask your DBA to run `CREATE EXTENSION vector;` before loading embedded data. ' +
          `Original error: ${detail}`,
        2
      );
    } finally {
      this.releaseClient(client);
    }
  }

  private async ensureUniqueIndex(
    qualifiedTable: string,
    tableName: string,
    keyProperties: string[],
    existingClient?: PostgresPoolClientLike
  ): Promise<void> {
    if (keyProperties.length === 0) return;
    const keyColList = keyProperties.map((k) => quoteIdentifier(k)).join(', ');
    const indexName = quoteIdentifier(`${UNIQUE_INDEX_PREFIX}${tableName}`);
    const legacyIndexes = legacyUniqueIndexNames(tableName, UNIQUE_INDEX_PREFIX);
    const client = existingClient ?? (await this.connectClient());
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
      if (!existingClient) {
        this.releaseClient(client);
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
    const safeSchema = sanitizeSchemaName(schemaName);
    const safeTable = sanitizeTableName(tableName);
    const qualifiedTable = `${quoteIdentifier(safeSchema)}.${quoteIdentifier(safeTable)}`;
    await this.assertOwnedTable(safeSchema, safeTable);

    if (strategy === 'append' || strategy === 'full_refresh') {
      const qualifiedKey = `${safeSchema}.${safeTable}`;
      if (strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedKey)) {
        const client = await this.connectClient();
        try {
          await this.assertOwnedTable(safeSchema, safeTable, client);
          await withRetry(() => client.query(`TRUNCATE TABLE ${qualifiedTable}`));
          this.truncatedTables.add(qualifiedKey);
        } finally {
          this.releaseClient(client);
        }
      }

      const data = await fs.readFile(filePath, 'utf-8');
      const records = data
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));

      // Column list: data columns + _time_extracted as params, _dogsled_loaded_at via NOW()
      const paramCols = [
        ...columns.map((c) => quoteIdentifier(c.name)),
        quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED),
      ];
      const colList = [...paramCols, quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)].join(', ');

      const client = await this.connectClient();
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
              ...columns.map((c) => serializeValue(record[c.name], c.type)),
              record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null,
            ];
            allValues.push(...rowValues);
            const offset = j * colsPerRow;
            const placeholders = rowValues.map((_, k) => `$${offset + k + 1}`).join(', ');
            tuples.push(`(${placeholders}, NOW())`);
          }

          const result = await withRetry(() =>
            this.assertOwnedTable(safeSchema, safeTable, client).then(() =>
              client.query(
                `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${tuples.join(', ')}`,
                allValues
              )
            )
          );
          rowsAffected += result.rowCount ?? 0;
        }
        return { rowsAffected };
      } finally {
        this.releaseClient(client);
      }
    }

    if (keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    // Temp tables are session-scoped and don't belong to a schema
    const stagingName = `_dogsled_stg_${safeTable}`;
    const quotedStaging = quoteIdentifier(stagingName);

    const client = await this.connectClient();
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const records = data
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));

      const stagingColDefs = [
        ...columns.map((c) => `${quoteIdentifier(c.name)} ${mapPostgresType(c)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} TIMESTAMPTZ`,
      ].join(', ');

      await withRetry(() => client.query(`CREATE TEMP TABLE ${quotedStaging} (${stagingColDefs})`));

      const stagingInsertCols = `${columns.map((c) => quoteIdentifier(c.name)).join(', ')}, ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`;
      const colsPerRow = columns.length + 1;
      const batchSize = 500;

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const allValues: unknown[] = [];
        const tuples: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const record = batch[j]!;
          const rowValues: unknown[] = columns.map((c) => serializeValue(record[c.name], c.type));
          rowValues.push(record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null);
          allValues.push(...rowValues);
          const offset = j * colsPerRow;
          const placeholders = rowValues.map((_, k) => `$${offset + k + 1}`).join(', ');
          tuples.push(`(${placeholders})`);
        }

        await withRetry(() =>
          client.query(
            `INSERT INTO ${quotedStaging} (${stagingInsertCols}) VALUES ${tuples.join(', ')}`,
            allValues
          )
        );
      }

      const keyColList = keyColumns.map((k) => quoteIdentifier(k)).join(', ');
      const dataColList = [
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
          .map((c) => `${quoteIdentifier(c.name)} = S.${quoteIdentifier(c.name)}`),
        `${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} = S.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}`,
        `${quoteIdentifier(SYSTEM_COLUMNS.LOADED_AT)} = NOW()`,
      ].join(', ');

      const timeGuard = `(S.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} >= T.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} OR T.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} IS NULL)`;

      const selectCols = columns.map((c) => `S.${quoteIdentifier(c.name)}`).join(', ');
      const dedupSubquery = `(SELECT ${dataColList}, ROW_NUMBER() OVER (PARTITION BY ${keyColList} ORDER BY ${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)} DESC NULLS LAST) AS _rn FROM ${quotedStaging}) S WHERE S._rn = 1`;
      const mergeSql = `INSERT INTO ${qualifiedTable} (${allCols}) SELECT ${selectCols}, S.${quoteIdentifier(SYSTEM_COLUMNS.TIME_EXTRACTED)}, NOW() FROM ${dedupSubquery} ON CONFLICT (${keyColList}) DO UPDATE SET ${updateSet} WHERE ${timeGuard}`;

      await this.assertOwnedTable(safeSchema, safeTable, client);
      const result = await withRetry(() => client.query(mergeSql));
      return { rowsAffected: result.rowCount ?? 0 };
    } finally {
      // Drop staging table on same connection that created it (session-scoped temp table)
      try {
        await client.query(`DROP TABLE IF EXISTS ${quotedStaging}`);
      } catch (dropErr) {
        // Best-effort; temp table is auto-cleaned when connection is released
        this.logger?.warn('staging_table_drop_failed', {
          table: quotedStaging,
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      }
      this.releaseClient(client);
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
    const client = await this.connectClient();
    try {
      const existing = await withRetry(() =>
        client.query('SELECT to_regclass($1) AS table_oid', [qualifiedTable])
      );
      if (existing.rows[0]?.['table_oid'] == null) return;
      await this.assertOwnedTable(safeSchema, safeTable, client);
      // Autocommit DELETE: committed and visible to the following INSERT before it resolves.
      for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
        const batch = values.slice(i, i + DELETE_BATCH_SIZE);
        await withRetry(() =>
          client.query(`DELETE FROM ${qualifiedTable} WHERE ${quoteIdentifier(column)} = ANY($1)`, [
            batch,
          ])
        );
      }
    } finally {
      this.releaseClient(client);
    }
  }

  // Intentionally no `loadFromUri` override. The DatabaseDestination
  // interface marks it optional, and cross-warehouse callers route via the
  // `typeof destination.loadFromUri === 'function'` capability check. Postgres
  // has no native staged-URI ingest equivalent to BigQuery `LOAD DATA` or
  // Snowflake `COPY INTO`, so leaving the method undefined makes the publisher
  // fall back to JSONL streaming up-front instead of attempting an UNLOAD path
  // that always throws and degrades into a noisy warning per source.

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    for (const client of [...this.activeClients]) {
      this.releaseClient(client, true);
    }
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
  if (type === 'vector') {
    return serializeVectorValue(value);
  }
  if (type === 'array' || type === 'object') {
    return JSON.stringify(value);
  }
  return value;
}
