export const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_TABLE_PREFIX = '_bobsled_stg_';

export function usesReservedTablePrefix(value: string): boolean {
  return value.toLowerCase().startsWith(RESERVED_TABLE_PREFIX);
}
