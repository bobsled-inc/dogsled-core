import { createHash, randomUUID } from 'node:crypto';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import type {
  BatchEncoding,
  ColumnType,
  LoadStrategy,
  SchemaColumn,
  VectorSchemaColumn,
} from '@bobsled-inc/protocol';
import {
  enforceSchemaContract,
  SYSTEM_COLUMNS,
  SYSTEM_COLUMN_NAMES,
  sanitizeTableName,
} from './database.js';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import { readJsonlRecords } from '../jsonl.js';
import { withRetry } from '../retry.js';
import type { LoaderLogger } from '../logger.js';

export type TurbopufferDistanceMetric = 'cosine_distance' | 'euclidean_squared';

export interface TurbopufferAttributeSchema {
  type: string;
  filterable?: boolean;
  full_text_search?: boolean | Record<string, unknown>;
  ann?: boolean | Record<string, unknown>;
}

export interface TurbopufferWriteParams {
  upsert_rows?: Array<Record<string, unknown>>;
  delete_by_filter?: unknown[];
  schema?: Record<string, TurbopufferAttributeSchema>;
  distance_metric?: TurbopufferDistanceMetric;
}

export interface TurbopufferWriteResult {
  rows_affected?: number;
  rows_upserted?: number;
}

/** Mirrors the subset of `@turbopuffer/turbopuffer` Namespace used here (DI for tests). */
export interface TurbopufferNamespaceLike {
  write(params: TurbopufferWriteParams): Promise<TurbopufferWriteResult>;
  schema(): Promise<Record<string, TurbopufferAttributeSchema>>;
  exists(): Promise<boolean>;
  deleteAll(): Promise<unknown>;
}

export interface TurbopufferClientLike {
  namespace(name: string): TurbopufferNamespaceLike;
  namespaces(params: { page_size?: number; prefix?: string }): Promise<unknown>;
}

export interface TurbopufferDestinationOptions {
  apiKey: string;
  region?: string;
  namespacePrefix?: string;
  distanceMetric?: TurbopufferDistanceMetric;
  fullTextColumns?: string[];
  vectorDimension?: number;
  vectorColumns?: string[];
  logger?: LoaderLogger;
  clientFactory?: (options: { apiKey: string; region: string }) => Promise<TurbopufferClientLike>;
}

// Module specifier kept in a variable so TypeScript does not require the optional SDK at build time.
const TURBOPUFFER_MODULE_SPECIFIER = '@turbopuffer/turbopuffer';
const DEFAULT_REGION = 'gcp-us-central1';
const WRITE_BATCH_SIZE = 500;
const NAMESPACE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ID_BYTES = 64;

type TurbopufferCtor = new (options: Record<string, unknown>) => TurbopufferClientLike;

export class TurbopufferModuleLoadError extends CommandError {}

export const turbopufferRuntime = {
  async loadModule(): Promise<TurbopufferCtor> {
    let mod: { Turbopuffer?: TurbopufferCtor; default?: TurbopufferCtor };
    try {
      mod = (await import(TURBOPUFFER_MODULE_SPECIFIER)) as typeof mod;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TurbopufferModuleLoadError(
        `Failed to load @turbopuffer/turbopuffer. Install it to use --dest turbopuffer. ${message}`,
        1
      );
    }
    const ctor = mod.Turbopuffer ?? mod.default;
    if (typeof ctor !== 'function') {
      throw new Error('@turbopuffer/turbopuffer does not export a Turbopuffer client constructor');
    }
    return ctor;
  },
};

export class TurbopufferDestination implements DatabaseDestination {
  private readonly apiKey: string;
  private readonly region: string;
  private readonly namespacePrefix: string;
  private readonly distanceMetric?: TurbopufferDistanceMetric;
  private readonly fullTextColumns: Set<string>;
  private readonly vectorDimension?: number;
  private readonly vectorColumns: Set<string>;
  private readonly logger?: LoaderLogger;
  private readonly clientFactory: NonNullable<TurbopufferDestinationOptions['clientFactory']>;
  private client?: TurbopufferClientLike;
  private truncatedTables = new Set<string>();
  private schemaCache = new Map<string, Record<string, TurbopufferAttributeSchema>>();

  constructor(options: TurbopufferDestinationOptions) {
    this.apiKey = options.apiKey;
    this.region = options.region ?? DEFAULT_REGION;
    this.namespacePrefix = options.namespacePrefix ?? '';
    this.distanceMetric = options.distanceMetric;
    this.fullTextColumns = new Set(options.fullTextColumns ?? []);
    this.vectorDimension = options.vectorDimension;
    this.vectorColumns = new Set(options.vectorColumns ?? []);
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ??
      (async ({ apiKey, region }) => {
        const Ctor = await turbopufferRuntime.loadModule();
        // The SDK retries 429/409/5xx on write itself; keep client retries low to avoid stacking.
        return new Ctor({ apiKey, region, compression: true, maxRetries: 2 });
      });
  }

  private getClient(): TurbopufferClientLike {
    if (!this.client) {
      throw new Error('TurbopufferDestination not initialized — call initialize() first');
    }
    return this.client;
  }

  private namespaceName(tableName: string): string {
    const name = `${this.namespacePrefix}${sanitizeTableName(tableName)}`;
    if (!NAMESPACE_NAME_RE.test(name)) {
      throw new CommandError(
        `Turbopuffer namespace "${name}" must match ${NAMESPACE_NAME_RE.source}`,
        EXIT_VALIDATION
      );
    }
    return name;
  }

  async initialize(): Promise<void> {
    try {
      this.client = await this.clientFactory({ apiKey: this.apiKey, region: this.region });
      await withRetry(() => this.client!.namespaces({ page_size: 1 }));
    } catch (error) {
      if (error instanceof TurbopufferModuleLoadError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to Turbopuffer in region ${this.region}. ${message}`);
    }
  }

  async ensureTable(
    _schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const client = this.getClient();
    const namespace = this.namespaceName(tableName);
    const expected = this.buildAttributeSchema(columns);
    const existing =
      this.schemaCache.get(namespace) ?? (await this.fetchSchema(client.namespace(namespace)));

    if (existing === undefined) {
      // Namespace is created implicitly by the first write.
      this.schemaCache.set(namespace, expected);
      return;
    }

    const newColumns = columns.filter((c) => c.name !== 'id' && existing[c.name] === undefined);
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
    for (const col of columns) {
      const current = existing[col.name];
      const wanted = expected[col.name];
      if (current !== undefined && wanted !== undefined && current.type !== wanted.type) {
        typeConflicts.push({
          column: col.name,
          existingType: current.type,
          expectedType: wanted.type,
          existingColumnType: reverseMapAttributeType(current.type),
          expectedColumnType: col.type,
        });
      }
    }
    const requested = new Set(columns.filter((c) => c.name !== 'id').map((c) => c.name));
    const reserved = new Set<string>(['id', ...SYSTEM_COLUMN_NAMES]);
    const removedColumns = Object.keys(existing).filter(
      (name) => !requested.has(name) && !reserved.has(name)
    );

    const { columnsToWiden } = enforceSchemaContract(
      options?.schemaBehavior,
      { newColumns, removedColumns, typeConflicts },
      namespace
    );
    if (columnsToWiden.length > 0) {
      const first = columnsToWiden[0]!;
      throw new Error(
        `Schema change conflict on ${namespace}.${first.column}: Turbopuffer attribute types cannot change ` +
          `(${first.existingType} -> ${first.expectedType}); use load_strategy full_refresh to recreate the namespace`
      );
    }
    // New attributes are created implicitly by the next write.
    this.schemaCache.set(namespace, { ...existing, ...expected });
  }

  private async fetchSchema(
    ns: TurbopufferNamespaceLike
  ): Promise<Record<string, TurbopufferAttributeSchema> | undefined> {
    const exists = await withRetry(() => ns.exists());
    if (!exists) {
      return undefined;
    }
    return withRetry(() => ns.schema());
  }

  async loadAndFinalize(
    _schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: LoadStrategy,
    keyColumns: string[],
    _sourceEncoding?: BatchEncoding
  ): Promise<LoadResult> {
    const client = this.getClient();
    const namespace = this.namespaceName(tableName);
    if (strategy === 'merge' && keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }
    const ns = client.namespace(namespace);

    if (strategy === 'full_refresh' && !this.truncatedTables.has(namespace)) {
      if (await withRetry(() => ns.exists())) {
        await withRetry(() => ns.deleteAll());
      }
      this.truncatedTables.add(namespace);
      this.schemaCache.delete(namespace);
      this.logger?.info('turbopuffer_namespace_cleared', { namespace });
    }

    const vectorColumns = columns.filter((c) => this.isVectorColumn(c));
    const schema = this.buildAttributeSchema(columns);
    const distanceMetric =
      vectorColumns.length > 0 ? this.resolveDistanceMetric(vectorColumns) : undefined;
    const loadedAt = new Date().toISOString();

    let rowsAffected = 0;
    let recordCount = 0;
    const writeBatch = async (batch: Array<Record<string, unknown>>): Promise<void> => {
      if (batch.length === 0) {
        return;
      }

      // No withRetry here: the SDK already retries 429/409/5xx for write().
      const result = await ns.write({
        upsert_rows: batch,
        schema,
        ...(distanceMetric ? { distance_metric: distanceMetric } : {}),
      });
      rowsAffected += result.rows_affected ?? result.rows_upserted ?? batch.length;
    };

    if (strategy === 'merge') {
      // Merge needs a full-flush key map to preserve newest-by-time semantics when
      // duplicate keys are separated by multiple write batches.
      const byId = new Map<string, Record<string, unknown>>();
      for await (const record of readJsonlRecords(filePath)) {
        recordCount += 1;
        const row = this.buildRow(record, columns, strategy, keyColumns, loadedAt);
        const previous = byId.get(String(row.id));
        const previousTime = String(previous?.[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? '');
        const currentTime = String(row[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? '');
        if (previous === undefined || currentTime >= previousTime) {
          byId.set(String(row.id), row);
        }
      }

      let batch: Array<Record<string, unknown>> = [];
      for (const row of byId.values()) {
        batch.push(row);
        if (batch.length >= WRITE_BATCH_SIZE) {
          await writeBatch(batch);
          batch = [];
        }
      }
      await writeBatch(batch);
    } else {
      let batch: Array<Record<string, unknown>> = [];
      for await (const record of readJsonlRecords(filePath)) {
        recordCount += 1;
        batch.push(this.buildRow(record, columns, strategy, keyColumns, loadedAt));
        if (batch.length >= WRITE_BATCH_SIZE) {
          await writeBatch(batch);
          batch = [];
        }
      }
      await writeBatch(batch);
    }

    if (recordCount === 0) {
      return { rowsAffected: 0 };
    }
    this.schemaCache.set(namespace, { ...(this.schemaCache.get(namespace) ?? {}), ...schema });
    return { rowsAffected };
  }

  async deleteRows(
    _schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    const ns = this.getClient().namespace(this.namespaceName(tableName));
    const schema = await this.fetchSchema(ns);
    // A missing namespace or attribute holds no rows to delete.
    if (schema?.[column] === undefined) return;
    for (let i = 0; i < values.length; i += WRITE_BATCH_SIZE) {
      // Writes are visible to the next (strongly consistent, default) query once write() resolves.
      // No withRetry here: the SDK already retries 429/409/5xx for write().
      await ns.write({ delete_by_filter: [column, 'In', values.slice(i, i + WRITE_BATCH_SIZE)] });
    }
  }

  private buildRow(
    record: Record<string, unknown>,
    columns: SchemaColumn[],
    strategy: LoadStrategy,
    keyColumns: string[],
    loadedAt: string
  ): Record<string, unknown> {
    const id = deriveDocumentId(record, keyColumns, strategy);
    const row: Record<string, unknown> = { id };
    for (const col of columns) {
      if (col.name === 'id') {
        continue;
      }
      row[col.name] = this.convertValue(record[col.name], col);
    }
    row[SYSTEM_COLUMNS.TIME_EXTRACTED] = record[SYSTEM_COLUMNS.TIME_EXTRACTED] ?? null;
    row[SYSTEM_COLUMNS.LOADED_AT] = loadedAt;
    return row;
  }

  private convertValue(value: unknown, col: SchemaColumn): unknown {
    if (this.isVectorColumn(col)) {
      if (!Array.isArray(value)) {
        throw invalidVector(col.name, 'requires a non-null numeric array');
      }
      const numbers = value.map((v) => Number(v));
      if (!numbers.every((n) => Number.isFinite(n))) {
        throw invalidVector(col.name, 'contains non-numeric values');
      }
      return numbers;
    }
    if (value === null || value === undefined) {
      return null;
    }
    switch (col.type) {
      case 'integer': {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : null;
      }
      case 'number': {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      case 'boolean':
        return typeof value === 'boolean'
          ? value
          : value === 'true' || value === 1 || value === '1';
      case 'timestamp':
        return value instanceof Date ? value.toISOString() : String(value);
      case 'array':
      case 'object':
        return typeof value === 'string' ? value : JSON.stringify(value);
      default:
        return typeof value === 'string' ? value : String(value);
    }
  }

  private buildAttributeSchema(
    columns: SchemaColumn[]
  ): Record<string, TurbopufferAttributeSchema> {
    const schema: Record<string, TurbopufferAttributeSchema> = {};
    for (const col of columns) {
      if (col.name === 'id') {
        continue;
      }
      if (this.isVectorColumn(col)) {
        schema[col.name] = { type: `[${this.vectorDimensionFor(col)}]f32`, ann: true };
        continue;
      }
      if (col.type === 'array' || col.type === 'object') {
        // JSON text can exceed the 4 KiB filterable-value cap; store it unindexed.
        schema[col.name] = { type: 'string', filterable: false };
        continue;
      }
      const type = mapAttributeType(col.type);
      schema[col.name] =
        type === 'string' && this.fullTextColumns.has(col.name)
          ? { type, full_text_search: true }
          : { type };
    }
    schema[SYSTEM_COLUMNS.TIME_EXTRACTED] = { type: 'datetime' };
    schema[SYSTEM_COLUMNS.LOADED_AT] = { type: 'datetime' };
    return schema;
  }

  private isVectorColumn(col: SchemaColumn): boolean {
    return col.type === 'vector' || this.vectorColumns.has(col.name);
  }

  private vectorDimensionFor(col: SchemaColumn): number {
    if (col.type === 'vector') {
      return col.dimension;
    }
    if (this.vectorDimension === undefined) {
      throw new CommandError(
        `vectorDimension is required when vectorColumns includes "${col.name}"`,
        EXIT_VALIDATION
      );
    }
    return this.vectorDimension;
  }

  private resolveDistanceMetric(vectorColumns: SchemaColumn[]): TurbopufferDistanceMetric {
    if (this.distanceMetric) {
      return this.distanceMetric;
    }
    const first = vectorColumns.find((c): c is VectorSchemaColumn => c.type === 'vector');
    const metric = first?.embedded_from?.distance_metric;
    if (metric === 'l2') {
      return 'euclidean_squared';
    }
    if (metric === 'dot') {
      throw new CommandError(
        JSON.stringify({
          code: 'UNSUPPORTED_DISTANCE_METRIC',
          message:
            'Turbopuffer supports cosine_distance and euclidean_squared; set distance_metric explicitly',
          destination: 'turbopuffer',
        }),
        EXIT_VALIDATION
      );
    }
    return 'cosine_distance';
  }

  getTruncatedTables(): Set<string> {
    return new Set(this.truncatedTables);
  }

  setTruncatedTables(tables: Set<string>): void {
    this.truncatedTables = new Set(tables);
  }

  async close(): Promise<void> {
    this.client = undefined;
  }
}

function invalidVector(column: string, detail: string): CommandError {
  return new CommandError(
    JSON.stringify({
      code: 'INVALID_VECTOR_VALUE',
      message: `Turbopuffer vector column "${column}" ${detail}`,
      destination: 'turbopuffer',
    }),
    EXIT_VALIDATION
  );
}

function mapAttributeType(type: ColumnType): string {
  switch (type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'timestamp':
      return 'datetime';
    case 'string':
    case 'array':
    case 'object':
    case 'vector':
    default:
      return 'string';
  }
}

function reverseMapAttributeType(type: string): ColumnType {
  if (type.startsWith('[')) return 'vector';
  if (type === 'int' || type === 'uint') return 'integer';
  if (type === 'float') return 'number';
  if (type === 'bool') return 'boolean';
  if (type === 'datetime') return 'timestamp';
  return 'string';
}

/**
 * Document ids are always strings (one id type per namespace). append -> random UUID (write() is
 * an upsert, so keyed ids would silently overwrite). Keyed strategies use the raw single key when
 * it fits in 64 bytes, otherwise sha256 hex (exactly 64 bytes). Any NULL key -> random UUID,
 * matching the SQL destinations where NULL keys never match and always insert.
 */
function deriveDocumentId(
  record: Record<string, unknown>,
  keyColumns: string[],
  strategy: LoadStrategy
): string {
  if (strategy === 'append' || keyColumns.length === 0) {
    return randomUUID();
  }
  const values = keyColumns.map((k) => record[k] ?? null);
  if (values.some((v) => v === null)) {
    return randomUUID();
  }
  if (values.length === 1 && (typeof values[0] === 'string' || typeof values[0] === 'number')) {
    const raw = String(values[0]);
    if (Buffer.byteLength(raw, 'utf8') <= MAX_ID_BYTES) {
      return raw;
    }
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
