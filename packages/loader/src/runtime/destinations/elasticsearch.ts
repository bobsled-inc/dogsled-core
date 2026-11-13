import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import type { BatchEncoding, SchemaColumn, ColumnType, LoadStrategy } from '@bobsled-inc/protocol';
import {
  SYSTEM_COLUMNS,
  SYSTEM_COLUMN_NAMES,
  enforceSchemaContract,
  sanitizeTableName,
} from './database.js';
import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
  SchemaComparisonResult,
} from './database.js';
import { withRetry } from '../retry.js';
import type { LoaderLogger } from '../logger.js';

export interface ElasticsearchDestinationOptions {
  host: string;
  port?: number;
  index?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  vectorDimension?: number;
  vectorColumns?: string[];
  logger?: LoaderLogger;
  clientFactory?: (
    baseUrl: string,
    auth: { apiKey?: string; username?: string; password?: string }
  ) => ElasticsearchClientLike;
}

export interface ElasticsearchClientLike {
  request(init: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; json(): Promise<Record<string, unknown>> }>;
}

export interface ElasticsearchMappingProperty {
  type?: string;
  index?: boolean;
  dims?: number;
  algorithm?: string;
}

export interface ElasticsearchMapping {
  mappings?: {
    properties?: Record<string, ElasticsearchMappingProperty>;
  };
}

export class ElasticsearchDestination implements DatabaseDestination {
  private readonly host: string;
  private readonly port: number;
  private readonly index: string;
  private readonly apiKey?: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly ssl: boolean;
  private readonly vectorDimension?: number;
  private readonly vectorColumns?: string[];
  private readonly logger?: LoaderLogger;
  private readonly clientFactory: (
    baseUrl: string,
    auth: { apiKey?: string; username?: string; password?: string }
  ) => ElasticsearchClientLike;
  private readonly baseUrl: string;
  private client?: ElasticsearchClientLike;
  private truncatedTables = new Set<string>();
  private columnCache = new Map<string, Map<string, string>>();

  constructor(options: ElasticsearchDestinationOptions) {
    this.host = options.host;
    this.port = options.port ?? 9200;
    this.index = options.index ?? 'vectors';
    this.apiKey = options.apiKey;
    this.username = options.username;
    this.password = options.password;
    this.ssl = options.ssl ?? false;
    this.vectorDimension = options.vectorDimension;
    this.vectorColumns = options.vectorColumns;
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ?? ((baseUrl, auth) => createDefaultClient(baseUrl, auth));
    const protocol = this.ssl ? 'https' : 'http';
    this.baseUrl = `${protocol}://${this.host}:${this.port}`;
  }

  private getClient(): ElasticsearchClientLike {
    if (!this.client) {
      throw new Error('ElasticsearchDestination not initialized — call initialize() first');
    }
    return this.client;
  }

  async initialize(): Promise<void> {
    try {
      this.client = this.clientFactory(this.baseUrl, {
        apiKey: this.apiKey,
        username: this.username,
        password: this.password,
      });

      const response = await this.client.request({
        method: 'GET',
        url: this.baseUrl,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`Elasticsearch returned ${response.status}: ${JSON.stringify(body)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Elasticsearch')) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to Elasticsearch at ${this.baseUrl}: ${message}`);
    }
  }

  private async indexExists(indexName: string): Promise<boolean> {
    const client = this.getClient();
    const response = await withRetry(() =>
      client.request({
        method: 'HEAD',
        url: `${this.baseUrl}/${indexName}`,
      })
    );
    return response.ok;
  }

  private async getMapping(indexName: string): Promise<ElasticsearchMapping | null> {
    const client = this.getClient();
    try {
      const response = await withRetry(() =>
        client.request({
          method: 'GET',
          url: `${this.baseUrl}/${indexName}/_mapping`,
        })
      );
      if (!response.ok) {
        return null;
      }
      const raw = (await response.json()) as Record<string, ElasticsearchMapping>;
      // ES GET /_mapping returns { "index_name": { "mappings": { ... } } }
      const indexMapping = raw[indexName] ?? Object.values(raw)[0];
      return indexMapping ?? null;
    } catch {
      return null;
    }
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void> {
    const indexName = sanitizeTableName(tableName);
    const cacheKey = indexName;

    const hasVectorField = columns.some((c) => isVectorColumn(c, this.vectorColumns));

    if (this.columnCache.has(cacheKey)) {
      const existingMap = this.columnCache.get(cacheKey)!;
      const newColumns: SchemaColumn[] = [];
      const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];

      for (const col of columns) {
        const existingType = existingMap.get(col.name);
        const expectedType = getExpectedElasticsearchType(col, this.vectorColumns);

        if (existingType === undefined) {
          newColumns.push(col);
        } else if (existingType !== expectedType) {
          typeConflicts.push({
            column: col.name,
            existingType: existingType,
            expectedType: expectedType,
            existingColumnType: reverseMapElasticsearchType(existingType),
            expectedColumnType: col.type,
          });
        }
      }

      const comparison: SchemaComparisonResult = { newColumns, removedColumns: [], typeConflicts };
      const { columnsToAdd } = enforceSchemaContract(
        options?.schemaBehavior,
        comparison,
        indexName
      );

      if (columnsToAdd.length > 0) {
        const properties = buildPropertyMappings(
          columnsToAdd,
          this.vectorDimension,
          this.vectorColumns
        );
        await this.updateIndexMapping(indexName, properties);
        for (const col of columnsToAdd) {
          existingMap.set(col.name, getExpectedElasticsearchType(col, this.vectorColumns));
        }
      }

      return;
    }

    const exists = await this.indexExists(indexName);

    if (!exists) {
      const properties = buildPropertyMappings(columns, this.vectorDimension, this.vectorColumns);
      const mapping: Record<string, unknown> = {
        mappings: {
          properties: {
            ...properties,
            [SYSTEM_COLUMNS.TIME_EXTRACTED]: { type: 'date' },
            [SYSTEM_COLUMNS.LOADED_AT]: { type: 'date' },
          },
        },
        settings: {},
      };

      if (hasVectorField) {
        mapping['settings'] = {
          ...(mapping['settings'] as Record<string, unknown>),
          index: {
            knn: true,
          },
        };
      }

      const client = this.getClient();
      const response = await client.request({
        method: 'PUT',
        url: `${this.baseUrl}/${indexName}`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapping),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`Failed to create index "${indexName}": ${JSON.stringify(body)}`);
      }

      const columnMap = new Map<string, string>();
      for (const col of columns) {
        columnMap.set(col.name, getExpectedElasticsearchType(col, this.vectorColumns));
      }
      columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'date');
      columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'date');
      this.columnCache.set(cacheKey, columnMap);

      return;
    }

    const existingMapping = await this.getMapping(indexName);
    const existingProps = existingMapping?.mappings?.properties ?? {};

    const systemColumnNames: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
    const newColumns: SchemaColumn[] = [];
    const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
    const requestedNames = new Set(columns.map((c) => c.name));
    const removedColumns: string[] = [];

    for (const col of columns) {
      const existingProp = existingProps[col.name] as ElasticsearchMappingProperty | undefined;
      const expectedType = getExpectedElasticsearchType(col, this.vectorColumns);

      if (!existingProp) {
        newColumns.push(col);
      } else if (existingProp.type !== expectedType) {
        typeConflicts.push({
          column: col.name,
          existingType: existingProp.type ?? 'unknown',
          expectedType: expectedType,
          existingColumnType: reverseMapElasticsearchType(existingProp.type ?? 'unknown'),
          expectedColumnType: col.type,
        });
      }
    }

    for (const existingName of Object.keys(existingProps)) {
      if (!requestedNames.has(existingName) && !systemColumnNames.has(existingName)) {
        removedColumns.push(existingName);
      }
    }

    const comparison: SchemaComparisonResult = { newColumns, removedColumns, typeConflicts };
    const { columnsToAdd } = enforceSchemaContract(options?.schemaBehavior, comparison, indexName);

    // Ensure system columns exist in the mapping
    const systemColumnsToAdd: Record<string, ElasticsearchMappingProperty> = {};
    if (!existingProps[SYSTEM_COLUMNS.TIME_EXTRACTED]) {
      systemColumnsToAdd[SYSTEM_COLUMNS.TIME_EXTRACTED] = { type: 'date' };
    }
    if (!existingProps[SYSTEM_COLUMNS.LOADED_AT]) {
      systemColumnsToAdd[SYSTEM_COLUMNS.LOADED_AT] = { type: 'date' };
    }

    const propertiesToAdd = {
      ...buildPropertyMappings(columnsToAdd, this.vectorDimension, this.vectorColumns),
      ...systemColumnsToAdd,
    };
    if (Object.keys(propertiesToAdd).length > 0) {
      await this.updateIndexMapping(indexName, propertiesToAdd);
    }

    const columnMap = new Map<string, string>();
    for (const [name, prop] of Object.entries(existingProps)) {
      const p = prop as ElasticsearchMappingProperty;
      columnMap.set(name, p.type ?? 'unknown');
    }
    for (const col of columns) {
      columnMap.set(col.name, getExpectedElasticsearchType(col, this.vectorColumns));
    }
    columnMap.set(SYSTEM_COLUMNS.TIME_EXTRACTED, 'date');
    columnMap.set(SYSTEM_COLUMNS.LOADED_AT, 'date');
    this.columnCache.set(cacheKey, columnMap);
  }

  private async updateIndexMapping(
    indexName: string,
    properties: Record<string, ElasticsearchMappingProperty>
  ): Promise<void> {
    const client = this.getClient();
    await withRetry(async () => {
      const response = await client.request({
        method: 'PUT',
        url: `${this.baseUrl}/${indexName}/_mapping`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          `Failed to update index mapping for "${indexName}": ${JSON.stringify(body)}`
        );
      }
    });
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
    const indexName = sanitizeTableName(tableName);
    const qualifiedKey = indexName;

    if (strategy === 'merge' && keyColumns.length === 0) {
      throw new Error('merge strategy requires at least one key column');
    }

    if (strategy === 'full_refresh' && !this.truncatedTables.has(qualifiedKey)) {
      await this.deleteIndex(indexName);
      // Re-create the index with proper mappings via ensureTable on next call
      this.columnCache.delete(indexName);
      await this.ensureTable(schemaName, tableName, columns, {
        keyProperties: keyColumns.length > 0 ? keyColumns : undefined,
      });
      this.truncatedTables.add(qualifiedKey);
    }

    const data = await fs.readFile(filePath, 'utf-8');
    const records = data
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));

    if (records.length === 0) {
      return { rowsAffected: 0 };
    }

    const batchSize = 500;
    let rowsAffected = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const actions: string[] = [];
      const docs: Record<string, unknown>[] = [];

      for (const record of batch) {
        const docId =
          keyColumns.length > 0
            ? createHash('sha256')
                .update(JSON.stringify(keyColumns.map((k) => record[k] ?? null)))
                .digest('hex')
            : generateDocId();

        const doc: Record<string, unknown> = { ...record };
        doc[SYSTEM_COLUMNS.LOADED_AT] = new Date().toISOString();

        actions.push(JSON.stringify({ index: { _index: indexName, _id: docId } }));
        docs.push(doc);
      }

      const bulkBody =
        actions.map((action, idx) => `${action}\n${JSON.stringify(docs[idx])}`).join('\n') + '\n';

      const client = this.getClient();
      await withRetry(async () => {
        const response = await client.request({
          method: 'POST',
          url: `${this.baseUrl}/_bulk`,
          headers: { 'Content-Type': 'application/x-ndjson' },
          body: bulkBody,
        });

        const body = (await response.json().catch(() => ({}))) as {
          errors?: boolean;
          items?: Array<Record<string, { error?: { type: string; reason: string } }>>;
        };

        if (!response.ok) {
          throw new Error(`Bulk indexing failed: ${JSON.stringify(body)}`);
        }

        if (body.errors && body.items) {
          const failures = body.items
            .map((item) => {
              const action = Object.values(item)[0];
              return action?.error;
            })
            .filter(Boolean);
          if (failures.length > 0) {
            throw new Error(
              `Bulk indexing had ${failures.length} item-level error(s): ${JSON.stringify(failures.slice(0, 3))}`
            );
          }
        }
      });

      rowsAffected += batch.length;
    }

    return { rowsAffected };
  }

  async deleteRows(
    _schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void> {
    if (values.length === 0) return;
    const client = this.getClient();
    const indexName = sanitizeTableName(tableName);
    // Bulk loads do not refresh; refresh so the search below sees every earlier write.
    const refresh = await withRetry(() =>
      client.request({ method: 'POST', url: `${this.baseUrl}/${indexName}/_refresh` })
    );
    if (refresh.status === 404) return;
    if (!refresh.ok) {
      const body = await refresh.json().catch(() => ({}));
      throw new Error(`Failed to refresh index "${indexName}": ${JSON.stringify(body)}`);
    }

    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      // Each pass deletes the hits it found with refresh=true, so the next search sees the rest.
      let previous = '';
      for (;;) {
        const ids = await this.searchExactIds(indexName, column, batch);
        if (ids.length === 0) break;
        // Hits that survive their own delete would repeat forever.
        const key = ids.join('\n');
        if (key === previous) {
          throw new Error(`Bulk delete on index "${indexName}" did not remove matching documents`);
        }
        previous = key;
        await this.bulkDelete(indexName, ids);
      }
    }
  }

  /**
   * String columns are mapped as analyzed `text`, which cannot match a value exactly.
   * A request-scoped keyword runtime field read from `_source` compares the stored value.
   */
  private async searchExactIds(
    indexName: string,
    column: string,
    values: string[]
  ): Promise<string[]> {
    const client = this.getClient();
    const response = await withRetry(() =>
      client.request({
        method: 'POST',
        // Partial results would read as "nothing left to delete" and leave stale rows.
        url: `${this.baseUrl}/${indexName}/_search?allow_partial_search_results=false`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: DELETE_BATCH_SIZE,
          _source: false,
          track_total_hits: false,
          runtime_mappings: {
            [EXACT_MATCH_FIELD]: {
              type: 'keyword',
              script: { source: EXACT_MATCH_SCRIPT, params: { field: column } },
            },
          },
          query: { terms: { [EXACT_MATCH_FIELD]: values } },
        }),
      })
    );
    const body = (await response.json().catch(() => ({}))) as {
      timed_out?: boolean;
      _shards?: { failed?: number };
      hits?: { hits?: Array<{ _id?: string }> };
    };
    if (!response.ok || body.timed_out === true || (body._shards?.failed ?? 0) > 0) {
      throw new Error(`Search on index "${indexName}" failed: ${JSON.stringify(body)}`);
    }
    return (body.hits?.hits ?? []).flatMap((hit) => (hit._id ? [hit._id] : []));
  }

  private async bulkDelete(indexName: string, ids: string[]): Promise<void> {
    const client = this.getClient();
    const bulkBody =
      ids.map((id) => JSON.stringify({ delete: { _index: indexName, _id: id } })).join('\n') + '\n';
    await withRetry(async () => {
      const response = await client.request({
        method: 'POST',
        url: `${this.baseUrl}/_bulk?refresh=true`,
        headers: { 'Content-Type': 'application/x-ndjson' },
        body: bulkBody,
      });
      const body = (await response.json().catch(() => ({}))) as {
        items?: Array<Record<string, { result?: string; error?: unknown }>>;
      };
      if (!response.ok) {
        throw new Error(`Bulk delete failed: ${JSON.stringify(body)}`);
      }
      const results = (body.items ?? []).map((item) => Object.values(item)[0]);
      const failures = results.filter((r) => r?.error !== undefined).map((r) => r?.error);
      if (failures.length > 0) {
        throw new Error(
          `Bulk delete had ${failures.length} item-level error(s): ${JSON.stringify(failures.slice(0, 3))}`
        );
      }
    });
  }

  private async deleteIndex(indexName: string): Promise<void> {
    const client = this.getClient();
    try {
      await withRetry(() =>
        client.request({
          method: 'DELETE',
          url: `${this.baseUrl}/${indexName}`,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('index_not_found')) {
        throw error;
      }
    }
    this.columnCache.delete(indexName);
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

const DELETE_BATCH_SIZE = 500;
const EXACT_MATCH_FIELD = 'dogsled_replace_key';
const EXACT_MATCH_SCRIPT =
  "def v = params['_source'][params['field']]; if (v instanceof String) { emit(v); }";

function mapElasticsearchType(
  type: ColumnType,
  column: SchemaColumn,
  vectorColumns?: string[]
): string {
  if (type === 'vector' || isVectorColumn(column, vectorColumns)) {
    throw new Error('Vector columns must be mapped through buildPropertyMappings');
  }
  switch (type) {
    case 'integer':
      return 'long';
    case 'number':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'timestamp':
      return 'date';
    case 'string':
      return 'text';
    case 'array':
      return 'text';
    case 'object':
      return 'object';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

function getExpectedElasticsearchType(column: SchemaColumn, vectorColumns?: string[]): string {
  return isVectorColumn(column, vectorColumns)
    ? 'dense_vector'
    : mapElasticsearchType(column.type, column, vectorColumns);
}

function reverseMapElasticsearchType(esType: string): ColumnType {
  switch (esType.toLowerCase()) {
    case 'long':
    case 'integer':
    case 'short':
    case 'byte':
      return 'integer';
    case 'double':
    case 'float':
    case 'half_float':
    case 'scaled_float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'timestamp';
    case 'text':
    case 'keyword':
    case 'string':
    case 'dense_vector':
    case 'object':
    case 'nested':
      return 'string';
    default:
      return 'string';
  }
}

function buildPropertyMappings(
  columns: SchemaColumn[],
  defaultVectorDimension?: number,
  vectorColumns?: string[]
): Record<string, ElasticsearchMappingProperty> {
  const properties: Record<string, ElasticsearchMappingProperty> = {};

  for (const col of columns) {
    if (isVectorColumn(col, vectorColumns)) {
      const dims =
        col.type === 'vector'
          ? (col.dimension ?? defaultVectorDimension ?? 1536)
          : (defaultVectorDimension ?? 1536);
      properties[col.name] = {
        type: 'dense_vector',
        dims,
        index: true,
        algorithm: 'hnsw',
      };
    } else {
      properties[col.name] = {
        type: mapElasticsearchType(col.type, col, vectorColumns) as string,
      };
    }
  }

  return properties;
}

function isVectorColumn(column: SchemaColumn, vectorColumns?: string[]): boolean {
  if (column.type === 'vector') {
    return true;
  }
  if (vectorColumns && vectorColumns.length > 0) {
    return vectorColumns.includes(column.name);
  }
  // Fallback to name-based heuristic when no explicit config
  if (column.type !== 'object') {
    return false;
  }
  const name = column.name.toLowerCase();
  return name.includes('embedding') || name.includes('vector');
}

function generateDocId(): string {
  return randomUUID();
}

const MAX_ELASTICSEARCH_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readElasticsearchResponse(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_ELASTICSEARCH_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Elasticsearch response exceeds the 16 MiB limit.');
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ELASTICSEARCH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Elasticsearch response exceeds the 16 MiB limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { raw: parsed };
  } catch {
    return { raw: text };
  }
}

export function createDefaultClient(
  baseUrl: string,
  auth: { apiKey?: string; username?: string; password?: string }
): ElasticsearchClientLike {
  return {
    async request(init) {
      const url = init.url ?? baseUrl;
      const headers: Record<string, string> = {};

      const strip = (s: string) => s.replace(/[\r\n]/g, '');
      if (auth.apiKey) {
        headers['Authorization'] = `ApiKey ${strip(auth.apiKey)}`;
      } else if (auth.username && auth.password) {
        const credentials = Buffer.from(`${strip(auth.username)}:${strip(auth.password)}`).toString(
          'base64'
        );
        headers['Authorization'] = `Basic ${credentials}`;
      }

      if (init.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          headers[k] = v;
        }
      }

      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });

      return {
        ok: response.ok,
        status: response.status,
        json: async () => readElasticsearchResponse(response),
      };
    },
  };
}
