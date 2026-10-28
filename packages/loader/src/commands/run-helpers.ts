import { CommandError, type SchemaColumn } from '@bobsled-inc/protocol';
import { sanitizeStreamName } from '../runtime/utils.js';

export function buildTempFileName(stream: string, index: number, extension: string): string {
  return `${sanitizeStreamName(stream)}-${index}${extension}`;
}

export function nextOutputIndex(indexes: Map<string, number>, stream: string): number {
  const next = indexes.get(stream) ?? 0;
  indexes.set(stream, next + 1);
  return next;
}

type DatabaseDestination =
  | 'duckdb'
  | 'ducklake'
  | 'bigquery'
  | 'snowflake'
  | 'postgres'
  | 'mysql'
  | 'databricks'
  | 'sqlite'
  | 'mssql'
  | 'clickhouse'
  | 'turbopuffer'
  | 'elasticsearch'
  | 'chroma'
  | 'pgvector';

export function supportsNativeParquetLoad(dest: DatabaseDestination): boolean {
  return dest === 'duckdb' || dest === 'ducklake' || dest === 'bigquery' || dest === 'snowflake';
}

export function formatDatabaseError(
  error: unknown,
  destination: string,
  stream: string,
  columns: SchemaColumn[]
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrap = (message: string): Error =>
    error instanceof CommandError ? new CommandError(message, error.exitCode) : new Error(message);
  const invalidIdentifier =
    destination === 'snowflake'
      ? detail.match(/invalid identifier\s+["']([^"']+)["']/i)?.[1]
      : undefined;
  const schemaDrift =
    invalidIdentifier !== undefined ||
    /schema (?:contract violation|change|drift)|type conflict|missing expected|unexpected new columns/i.test(
      detail
    );

  if (!schemaDrift) {
    return wrap(
      `Failed to load stream "${stream}" to ${destination}: ${detail}. ` +
        `Run \`dogsled load check --dest ${destination}\` to diagnose connectivity issues.`
    );
  }

  if (destination === 'snowflake') {
    const likelyMissing = invalidIdentifier
      ? `Snowflake reported invalid identifier "${invalidIdentifier}", so column "${invalidIdentifier}" is likely missing`
      : `the destination table does not match the incoming columns (${columns.map((column) => column.name).join(', ')})`;
    return wrap(
      `Failed to load stream "${stream}" to ${destination}: ${detail}. ${likelyMissing}. ` +
        'Recover with load_strategy: full_refresh and schema_behavior: evolve (the default), or reconcile the Snowflake schema programmatically.'
    );
  }

  return wrap(
    `Failed to load stream "${stream}" to ${destination}: ${detail}. ` +
      `The destination schema drifted from the incoming columns (${columns.map((column) => column.name).join(', ')}); reconcile it programmatically. ` +
      'Use the destination schema migration tooling before retrying.'
  );
}

/**
 * Simple concurrency limiter (like p-limit) to avoid adding a dependency.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const MEMORY_UNITS: Record<string, number> = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
  KIB: 1_024,
  MIB: 1_048_576,
  GIB: 1_073_741_824,
  TIB: 1_099_511_627_776,
};

/**
 * Parse a human-readable memory size string (e.g. "512MB", "2GB", "1GiB") to bytes.
 */
export function parseMemorySize(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!match) {
    throw new Error(`Invalid memory size "${value}". Use a format like "512MB", "2GB", or "1GiB".`);
  }
  const num = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multiplier = MEMORY_UNITS[unit];
  if (multiplier === undefined) {
    throw new Error(`Unknown memory unit "${match[2]}".`);
  }
  return Math.floor(num * multiplier);
}
