import { randomUUID } from 'node:crypto';

import { ExtractorConfigError, ExtractorDataError } from './errors.js';
import {
  MANIFEST_COLUMNS,
  rowToManifest,
  rowToParams,
  type ManifestColumn,
} from './cache-manifest-table.js';

import type {
  AtomicityLevel,
  CacheManifestRow,
  CacheSqlExecutor,
  CacheSubstrate,
  CacheSubstrateFactoryOptions,
  CacheWriteHandle,
  FtsCapability,
  VectorCapability,
} from './cache-substrate.js';
import type { WarehouseClient } from './warehouse-client.js';

const DEFAULT_CACHE_SCHEMA = 'lazy_cache';
const CACHE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
type SqlCacheKind = 'postgres' | 'snowflake' | 'bigquery';

interface SqlCacheHandleInner {
  tableName: string;
  targetRef: string;
  stagingRef?: string;
}

export function warehouseClientCacheExecutor(client: WarehouseClient): CacheSqlExecutor {
  return {
    query: async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
      if (client.queryRows) {
        return client.queryRows(sql, params);
      }
      const rows: Record<string, unknown>[] = [];
      for await (const batch of client.execute(sql, params)) {
        rows.push(...batch);
      }
      return rows;
    },
  };
}

export function createPostgresCacheSubstrate(
  options?: CacheSubstrateFactoryOptions
): CacheSubstrate {
  return new SqlCacheSubstrate('postgres', options);
}

export function createSnowflakeCacheSubstrate(
  options?: CacheSubstrateFactoryOptions
): CacheSubstrate {
  return new SqlCacheSubstrate('snowflake', options);
}

export function createBigQueryCacheSubstrate(
  options?: CacheSubstrateFactoryOptions
): CacheSubstrate {
  return new SqlCacheSubstrate('bigquery', options);
}

class SqlCacheSubstrate implements CacheSubstrate {
  readonly atomicityLevel: AtomicityLevel;
  readonly ftsCapability: FtsCapability;
  readonly vectorCapability: VectorCapability;

  private readonly executor: CacheSqlExecutor;
  private readonly schema: string;
  private readonly ensuredTables = new Set<string>();
  private readonly pending = new Map<string, SqlCacheHandleInner>();

  constructor(
    readonly kind: SqlCacheKind,
    options: CacheSubstrateFactoryOptions | undefined
  ) {
    this.executor = requireSqlExecutor(kind, options);
    this.schema = normalizeCacheIdentifier(options?.schema ?? DEFAULT_CACHE_SCHEMA, 'schema');

    switch (kind) {
      case 'postgres':
        this.atomicityLevel = 'transaction';
        this.ftsCapability = 'native_index';
        this.vectorCapability = 'native';
        break;
      case 'snowflake':
        this.atomicityLevel = 'transaction';
        this.ftsCapability = 'full_scan_only';
        this.vectorCapability = 'array_only';
        break;
      case 'bigquery':
        this.atomicityLevel = 'idempotent_writes';
        this.ftsCapability = 'native_index';
        this.vectorCapability = 'array_only';
        break;
    }
  }

  async beginCacheWrite(resource: string): Promise<CacheWriteHandle> {
    if (this.pending.has(resource)) {
      throw new ExtractorDataError(
        `${this.kind} cache substrate: a write is already in flight for resource "${resource}"`
      );
    }
    if (this.atomicityLevel === 'transaction' && this.pending.size > 0) {
      throw new ExtractorDataError(
        `${this.kind} cache substrate: a transactional write is already in flight`
      );
    }

    const tableName = manifestTableName(resource);
    const targetRef = this.tableRef(tableName);
    await this.ensureManifestTable(tableName);

    if (this.atomicityLevel === 'transaction') {
      await this.executor.query('BEGIN');
      const inner: SqlCacheHandleInner = { tableName, targetRef };
      this.pending.set(resource, inner);
      return { resource, inner };
    }

    const stagingName = `${tableName}__staging_${randomUUID().replace(/-/g, '')}`;
    const stagingRef = this.tableRef(stagingName);
    await this.executor.query(
      `CREATE TABLE ${stagingRef} AS SELECT * FROM ${targetRef} WHERE 1 = 0`
    );
    const inner: SqlCacheHandleInner = { tableName, targetRef, stagingRef };
    this.pending.set(resource, inner);
    return { resource, inner };
  }

  async commitCacheWrite(handle: CacheWriteHandle): Promise<void> {
    const inner = this.pending.get(handle.resource);
    if (!inner) {
      throw new ExtractorDataError(
        `${this.kind} cache substrate: no pending write for resource "${handle.resource}"`
      );
    }

    try {
      if (this.kind === 'bigquery') {
        await this.commitBigQueryStaging(inner);
      } else {
        await this.executor.query('COMMIT');
      }
    } finally {
      this.pending.delete(handle.resource);
    }
  }

  async abortCacheWrite(handle: CacheWriteHandle): Promise<void> {
    const inner = this.pending.get(handle.resource);
    if (!inner) return;

    try {
      if (this.kind === 'bigquery') {
        if (inner.stagingRef) {
          await this.executor.query(`DROP TABLE IF EXISTS ${inner.stagingRef}`);
        }
      } else {
        await this.executor.query('ROLLBACK');
      }
    } finally {
      this.pending.delete(handle.resource);
    }
  }

  async readManifest(resource: string): Promise<CacheManifestRow[]> {
    const tableName = manifestTableName(resource);
    await this.ensureManifestTable(tableName);
    const rows = await this.executor.query(
      `SELECT ${MANIFEST_COLUMNS.map((column) => this.quote(column)).join(', ')} FROM ${this.tableRef(
        tableName
      )} ORDER BY ${this.quote('document_version_id')}`
    );
    return rows.map(rowToManifest);
  }

  async writeManifestRow(handle: CacheWriteHandle, row: CacheManifestRow): Promise<void> {
    const inner = this.pending.get(handle.resource);
    if (!inner) {
      throw new ExtractorDataError(
        `${this.kind} cache substrate: write to unstarted resource "${handle.resource}"`
      );
    }

    const targetRef = inner.stagingRef ?? inner.targetRef;
    if (this.kind !== 'bigquery') {
      await this.executor.query(
        `DELETE FROM ${targetRef} WHERE ${this.quote('document_version_id')} = ${this.placeholder(1)}`,
        [row.document_version_id]
      );
    }

    await this.executor.query(this.insertSql(targetRef), rowToParams(row));
  }

  private async ensureManifestTable(tableName: string): Promise<void> {
    if (this.ensuredTables.has(tableName)) return;
    await this.executor.query(this.createSchemaSql());
    await this.executor.query(this.createTableSql(this.tableRef(tableName)));
    this.ensuredTables.add(tableName);
  }

  private async mergeStaging(inner: SqlCacheHandleInner): Promise<void> {
    if (!inner.stagingRef) {
      throw new ExtractorDataError('BigQuery cache substrate: missing staging table');
    }
    const updateColumns = MANIFEST_COLUMNS.filter((column) => column !== 'document_version_id');
    await this.executor.query(
      [
        `MERGE ${inner.targetRef} AS T`,
        `USING ${inner.stagingRef} AS S`,
        `ON T.${this.quote('document_version_id')} = S.${this.quote('document_version_id')}`,
        `WHEN MATCHED THEN UPDATE SET ${updateColumns
          .map((column) => `${this.quote(column)} = S.${this.quote(column)}`)
          .join(', ')}`,
        `WHEN NOT MATCHED THEN INSERT (${MANIFEST_COLUMNS.map((column) => this.quote(column)).join(
          ', '
        )}) VALUES (${MANIFEST_COLUMNS.map((column) => `S.${this.quote(column)}`).join(', ')})`,
      ].join(' ')
    );
  }

  private async commitBigQueryStaging(inner: SqlCacheHandleInner): Promise<void> {
    try {
      await this.mergeStaging(inner);
    } finally {
      if (inner.stagingRef) {
        await this.executor.query(`DROP TABLE IF EXISTS ${inner.stagingRef}`);
      }
    }
  }

  private insertSql(tableRef: string): string {
    const values = MANIFEST_COLUMNS.map((column, index) => {
      const placeholder = this.placeholder(index + 1);
      return column === 'parser_versions'
        ? this.parserVersionsExpression(placeholder)
        : placeholder;
    });
    return `INSERT INTO ${tableRef} (${MANIFEST_COLUMNS.map((column) => this.quote(column)).join(
      ', '
    )}) VALUES (${values.join(', ')})`;
  }

  private createSchemaSql(): string {
    return `CREATE SCHEMA IF NOT EXISTS ${this.quote(this.schema)}`;
  }

  private createTableSql(tableRef: string): string {
    return `CREATE TABLE IF NOT EXISTS ${tableRef} (${MANIFEST_COLUMNS.map((column) =>
      this.columnDefinition(column)
    ).join(
      ', '
    )}${this.kind === 'bigquery' ? '' : `, PRIMARY KEY (${this.quote('document_version_id')})`})`;
  }

  private columnDefinition(column: ManifestColumn): string {
    const name = this.quote(column);
    switch (column) {
      case 'mtime':
      case 'size':
        return `${name} ${this.bigIntType()}`;
      case 'embedding_dimension':
      case 'document_count':
      case 'chunk_count':
        return `${name} ${this.intType()}`;
      case 'parser_versions':
        return `${name} ${this.jsonType()} NOT NULL`;
      case 'cached_at':
        return `${name} ${this.timestampType()} NOT NULL`;
      case 'document_id':
      case 'document_version_id':
      case 'source_uri':
      case 'content_hash':
      case 'chunker_config_hash':
      case 'parse_status':
        return `${name} ${this.textType()} NOT NULL`;
      case 'source_revision':
      case 'etag':
      case 'embedder_role':
      case 'embedder_underlying_model':
        return `${name} ${this.textType()}`;
    }
  }

  private tableRef(tableName: string): string {
    return `${this.quote(this.schema)}.${this.quote(tableName)}`;
  }

  private quote(identifier: string): string {
    if (this.kind === 'bigquery') {
      return `\`${identifier}\``;
    }
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private placeholder(index: number): string {
    if (this.kind === 'postgres') return `$${index}`;
    if (this.kind === 'snowflake') return `:${index}`;
    return '?';
  }

  private parserVersionsExpression(placeholder: string): string {
    if (this.kind === 'postgres') return `CAST(${placeholder} AS JSONB)`;
    if (this.kind === 'snowflake') return `PARSE_JSON(${placeholder})`;
    return `PARSE_JSON(${placeholder})`;
  }

  private textType(): string {
    if (this.kind === 'bigquery') return 'STRING';
    if (this.kind === 'snowflake') return 'VARCHAR';
    return 'TEXT';
  }

  private intType(): string {
    if (this.kind === 'bigquery') return 'INT64';
    if (this.kind === 'snowflake') return 'NUMBER(38,0)';
    return 'INTEGER';
  }

  private bigIntType(): string {
    if (this.kind === 'bigquery') return 'INT64';
    if (this.kind === 'snowflake') return 'NUMBER(38,0)';
    return 'BIGINT';
  }

  private jsonType(): string {
    if (this.kind === 'postgres') return 'JSONB';
    if (this.kind === 'snowflake') return 'VARIANT';
    return 'JSON';
  }

  private timestampType(): string {
    if (this.kind === 'bigquery') return 'TIMESTAMP';
    if (this.kind === 'snowflake') return 'TIMESTAMP_TZ';
    return 'TIMESTAMPTZ';
  }
}

function requireSqlExecutor(
  kind: SqlCacheKind,
  options: CacheSubstrateFactoryOptions | undefined
): CacheSqlExecutor {
  if (!options?.executor) {
    throw new ExtractorConfigError(
      `Cache substrate "${kind}" requires an executor or WarehouseClient.`
    );
  }
  if (hasCacheQuery(options.executor)) {
    return options.executor;
  }
  if (kind !== 'bigquery') {
    throw new ExtractorConfigError(
      `Cache substrate "${kind}" requires a CacheSqlExecutor with session-scoped transaction semantics; WarehouseClient cannot guarantee BEGIN/COMMIT affinity.`
    );
  }
  return warehouseClientCacheExecutor(options.executor);
}

function hasCacheQuery(value: CacheSqlExecutor | WarehouseClient): value is CacheSqlExecutor {
  return typeof (value as CacheSqlExecutor).query === 'function';
}

function manifestTableName(resource: string): string {
  const safeResource = normalizeCacheIdentifier(resource, 'resource');
  return normalizeCacheIdentifier(`${safeResource}__cache_manifest`, 'manifest table');
}

function normalizeCacheIdentifier(value: string, label: string): string {
  if (!CACHE_IDENTIFIER.test(value)) {
    throw new ExtractorConfigError(
      `Invalid cache ${label} "${value}". Use letters, numbers, and underscores; start with a letter or underscore.`
    );
  }
  return value;
}
