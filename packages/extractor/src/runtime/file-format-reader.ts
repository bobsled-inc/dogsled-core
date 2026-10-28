import type { JsonValue } from '@bobsled-inc/protocol';

import {
  type FileResourceSpec,
  type StructuredFileSourceConfig,
  isStructuredFileSource,
} from '../framework/extractor/index.js';
import type { ListedFile } from '../framework/core/index.js';
import { DuckDbEngine, escapeSqlString } from './duckdb-engine.js';
import { ExtractorDataError } from './errors.js';

/**
 * file-format-reader handles only the structured branch of the file source union
 * (csv / jsonl / parquet). Document resources route through document-extraction.ts,
 * per the SourceKind Dispatch Contract.
 */
type StructuredFormat = StructuredFileSourceConfig['format'];
type StructuredOptions = StructuredFileSourceConfig['options'];

export interface FileRecordReadResult {
  columns: Record<string, FileResourceSpec['output'][string]>;
  /**
   * Lazily read records from DuckDB. The iterator is single-use and keeps at
   * most one DuckDB result batch in JavaScript at a time.
   */
  records: AsyncGenerator<Record<string, JsonValue>>;
  /** Close any resources owned by the reader after an early stop. */
  close: () => Promise<void>;
}

function sqlString(value: string): string {
  return `'${escapeSqlString(value)}'`;
}

function duckDbOptionList(options: StructuredOptions | undefined): string {
  const entries: string[] = [];
  if (options?.header !== undefined) {
    entries.push(`header=${options.header ? 'true' : 'false'}`);
  }
  if (options?.delimiter !== undefined) {
    entries.push(`delim=${sqlString(options.delimiter)}`);
  }
  if (options?.null_values !== undefined) {
    entries.push(`nullstr=[${options.null_values.map(sqlString).join(', ')}]`);
  }
  return entries.length > 0 ? `, ${entries.join(', ')}` : '';
}

export function buildDuckDbReadStatement(
  format: StructuredFormat,
  stagedPath: string,
  options?: StructuredOptions
): string {
  const file = sqlString(stagedPath);
  switch (format) {
    case 'csv':
      return `read_csv(${file}${duckDbOptionList(options)})`;
    case 'jsonl':
      return `read_json(${file}, format='newline_delimited')`;
    case 'parquet':
      return `read_parquet(${file})`;
  }
}

function mapDuckDbType(type: string): FileResourceSpec['output'][string]['type'] {
  const normalized = type.toUpperCase();
  if (normalized.includes('INT')) return 'integer';
  if (
    normalized.includes('DOUBLE') ||
    normalized.includes('FLOAT') ||
    normalized.includes('DECIMAL')
  ) {
    return 'number';
  }
  if (normalized.includes('BOOL')) return 'boolean';
  if (normalized.includes('DATE') || normalized.includes('TIME')) return 'timestamp';
  if (normalized.includes('[]') || normalized.startsWith('LIST')) return 'array';
  if (normalized.startsWith('STRUCT') || normalized.startsWith('MAP')) return 'object';
  return 'string';
}

function normalizeValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = normalizeValue(entry);
    }
    return out;
  }
  return String(value);
}

function appendMetadata(
  record: Record<string, JsonValue>,
  resource: FileResourceSpec,
  file: ListedFile
): Record<string, JsonValue> {
  const next = { ...record };
  const lastModified =
    file.last_modified instanceof Date ? file.last_modified.toISOString() : file.last_modified;
  if (resource.source.include_filename || resource.source.include_file_metadata) {
    next['_file_path'] = file.path;
    next['_file_uri'] = file.uri;
  }
  if (resource.source.include_file_metadata) {
    next['_file_modified_at'] = lastModified ?? null;
    next['_file_etag'] = file.etag ?? null;
    next['_file_size'] = file.size ?? null;
  }
  return next;
}

function appendMetadataColumns(
  columns: Record<string, FileResourceSpec['output'][string]>,
  resource: FileResourceSpec
): Record<string, FileResourceSpec['output'][string]> {
  const next = { ...columns };
  if (resource.source.include_filename || resource.source.include_file_metadata) {
    next['_file_path'] = { type: 'string' };
    next['_file_uri'] = { type: 'string' };
  }
  if (resource.source.include_file_metadata) {
    next['_file_modified_at'] = { type: 'timestamp' };
    next['_file_etag'] = { type: 'string' };
    next['_file_size'] = { type: 'integer' };
  }
  return next;
}

export async function readFileRecords(
  engine: DuckDbEngine,
  file: ListedFile,
  stagedPath: string,
  resource: FileResourceSpec,
  signal?: AbortSignal
): Promise<FileRecordReadResult> {
  // The structured branch is the only one this reader handles; document resources are
  // routed through document-extraction.ts. Narrowing here keeps TypeScript happy.
  if (!isStructuredFileSource(resource.source)) {
    throw new ExtractorDataError(
      `readFileRecords called with non-structured source kind "${resource.source.kind}" — document resources are handled elsewhere.`
    );
  }
  const tvf = buildDuckDbReadStatement(resource.source.format, stagedPath, resource.source.options);
  // DESCRIBE performs the same DuckDB CSV/JSONL/Parquet inference as the
  // subsequent SELECT. Keep the source as a table-valued function so DuckDB
  // can stream the SELECT directly; creating a temporary table here would
  // materialize the entire file in native storage before JavaScript sees the
  // first row.
  signal?.throwIfAborted();
  const described = await engine.queryAll(`DESCRIBE SELECT * FROM ${tvf}`);
  signal?.throwIfAborted();
  const inferredColumns: Record<string, FileResourceSpec['output'][string]> = {};
  for (const row of described) {
    const name = String(row['column_name'] ?? row['Field'] ?? '');
    if (!name) continue;
    inferredColumns[name] = {
      type: mapDuckDbType(String(row['column_type'] ?? row['Type'] ?? '')),
    };
  }

  const records = (async function* (): AsyncGenerator<Record<string, JsonValue>> {
    for await (const batch of engine.query(`SELECT * FROM ${tvf}`, signal)) {
      signal?.throwIfAborted();
      for (const row of batch) {
        const normalized: Record<string, JsonValue> = {};
        for (const [key, value] of Object.entries(row)) {
          normalized[key] = normalizeValue(value);
        }
        yield appendMetadata(normalized, resource, file);
      }
    }
  })();

  return {
    columns: appendMetadataColumns(
      Object.keys(resource.output).length ? resource.output : inferredColumns,
      resource
    ),
    records,
    // The native streaming result is closed when its async iterator returns;
    // retain an idempotent close hook so callers can use one cleanup path for
    // readers that may later own additional resources.
    close: async () => undefined,
  };
}
