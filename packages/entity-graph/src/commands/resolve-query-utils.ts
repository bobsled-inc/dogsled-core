import type { SqlQueryRow } from '@bobsled-inc/model-spec';

export function normalizeQueryRow(row: SqlQueryRow): SqlQueryRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
  ) as SqlQueryRow;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}
