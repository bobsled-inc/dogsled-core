import type { ProfileScalarKind } from '../types.js';

export function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

export function clampConfidence(value: number): number {
  return roundRate(Math.max(0, Math.min(1, value)));
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '<null>';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : (v as unknown)));
  }

  return String(value);
}

export function sampleExamples(values: unknown[], limit = 5): unknown[] {
  const examples: unknown[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = stringifyValue(value);
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(value);
    if (examples.length >= limit) break;
  }
  return examples;
}

export function nonNullValues(values: unknown[]): unknown[] {
  return values.filter((value) => value !== null && value !== undefined);
}

export function classifyRuntimeValue(value: unknown): ProfileScalarKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'timestamp';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'bigint':
      return 'integer';
    case 'object':
      return 'object';
    case 'string':
      return classifyStringValue(value);
    default:
      return 'string';
  }
}

export function classifyDeclaredType(dataType: string | undefined): ProfileScalarKind | undefined {
  if (!dataType) return undefined;
  const normalized = dataType
    .trim()
    .toUpperCase()
    .replace(/<.*>$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ');

  if (
    ['BIGINT', 'BYTEINT', 'INT', 'INT2', 'INT4', 'INT8', 'INTEGER', 'SMALLINT', 'TINYINT'].includes(
      normalized
    )
  ) {
    return 'integer';
  }
  if (
    [
      'BIGDECIMAL',
      'BIGNUMERIC',
      'DECIMAL',
      'DOUBLE',
      'DOUBLE PRECISION',
      'FIXED',
      'FLOAT',
      'FLOAT32',
      'FLOAT64',
      'NUMBER',
      'NUMERIC',
      'REAL',
    ].includes(normalized)
  ) {
    return 'number';
  }
  if (['BOOL', 'BOOLEAN'].includes(normalized)) return 'boolean';
  if (normalized === 'DATE') return 'date';
  if (['DATETIME', 'TIME'].includes(normalized) || normalized.startsWith('TIMESTAMP')) {
    return 'timestamp';
  }
  if (['ARRAY', 'LIST', 'REPEATED'].includes(normalized)) return 'array';
  if (
    [
      'GEOGRAPHY',
      'GEOMETRY',
      'JSON',
      'JSONB',
      'MAP',
      'OBJECT',
      'RECORD',
      'STRUCT',
      'VARIANT',
    ].includes(normalized)
  ) {
    return 'object';
  }
  return 'string';
}

function classifyStringValue(value: string): ProfileScalarKind {
  const trimmed = value.trim();
  if (trimmed === '') return 'string';
  if (/^-?\d+$/.test(trimmed)) return 'integer';
  if (/^-?(?:\d+\.\d+|\d+\.|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return 'number';
  if (/^(true|false)$/i.test(trimmed)) return 'boolean';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return 'date';
  if (
    /^\d{4}-\d{2}-\d{2}[tT ][0-9:.+-]+(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed) &&
    !Number.isNaN(Date.parse(trimmed))
  ) {
    return 'timestamp';
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? 'array' : 'object';
    } catch {
      return 'string';
    }
  }
  return 'string';
}
