import * as crypto from 'node:crypto';

import {
  quoteIdentifier,
  type SourceEntryColumn,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import type { PlannedPublishedModel } from '@bobsled-inc/model-spec/project';
import type { SchemaColumn } from '@bobsled-inc/protocol';

export function columnsForPublishedModel(model: PlannedPublishedModel): SchemaColumn[] {
  return model.columns.map((column) => ({
    name: column.name,
    type: column.type,
    primary_key: column.primary_key,
    not_null: column.not_null,
  }));
}

export function toSchemaColumns(columns: SourceEntryColumn[]): SchemaColumn[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    primary_key: column.primary_key,
    // not_null intentionally omitted: source-spec metadata may declare a column
    // NOT NULL while the source DB returns NULL (driver coercion, schema drift).
    // We surface the actual value as-is to the published target and let the
    // target schema enforce NOT NULL where appropriate.
  }));
}

export function sourceSelectSql(
  fqRef: string,
  columns: SourceEntryColumn[],
  dialect: SupportedDialect,
  whereClause?: string
): string {
  // quoteIdentifier (not caseName) is intentional defense-in-depth: even
  // though SourceColumnSpec enforces /^[a-zA-Z_]\w*$/ at YAML parse time so
  // column names cannot inject SQL, we quote per-dialect so a programmatic
  // caller that bypasses schema validation can't smuggle a malicious
  // identifier into the staged SELECT.
  const selectList = columns.map((column) => quoteIdentifier(column.name, dialect)).join(', ');
  const where = whereClause ? ` WHERE ${whereClause}` : '';
  return `SELECT ${selectList} FROM ${fqRef}${where}`;
}

/**
 * Project a source/staging row down to the declared output columns. Looks up
 * column names case-insensitively because drivers vary in result casing.
 * Missing values become null so a source column drop produces visible NULLs in
 * the published target rather than crashing the publish run.
 */
export function projectColumns(
  row: Record<string, unknown>,
  columns: SchemaColumn[]
): Record<string, unknown> {
  const lookup = buildCaseInsensitiveLookup(row);
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = lookup.get(column.name.toLowerCase());
    out[column.name] = normalizeJsonValue(value);
  }
  return out;
}

function buildCaseInsensitiveLookup(row: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    map.set(key.toLowerCase(), value);
  }
  return map;
}

export function withExtractedAt(
  row: Record<string, unknown>,
  extractedAt: string
): Record<string, unknown> {
  return { ...row, _time_extracted: extractedAt };
}

/**
 * Big.js or BigQuery wrapped-integer shape detection. Both expose `toString()`
 * returning canonical decimal text. Match the actual shapes instead of every
 * non-default prototype, which would corrupt Map, Set, URL, and user classes.
 */
function isDecimalLikeValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Date || Buffer.isBuffer(value)) return false;
  const obj = value as Record<string, unknown>;
  if (
    (obj['s'] === 1 || obj['s'] === -1) &&
    Array.isArray(obj['c']) &&
    typeof obj['e'] === 'number' &&
    typeof (obj as { toFixed?: unknown })['toFixed'] === 'function'
  ) {
    return true;
  }
  if (typeof obj['value'] === 'string') {
    const proto = Object.getPrototypeOf(obj) as { toString?: unknown } | null;
    if (
      proto &&
      typeof proto.toString === 'function' &&
      proto.toString !== Object.prototype.toString
    ) {
      return true;
    }
  }
  return false;
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (isDecimalLikeValue(value)) return String(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonValue(entry));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, normalizeJsonValue(entry)])
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  return JSON.stringify(value);
}

export function stageTableName(ref: string): string {
  const slug = ref.replace(/[^A-Za-z0-9_]/g, '_');
  const digest = crypto.createHash('sha1').update(ref).digest('hex').slice(0, 8);
  return `__stage_${slug}__${digest}`;
}
