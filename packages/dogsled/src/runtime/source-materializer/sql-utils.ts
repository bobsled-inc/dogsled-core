import { CommandError } from '@bobsled-inc/protocol';

export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SqlDialect = 'bigquery' | 'snowflake' | 'duckdb';

export function validateIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new CommandError(`invalid SQL identifier: ${value}`, 2);
  }
  return value;
}

export function escapeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export function quoteIdentifier(value: string, dialect: SqlDialect = 'duckdb'): string {
  validateIdentifier(value);
  return dialect === 'bigquery' ? `\`${value}\`` : `"${value}"`;
}

export function tableRef(schema: string, table: string, dialect: SqlDialect = 'duckdb'): string {
  if (dialect === 'duckdb' && schema === 'temp') {
    return `temp.main.${quoteIdentifier(table, dialect)}`;
  }
  return `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`;
}

export function safeInteger(value: number): string {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new CommandError(`Expected safe integer, got: ${value}`, 2);
  }
  return String(value);
}

function errorCodeOf(error: unknown, key: 'code' | 'sqlState' | 'sqlstate'): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.toUpperCase();
  if (typeof value === 'number') return String(value).toUpperCase();
  return undefined;
}

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = errorCodeOf(error, 'code');
  const sqlState = errorCodeOf(error, 'sqlState') ?? errorCodeOf(error, 'sqlstate');

  if (sqlState === '42P01' || sqlState === '42704' || sqlState === '42S02') return true;
  if (code === 'ER_NO_SUCH_TABLE' || code === '002003') return true;
  if (
    sqlState === '42601' &&
    /\b(?:object|table|schema|view|stage)\b[\s\S]*\bdoes not exist or not authorized\b/.test(
      normalized
    )
  ) {
    return true;
  }

  if (
    normalized.includes('permission denied') ||
    normalized.includes('access denied') ||
    normalized.includes('not authorized') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return false;
  }

  return (
    /\bno such table\b/.test(normalized) ||
    /\bunknown table\b/.test(normalized) ||
    /\brelation\b[\s\S]*\bdoes not exist\b/.test(normalized) ||
    /\btable\b[\s\S]*\bdoes not exist\b/.test(normalized) ||
    /\btable\b[\s\S]*\bnot found\b/.test(normalized) ||
    /\bnot found:\s*table\b/.test(normalized) ||
    /\btable with name\b[\s\S]*\bdoes not exist\b/.test(normalized)
  );
}
