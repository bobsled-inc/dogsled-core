import { CommandError } from '@bobsled-inc/protocol';

export function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const s = /^[=+@-]/.test(raw) ? "'" + raw : raw;
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface ReviewExportRow {
  readonly [columnName: string]: unknown;
}

export function readField(row: ReviewExportRow, field: string): unknown {
  return row[field] ?? row[field.toUpperCase()] ?? row[field.toLowerCase()];
}

export function coerceString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) {
    throw new CommandError(`Runner query returned missing ${field}.`, 1);
  }
  return String(value);
}

export function coerceNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

export function coerceNumber(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '') {
    throw new CommandError(`Runner query returned missing ${field}.`, 1);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new CommandError(`Runner query returned non-numeric ${field}.`, 1);
  return n;
}

export function coerceOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CommandError(`Runner query returned invalid ${label}: ${String(value)}.`, 1);
}
