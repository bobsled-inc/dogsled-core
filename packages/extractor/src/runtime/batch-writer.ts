import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { Writable, Transform } from 'node:stream';

import type { BatchEncoding, BatchFormat, SchemaColumn } from '../types/index.js';

import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

export interface BatchWriterOptions {
  batchDir: string;
  stream: string;
  maxRecords: number;
  compression: 'none' | 'gzip';
  format?: BatchFormat;
  columns?: SchemaColumn[];
  createWriteStream?: (filePath: string) => Writable;
  createGzip?: () => Transform;
  convertJsonlToParquet?: (options: {
    columns: SchemaColumn[];
    outputPath: string;
    sourcePath: string;
  }) => Promise<void>;
  deleteFile?: (filePath: string) => Promise<void>;
}

export interface FinalizedBatch {
  filePath: string;
  recordCount: number;
  byteSize: number;
  encoding: BatchEncoding;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeSqlString(value: string): string {
  return value.replaceAll('\0', '').replaceAll("'", "''");
}

function mapDuckDbType(column: SchemaColumn): string {
  switch (column.type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'string':
    case 'array':
    case 'object':
      return 'VARCHAR';
    case 'vector':
      return `DOUBLE[${column.dimension}]`;
    default: {
      const exhaustive: never = column;
      throw new Error(`Unsupported column type: ${exhaustive}`);
    }
  }
}

function buildTypedJsonRelation(sourcePath: string, columns: SchemaColumn[]): string {
  const escapedPath = escapeSqlString(sourcePath);
  const typedColumns = columns.map(
    (column) => `${quoteIdentifier(column.name)}: ${mapDuckDbType(column)}`
  );
  return `read_json('${escapedPath}', format = 'newline_delimited', auto_detect = false, columns = {${typedColumns.join(', ')}})`;
}

async function closeDuckDb(instance: DuckDBInstance, conn: DuckDBConnection): Promise<void> {
  let firstError: unknown;

  try {
    conn.disconnectSync();
  } catch (error) {
    firstError = error;
  }

  try {
    instance.closeSync();
  } catch (error) {
    if (firstError === undefined) {
      firstError = error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

async function convertJsonlToParquet(options: {
  columns: SchemaColumn[];
  outputPath: string;
  sourcePath: string;
}): Promise<void> {
  // Lazy-load the native binding so importing this module (and any barrel that
  // re-exports BatchWriter) does not eagerly resolve `@duckdb/node-api`. The
  // binding is only needed when actually converting JSONL → Parquet.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  try {
    const selectQuery = `SELECT * FROM ${buildTypedJsonRelation(options.sourcePath, options.columns)}`;
    const copySql =
      `COPY (${selectQuery}) TO '${escapeSqlString(options.outputPath)}' ` + '(FORMAT PARQUET)';
    await conn.run(copySql);
  } finally {
    await closeDuckDb(instance, conn);
  }
}

export class BatchWriter {
  private readonly batchDir: string;
  private readonly stream: string;
  private readonly maxRecords: number;
  private readonly compression: 'none' | 'gzip';
  private readonly format: BatchFormat;
  private readonly columns?: SchemaColumn[];
  private readonly makeWriteStream: (filePath: string) => Writable;
  private readonly makeGzip: () => Transform;
  private readonly convertScratchJsonlToParquet: (options: {
    columns: SchemaColumn[];
    outputPath: string;
    sourcePath: string;
  }) => Promise<void>;
  private readonly deleteFile: (filePath: string) => Promise<void>;

  private fileIndex = 0;
  private recordCount = 0;
  private fileStream: Writable | null = null;
  private gzipStream: Transform | null = null;
  private currentFilePath: string | null = null;
  private currentWritePath: string | null = null;
  private dirCreated = false;

  constructor(options: BatchWriterOptions) {
    const resolvedDir = path.resolve(options.batchDir);
    const resolvedStream = path.resolve(resolvedDir, options.stream);
    if (!resolvedStream.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Invalid stream name: path traversal detected in "${options.stream}"`);
    }

    this.batchDir = options.batchDir;
    this.stream = options.stream;
    this.maxRecords = options.maxRecords;
    this.compression = options.compression;
    this.format = options.format ?? 'jsonl';
    this.columns = options.columns;
    this.makeWriteStream =
      options.createWriteStream ??
      ((filePath: string) => fs.createWriteStream(filePath, { flags: 'w' }));
    this.makeGzip = options.createGzip ?? (() => createGzip());
    this.convertScratchJsonlToParquet = options.convertJsonlToParquet ?? convertJsonlToParquet;
    this.deleteFile =
      options.deleteFile ?? ((filePath) => fs.promises.rm(filePath, { force: true }));

    if (this.format === 'parquet' && this.compression !== 'none') {
      throw new Error('Parquet batch writing does not support gzip compression');
    }
    if (this.format === 'parquet' && (!this.columns || this.columns.length === 0)) {
      throw new Error('Parquet batch writing requires schema columns');
    }
  }

  async addRecord(record: Record<string, unknown>): Promise<FinalizedBatch | null> {
    this.ensureStream();

    const line = JSON.stringify(record) + '\n';
    const target = this.gzipStream ?? this.fileStream!;

    if (!target.write(line)) {
      await new Promise<void>((resolve) => target.once('drain', resolve));
    }

    this.recordCount += 1;

    if (this.recordCount >= this.maxRecords) {
      return this.finalize();
    }

    return null;
  }

  async flush(): Promise<FinalizedBatch | null> {
    if (this.recordCount === 0) {
      return null;
    }
    return this.finalize();
  }

  async close(): Promise<void> {
    await this.closeCurrentStream();
  }

  private ensureStream(): void {
    if (this.fileStream) return;

    if (!this.dirCreated) {
      const streamDir = path.join(this.batchDir, this.stream);
      fs.mkdirSync(streamDir, { recursive: true });
      this.dirCreated = true;
    }

    const baseName = `${this.stream}-${this.fileIndex}`;
    const streamDir = path.join(this.batchDir, this.stream);
    this.currentFilePath =
      this.format === 'parquet'
        ? path.join(streamDir, `${baseName}.parquet`)
        : path.join(
            streamDir,
            `${baseName}${this.compression === 'gzip' ? '.jsonl.gz' : '.jsonl'}`
          );
    this.currentWritePath =
      this.format === 'parquet'
        ? path.join(streamDir, `${baseName}.scratch.jsonl`)
        : this.currentFilePath;
    this.fileStream = this.makeWriteStream(this.currentWritePath);

    if (this.compression === 'gzip') {
      this.gzipStream = this.makeGzip();
      this.gzipStream.pipe(this.fileStream);
    }
  }

  private async finalize(): Promise<FinalizedBatch> {
    const filePath = this.currentFilePath;
    const writePath = this.currentWritePath;
    if (filePath === null || writePath === null) {
      throw new Error('BatchWriter.finalize called without an active batch file');
    }
    const recordCount = this.recordCount;

    await this.closeCurrentStream();

    let encoding: BatchEncoding;
    if (this.format === 'parquet') {
      const columns = this.columns;
      if (!columns || columns.length === 0) {
        throw new Error('Parquet batch writing requires schema columns');
      }
      try {
        await this.convertScratchJsonlToParquet({
          sourcePath: writePath,
          outputPath: filePath,
          columns,
        });
      } finally {
        await this.deleteFile(writePath);
      }
      encoding = { format: 'parquet' };
    } else {
      encoding = { format: 'jsonl' };
      if (this.compression === 'gzip') {
        encoding.compression = 'gzip';
      }
    }

    const byteSize = this.statFile(filePath);

    this.fileIndex += 1;
    this.recordCount = 0;

    return { filePath, recordCount, byteSize, encoding };
  }

  private statFile(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private async closeCurrentStream(): Promise<void> {
    try {
      if (this.gzipStream) {
        await new Promise<void>((resolve, reject) => {
          this.gzipStream!.once('error', (err) => {
            this.fileStream!.destroy();
            reject(err);
          });
          this.fileStream!.once('error', reject);
          this.fileStream!.once('finish', resolve);
          this.gzipStream!.end();
        });
      } else if (this.fileStream) {
        await new Promise<void>((resolve, reject) => {
          this.fileStream!.once('error', reject);
          this.fileStream!.end(resolve);
        });
      }
    } finally {
      this.gzipStream = null;
      this.fileStream = null;
      this.currentFilePath = null;
      this.currentWritePath = null;
    }
  }
}
