import { RESERVED_STAGING_TABLE_PREFIXES } from './legacy-names.js';

export const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_TABLE_PREFIX = '_dogsled_stg_';

export function usesReservedTablePrefix(value: string): boolean {
  const lower = value.toLowerCase();
  return [RESERVED_TABLE_PREFIX, ...RESERVED_STAGING_TABLE_PREFIXES].some((prefix) =>
    lower.startsWith(prefix)
  );
}
