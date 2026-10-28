import { CommandError } from '../errors.js';
import { quoteIdentifier } from '../compiler/dialect.js';

import type { SupportedDialect } from '../compiler/dialect.js';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_SAMPLE_SIZE = 100_000;

export function formatTableReference(table: string, dialect: SupportedDialect): string {
  const parts = table
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    throw new CommandError('Table must be a one-, two-, or three-part identifier.', 2);
  }
  for (const part of parts) {
    if (!identifierPattern.test(part)) {
      throw new CommandError(
        `Unsafe table identifier "${part}". Use simple unquoted table names for profiler v1.`,
        2
      );
    }
  }
  return parts.map((part) => quoteIdentifier(part, dialect)).join('.');
}

export function buildRowCountSql(table: string, dialect: SupportedDialect): string {
  return `SELECT COUNT(*) AS ${quoteIdentifier('row_count', dialect)} FROM ${formatTableReference(table, dialect)}`;
}

export function buildSampleSql(
  table: string,
  dialect: SupportedDialect,
  sampleSize: number
): string {
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new CommandError('--sample-size must be a positive integer.', 2);
  }
  if (sampleSize > MAX_SAMPLE_SIZE) {
    throw new CommandError(`--sample-size must be at most ${MAX_SAMPLE_SIZE}.`, 2);
  }
  return `SELECT * FROM ${formatTableReference(table, dialect)} LIMIT ${sampleSize}`;
}
