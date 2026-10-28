/**
 * Value comparison for `seed diff`.
 *
 * Warehouses return a loaded CSV cell in their own representation: `1.5000`
 * for a DECIMAL `1.50`, `true` for `yes`, a `{ value }` wrapper for BigQuery
 * dates, an ISO string for timestamps. Comparing those as raw strings reports
 * every typed row as changed. Each value is reduced to a canonical text for its
 * column family before keys are built and rows compared.
 */

import type { SeedTypeFamily } from './types.js';

/** Plain text for a value returned by a warehouse driver. */
export function warehouseValueText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // BigQuery wraps DATE, DATETIME, TIMESTAMP and TIME values as `{ value }`.
    const wrapped = (value as { value?: unknown }).value;
    if (typeof wrapped === 'string') return wrapped;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
  }
  return String(value);
}

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 't']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'f']);

/** Canonical text for comparing a seed value of the given family. */
export function canonicalSeedValue(text: string, family: SeedTypeFamily | undefined): string {
  if (family === undefined || family === 'text') return text;
  const trimmed = text.trim();
  if (trimmed === '') return '';
  switch (family) {
    case 'integer':
      return /^[-+]?\d+$/.test(trimmed) ? BigInt(trimmed).toString() : trimmed;
    case 'exact':
      return canonicalDecimal(trimmed);
    case 'float': {
      const number = Number(trimmed);
      return Number.isFinite(number) ? String(number) : trimmed;
    }
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (BOOLEAN_TRUE.has(lower)) return 'true';
      if (BOOLEAN_FALSE.has(lower)) return 'false';
      return trimmed;
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
    case 'timestamp':
      return canonicalTimestamp(trimmed);
    case 'time':
      return trimmed.replace(/\.0*$/, '');
  }
}

/** `0012.3400` and `12.34` both become `12.34`; `-0.0` becomes `0`. */
function canonicalDecimal(value: string): string {
  const match = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match) {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : value;
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  const integerPart = whole.replace(/^0+/, '') || '0';
  const fractionPart = fraction.replace(/0+$/, '');
  const digits = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  return sign === '-' && digits !== '0' ? `-${digits}` : digits;
}

/**
 * A timestamp without a zone is read as UTC, as the warehouses store a seed's
 * zone-less text. Returns ISO-8601 in UTC, or the trimmed text if unparseable.
 */
function canonicalTimestamp(value: string): string {
  let iso = value.replace(' ', 'T').replace(/ (?=[+-]\d{2})/, '');
  if (iso.includes('T')) {
    // Zone offsets only follow a time: `+00` and `+0000` become `+00:00`.
    if (/T.*[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
    iso = iso.replace(/(T.*[+-]\d{2})(\d{2})$/, '$1:$2');
  }
  if (!/(Z|T.*[+-]\d{2}:\d{2})$/i.test(iso)) iso = `${iso}${iso.includes('T') ? '' : 'T00:00:00'}Z`;
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
}
