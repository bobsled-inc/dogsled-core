import { isPlainObject } from '@bobsled-inc/protocol';

import { ExtractorDataError } from './errors.js';

import type { CacheManifestRow } from './cache-substrate.js';

export const MANIFEST_COLUMNS = [
  'document_id',
  'document_version_id',
  'source_uri',
  'content_hash',
  'source_revision',
  'etag',
  'mtime',
  'size',
  'embedder_role',
  'embedder_underlying_model',
  'embedding_dimension',
  'parser_versions',
  'chunker_config_hash',
  'document_count',
  'chunk_count',
  'parse_status',
  'cached_at',
] as const;

export type ManifestColumn = (typeof MANIFEST_COLUMNS)[number];

export function rowToParams(row: CacheManifestRow): unknown[] {
  return [
    row.document_id,
    row.document_version_id,
    row.source_uri,
    row.content_hash,
    row.source_revision,
    row.etag,
    row.mtime,
    row.size,
    row.embedder_role,
    row.embedder_underlying_model,
    row.embedding_dimension,
    JSON.stringify(row.parser_versions),
    row.chunker_config_hash,
    row.document_count,
    row.chunk_count,
    row.parse_status,
    row.cached_at,
  ];
}

export function rowToManifest(row: Record<string, unknown>): CacheManifestRow {
  const parseStatus = stringValue(row, 'parse_status');
  if (parseStatus !== 'parsed' && parseStatus !== 'error') {
    throw new ExtractorDataError(`Invalid cache manifest parse_status "${parseStatus}"`);
  }

  return {
    document_id: stringValue(row, 'document_id'),
    document_version_id: stringValue(row, 'document_version_id'),
    source_uri: stringValue(row, 'source_uri'),
    content_hash: stringValue(row, 'content_hash'),
    source_revision: nullableStringValue(row, 'source_revision'),
    etag: nullableStringValue(row, 'etag'),
    mtime: nullableNumberValue(row, 'mtime'),
    size: nullableNumberValue(row, 'size'),
    embedder_role: nullableStringValue(row, 'embedder_role'),
    embedder_underlying_model: nullableStringValue(row, 'embedder_underlying_model'),
    embedding_dimension: nullableNumberValue(row, 'embedding_dimension'),
    parser_versions: parserVersionsValue(rowValue(row, 'parser_versions')),
    chunker_config_hash: stringValue(row, 'chunker_config_hash'),
    document_count: numberValue(row, 'document_count'),
    chunk_count: numberValue(row, 'chunk_count'),
    parse_status: parseStatus,
    cached_at: stringValue(row, 'cached_at'),
  };
}

function rowValue(row: Record<string, unknown>, field: string): unknown {
  return row[field] ?? row[field.toUpperCase()];
}

function stringValue(row: Record<string, unknown>, field: string): string {
  const value = rowValue(row, field);
  if (typeof value !== 'string') {
    throw new ExtractorDataError(`Cache manifest field "${field}" must be a string`);
  }
  return value;
}

function nullableStringValue(row: Record<string, unknown>, field: string): string | null {
  const value = rowValue(row, field);
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ExtractorDataError(`Cache manifest field "${field}" must be a string or null`);
  }
  return value;
}

function numberValue(row: Record<string, unknown>, field: string): number {
  const value = nullableNumberValue(row, field);
  if (value == null) {
    throw new ExtractorDataError(`Cache manifest field "${field}" must be a number`);
  }
  return value;
}

function nullableNumberValue(row: Record<string, unknown>, field: string): number | null {
  const value = rowValue(row, field);
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ExtractorDataError(`Cache manifest field "${field}" must be a number or null`);
}

function parserVersionsValue(value: unknown): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtractorDataError(
      `Cache manifest field "parser_versions" contains invalid JSON: ${message}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ExtractorDataError('Cache manifest field "parser_versions" must be an object');
  }
  const out: Record<string, string> = {};
  for (const [key, version] of Object.entries(parsed)) {
    if (typeof version !== 'string') {
      throw new ExtractorDataError(
        `Cache manifest parser_versions.${key} must be a string version`
      );
    }
    out[key] = version;
  }
  return out;
}
