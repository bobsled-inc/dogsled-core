import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { CommandError, type BatchEncoding, type SchemaColumn } from '@bobsled-inc/protocol';
import type { DatabaseDestination, EnsureTableOptions, LoadResult } from './database.js';
import { sanitizeTableName, SYSTEM_COLUMNS } from './database.js';
import { withRetry } from '../retry.js';
import type { LoaderLogger } from '../logger.js';

export interface ChromaClientLike {
  heartbeat(): Promise<unknown>;
  getOrCreateCollection(options: {
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<CollectionLike>;
  getCollection(options: { name: string }): Promise<CollectionLike>;
  deleteCollection(options: { name: string }): Promise<void>;
}

export interface CollectionLike {
  add(options: AddOptions): Promise<{ ids: string[] }>;
  upsert(options: UpsertOptions): Promise<{ ids: string[] }>;
  count(): Promise<number>;
  delete(options?: DeleteOptions): Promise<void>;
}

export interface AddOptions {
  ids: string[];
  embeddings: number[][];
  documents?: string[];
  metadatas?: Record<string, unknown>[];
}

export interface UpsertOptions {
  ids: string[];
  embeddings: number[][];
  documents?: string[];
  metadatas?: Record<string, unknown>[];
}

export interface DeleteOptions {
  ids?: string[];
  where?: Record<string, unknown>;
  whereDocument?: Record<string, unknown>;
}

export interface ChromaDestinationOptions {
  host: string;
  port?: number;
  tenant?: string;
  database?: string;
  logger?: LoaderLogger;
  clientFactory?: (
    url: string,
    options: { tenant?: string; database?: string }
  ) => Promise<ChromaClientLike>;
}

const CHROMA_MODULE_SPECIFIER = 'chromadb';

interface ChromaModule {
  ChromaClient: new (options?: {
    path?: string;
    tenant?: string;
    database?: string;
  }) => ChromaClientLike;
}

export class ChromaModuleLoadError extends CommandError {}

export const chromaRuntime = {
  async loadModule(): Promise<ChromaModule> {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(CHROMA_MODULE_SPECIFIER)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ChromaModuleLoadError(
        `Failed to load chromadb. Install it to use --dest chroma. ${message}`,
        1
      );
    }
    if (typeof mod.ChromaClient !== 'function') {
      throw new Error(`chromadb module does not export a valid ChromaClient constructor`);
    }
    return mod as unknown as ChromaModule;
  },
};

function resolveChromaUrl(host: string, port?: number): string {
  if (host.startsWith('http://') || host.startsWith('https://')) {
    return host;
  }
  const p = port ?? 8000;
  return `http://${host}:${p}`;
}

const DELETE_BATCH_SIZE = 500;

// Chroma >= 1.0 answers 404 (ChromaNotFoundError); older servers raise InvalidCollection.
function isMissingCollectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ChromaNotFoundError' || /does not exist/i.test(error.message);
}

function isChromaModuleLoadError(error: unknown): error is ChromaModuleLoadError {
  return error instanceof ChromaModuleLoadError;
}

export class ChromaDestination implements DatabaseDestination {
  private readonly url: string;
  private readonly tenant?: string;
  private readonly database?: string;
  private readonly logger?: LoaderLogger;
  private readonly clientFactory: (
    url: string,
    options: { tenant?: string; database?: string }
  ) => Promise<ChromaClientLike>;
  private client?: ChromaClientLike;
  private truncatedTables = new Set<string>();

  constructor(options: ChromaDestinationOptions) {
    this.url = resolveChromaUrl(options.host, options.port);
    this.tenant = options.tenant;
    this.database = options.database;
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ??
      (async (url: string, opts: { tenant?: string; database?: string }) => {
        const { ChromaClient } = await chromaRuntime.loadModule();
        return new ChromaClient({
          path: url,
          tenant: opts.tenant,
          database: opts.database,
        });
      });
  }

  private getClient(): ChromaClientLike {
    if (!this.client) {
      throw new Error('ChromaDestination not initialized — call initialize() first');
    }
    return this.client;
  }

  async initialize(): Promise<void> {
    try {
      this.client = await this.clientFactory(this.url, {
        tenant: this.tenant,
        database: this.database,
      });
      await withRetry(() => this.client!.heartbeat());
    } catch (error) {
      if (isChromaModuleLoadError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to Chroma at ${this.url}. ${message}`);
    }
  }

  async ensureTable(
    schemaName: string,
    tableName: string,
    _columns: SchemaColumn[],
    _options?: EnsureTableOptions
  ): Promise<void> {
    const client = this.getClient();
    const safeName = sanitizeTableName(tableName);

    try {
      await withRetry(() => client.getOrCreateCollection({ name: safeName }));
      this.logger?.info(`Chroma: collection "${safeName}" created or retrieved`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create Chroma collection "${safeName}": ${message}`);
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
    const client = this.getClient();
    const safeName = sanitizeTableName(tableName);

    if (strategy === 'merge' && keyColumns.length === 0) {
      throw new Error('Merge strategy requires at least one key column');
    }

    if (strategy === 'full_refresh' && !this.truncatedTables.has(safeName)) {
      try {
        await withRetry(() => client.deleteCollection({ name: safeName }));
        await withRetry(() => client.getOrCreateCollection({ name: safeName }));
        this.truncatedTables.add(safeName);
        this.logger?.info(`Chroma: collection "${safeName}" cleared for full_refresh`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('not found') ||
          message.includes('does not exist') ||
          message.includes('404')
        ) {
          this.truncatedTables.add(safeName);
        } else {
          throw error;
        }
      }
    }

    const records = await this.readRecords(filePath);

    if (records.length === 0) {
      return { rowsAffected: 0 };
    }

    const collection = await withRetry(() => client.getCollection({ name: safeName }));
    const batchSize = 500;
    let rowsAffected = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const embeddings: number[][] = [];
      const ids: string[] = [];
      const documents: string[] = [];
      const metadatas: Record<string, unknown>[] = [];

      for (const record of batch) {
        const id =
          strategy !== 'append' && keyColumns.length > 0
            ? JSON.stringify(keyColumns.map((k) => record[k] ?? null))
            : (extractString(record, columns, 'id') ?? generateId());
        const embedding = extractEmbedding(record, columns);
        const document = extractDocument(record, columns);
        const metadata = buildMetadata(record, columns);
        if (record[SYSTEM_COLUMNS.TIME_EXTRACTED] !== undefined) {
          metadata[SYSTEM_COLUMNS.TIME_EXTRACTED] = String(record[SYSTEM_COLUMNS.TIME_EXTRACTED]);
        }
        metadata[SYSTEM_COLUMNS.LOADED_AT] = new Date().toISOString();

        ids.push(id);
        embeddings.push(embedding);
        if (document !== undefined) {
          documents.push(document);
        }
        metadatas.push(metadata);
      }

      const payload = {
        ids,
        embeddings,
        documents: documents.length === ids.length ? documents : undefined,
        metadatas: metadatas.length === ids.length ? metadatas : undefined,
      };

      // append uses add() to insert new records; merge/full_refresh use upsert() to handle duplicates
      const result = await withRetry(() =>
        strategy === 'append' ? collection.add(payload) : collection.upsert(payload)
      );

      rowsAffected += result.ids.length;
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
    const safeName = sanitizeTableName(tableName);
    let collection: CollectionLike;
    try {
      collection = await withRetry(() => client.getCollection({ name: safeName }));
    } catch (error) {
      if (isMissingCollectionError(error)) return;
      throw error;
    }
    // Scalar columns are stored verbatim as metadata, so `$in` is an exact match. Chroma acks a
    // delete once its write-ahead log persists it, and reads include the log tail.
    for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
      const batch = values.slice(i, i + DELETE_BATCH_SIZE);
      await withRetry(() => collection.delete({ where: { [column]: { $in: batch } } }));
    }
  }

  private async readRecords(filePath: string): Promise<Record<string, unknown>[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
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

function extractString(
  record: Record<string, unknown>,
  columns: SchemaColumn[],
  columnName: string
): string | undefined {
  const col = columns.find((c) => c.name === columnName);
  if (!col) return undefined;
  const value = record[columnName];
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function extractEmbedding(record: Record<string, unknown>, columns: SchemaColumn[]): number[] {
  const embCol = columns.find((c) => c.name === 'embedding' || c.name === 'vector');
  if (embCol) {
    const value = record[embCol.name];
    if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
      return value as number[];
    }
    if (Array.isArray(value)) {
      const numeric = value.map((v) => Number(v));
      if (!numeric.every((v) => Number.isFinite(v))) {
        throw new Error(`Embedding column "${embCol.name}" contains non-numeric values`);
      }
      return numeric;
    }
  }

  const arrayCol = columns.find((c) => c.type === 'array');
  if (arrayCol) {
    const value = record[arrayCol.name];
    if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
      return value as number[];
    }
  }

  throw new Error(
    `No embedding column found. Chroma requires a column named "embedding" or "vector" ` +
      `containing a numeric array, or an array-type column with numeric values. ` +
      `Available columns: ${columns.map((c) => `${c.name} (${c.type})`).join(', ')}`
  );
}

function extractDocument(
  record: Record<string, unknown>,
  columns: SchemaColumn[]
): string | undefined {
  const docCol = columns.find(
    (c) => c.name === 'document' || c.name === 'content' || c.name === 'text'
  );
  if (docCol) {
    const value = record[docCol.name];
    if (value !== null && value !== undefined) {
      return String(value);
    }
  }

  const stringCol = columns.find(
    (c) => c.type === 'string' && c.name !== 'embedding' && c.name !== 'vector'
  );
  if (stringCol) {
    const value = record[stringCol.name];
    if (value !== null && value !== undefined) {
      return String(value);
    }
  }

  return undefined;
}

function buildMetadata(
  record: Record<string, unknown>,
  columns: SchemaColumn[]
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const col of columns) {
    if (col.name === 'embedding' || col.name === 'vector') continue;
    const value = record[col.name];
    if (value !== undefined) {
      if (typeof value === 'object') {
        metadata[col.name] = JSON.stringify(value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        metadata[col.name] = value;
      } else if (typeof value === 'string') {
        metadata[col.name] = value;
      }
    }
  }
  return metadata;
}

function generateId(): string {
  return randomUUID();
}
