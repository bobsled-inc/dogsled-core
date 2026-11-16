import {
  CommandError,
  type BatchEncoding,
  type SchemaColumn,
  type LoadStrategy,
  type ColumnType,
  type SchemaBehavior,
} from '@bobsled-inc/protocol';
import {
  RESERVED_TABLE_PREFIX,
  SQL_IDENTIFIER_PATTERN,
  usesReservedTablePrefix,
} from '../identifiers.js';
import { legacyLoadedAtColumns } from './loaded-at-takeover.js';

export const SYSTEM_COLUMNS = {
  TIME_EXTRACTED: '_time_extracted',
  LOADED_AT: '_bobsled_loaded_at',
} as const;

/** SQLite has no column comments; this table records finished loaded-at copies there. */
export const LOADED_AT_COPIES_TABLE = '_bobsled_loaded_at_copies';

/** Prefix of the unique index the SQL destinations add for merge keys (`<prefix><table>`). */
export const UNIQUE_INDEX_PREFIX = '_bobsled_uq_';

/**
 * Column names Core owns on a loaded table: the two it writes plus earlier
 * loaded-at names it took over. None of them is ever a user column, so schema
 * checks never report them as removed (and Snowflake reconcile never drops them).
 */
export const SYSTEM_COLUMN_NAMES: readonly string[] = Object.freeze([
  SYSTEM_COLUMNS.TIME_EXTRACTED,
  SYSTEM_COLUMNS.LOADED_AT,
  ...legacyLoadedAtColumns(SYSTEM_COLUMNS.LOADED_AT),
]);

/** Reject schemas that cannot produce a valid destination table or load query. */
export function assertNonEmptyColumns(stream: string, columns: SchemaColumn[]): void {
  if (columns.length === 0) {
    throw new CommandError(
      `stream "${stream}" declares no columns; refusing to create or load a destination table`,
      2
    );
  }
}

export interface LoadResult {
  rowsAffected: number;
}

interface TableOptimizationLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export interface EnsureTableOptions {
  keyProperties?: string[];
  cursorField?: string;
  partitionBy?: string;
  /** Effective per-stream load strategy, used by strategy-specific schema behavior. */
  loadStrategy?: LoadStrategy;
  schemaBehavior?: SchemaBehavior;
  /** Explicitly reconcile an existing table to the incoming schema contract. */
  reconcileSchema?: boolean;
  /**
   * Exact ownership marker for a table reserved by an external orchestrator.
   *
   * Snowflake destinations persist this marker in the table COMMENT and verify
   * it before creating, rebuilding, or loading a reserved table. Other
   * destinations may ignore the option until they support an equivalent
   * ownership contract.
   */
  tableOwnershipMarker?: string;
}

export type PartitionSource =
  'explicit' | 'cursor_inferred' | 'fallback' | 'not_supported' | 'existing_table';

/**
 * Database destination interface for loading data into a target database.
 *
 * **NULL key behavior**: When a record has NULL in a key column used for MERGE,
 * SQL `NULL = NULL` evaluates to UNKNOWN, so the MERGE ON clause never matches.
 * Records with NULL keys always INSERT (never UPDATE), and multiple records with
 * NULL keys in the same or different batches are never deduplicated against each
 * other. This is consistent with standard SQL semantics.
 */
export interface DatabaseDestination {
  initialize(): Promise<void>;
  ensureTable(
    schemaName: string,
    tableName: string,
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<void>;
  loadAndFinalize(
    schemaName: string,
    tableName: string,
    filePath: string,
    columns: SchemaColumn[],
    strategy: LoadStrategy,
    keyColumns: string[],
    sourceEncoding?: BatchEncoding
  ): Promise<LoadResult>;
  loadFromUri?(
    schemaName: string,
    tableName: string,
    uris: string[],
    columns: SchemaColumn[],
    options?: EnsureTableOptions
  ): Promise<LoadResult>;
  /**
   * Delete the rows whose `column` equals one of `values`, for a REPLACE message. Bind
   * or escape every value. A table or collection that does not exist has no rows to
   * delete. The loader calls it at most once per load, before that load's rows.
   */
  deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void>;
  /**
   * Cancel the active warehouse operation and wait until the driver has
   * acknowledged delivery. Implementations used by cooperative orchestration
   * must provide this; ordinary loader CLI calls may omit it.
   */
  cancel?(): Promise<void>;
  close(): Promise<void>;
  /** Return the set of tables that have been truncated during this run (for full_refresh checkpoint). */
  getTruncatedTables(): Set<string>;
  /** Initialize the truncated tables set from a checkpoint (for restart recovery). */
  setTruncatedTables(tables: Set<string>): void;
}

/** Build up to 4 cluster columns: cursor_field first, then key_properties. */
export function buildClusterColumns(
  columns: SchemaColumn[],
  options?: EnsureTableOptions
): string[] {
  const clusterCols: string[] = [];
  const columnNames = new Set(columns.map((c) => c.name));

  if (options?.cursorField && columnNames.has(options.cursorField)) {
    clusterCols.push(options.cursorField);
  }
  for (const key of options?.keyProperties ?? []) {
    if (columnNames.has(key) && !clusterCols.includes(key) && clusterCols.length < 4) {
      clusterCols.push(key);
    }
  }
  return clusterCols;
}

export function resolvePartitionSource(
  options?: Pick<EnsureTableOptions, 'partitionBy' | 'cursorField'>
): PartitionSource {
  if (options && 'partitionBy' in options && options.partitionBy !== undefined) {
    return 'explicit';
  }
  if (options?.cursorField) {
    return 'cursor_inferred';
  }
  return 'fallback';
}

export function logTableOptimization(
  logger: TableOptimizationLogger | undefined,
  fields: {
    stream: string;
    clusterColumns: string[];
    partitionColumn?: string | null;
    partitionSource?: PartitionSource;
  }
): void {
  logger?.info('table_optimization', {
    stream: fields.stream,
    partitionColumn: fields.partitionColumn ?? null,
    partitionSource: fields.partitionSource ?? 'not_supported',
    clusterColumns: fields.clusterColumns,
  });
}

/**
 * Resolve partition column for time-partitioned destinations.
 *
 * Priority: explicit partitionBy > timestamp cursorField > _time_extracted fallback.
 *
 * Explicit partitionBy errors on mismatch (user expects it to be used).
 * Implicit cursorField silently falls back (it is a smart default, not a user declaration).
 */
export function resolvePartitionColumn(
  columns: SchemaColumn[],
  options?: Pick<EnsureTableOptions, 'partitionBy' | 'cursorField'>
): string {
  if (options && 'partitionBy' in options && options.partitionBy !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.partitionBy)) {
      throw new CommandError(
        `partition_by column '${options.partitionBy}' is not a valid identifier`,
        2
      );
    }
    const col = columns.find((c) => c.name === options.partitionBy);
    if (!col) {
      throw new CommandError(
        `partition_by column '${options.partitionBy}' not found in schema columns`,
        2
      );
    }
    if (col.type !== 'timestamp') {
      throw new CommandError(
        `partition_by column '${options.partitionBy}' must be timestamp type, got '${col.type}'`,
        2
      );
    }
    return options.partitionBy;
  }
  if (options?.cursorField) {
    const col = columns.find((c) => c.name === options.cursorField);
    if (col && col.type === 'timestamp') return options.cursorField;
  }
  return SYSTEM_COLUMNS.TIME_EXTRACTED;
}

export function sanitizeTableName(name: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid table name "${name}": must start with a letter or underscore, ` +
        `followed only by letters (A-Z, a-z), digits (0-9), or underscores (_). ` +
        `Characters such as dots, hyphens, and spaces are not allowed.`
    );
  }

  if (usesReservedTablePrefix(name)) {
    throw new Error(`Invalid table name "${name}": reserved prefix "${RESERVED_TABLE_PREFIX}"`);
  }

  return name;
}

export function sanitizeSchemaName(name: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid schema name "${name}": must start with a letter or underscore, followed by alphanumeric characters or underscores`
    );
  }
  return name;
}

export function validateColumnName(name: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid column name "${name}": must start with a letter or underscore, followed by alphanumeric characters or underscores`
    );
  }
}

// ── Schema comparison and contract enforcement ──

export interface SchemaComparisonResult {
  newColumns: SchemaColumn[];
  removedColumns: string[];
  typeConflicts: Array<{
    column: string;
    existingType: string;
    expectedType: string;
    /** The protocol ColumnType for the existing column (used for widening source check). */
    existingColumnType: ColumnType;
    /** The protocol ColumnType for the expected type (used for widening target check). */
    expectedColumnType: ColumnType;
  }>;
}

/**
 * Reverse-map common database types back to protocol ColumnType.
 * Used by destinations to provide `existingColumnType` in schema comparisons.
 */
export function reverseMapDbType(dbType: string): ColumnType {
  const trimmed = dbType.trim();
  const upperTrimmed = trimmed.toUpperCase();

  if (upperTrimmed === 'ARRAY<FLOAT64>') return 'vector';
  if (/^ARRAY\((FLOAT32|FLOAT64|BFLOAT16)\)$/.test(upperTrimmed)) return 'vector';
  if (/^(FLOAT|DOUBLE)\[\d*\]$/i.test(trimmed)) return 'vector';
  if (/^VECTOR(?:\s*\(\s*(?:FLOAT\s*,\s*)?\d+\s*\))?$/i.test(trimmed)) return 'vector';

  // Special case: MySQL TINYINT(1) is boolean, must check before stripping parens
  if (upperTrimmed === 'TINYINT(1)') return 'boolean';
  let upper = upperTrimmed;
  // Strip Nullable() wrapper (ClickHouse wraps all types in Nullable())
  const nullableMatch = upper.match(/^NULLABLE\((.+)\)$/);
  if (nullableMatch) {
    upper = nullableMatch[1]!;
  }
  upper = upper.replace(/\(.*\)/, '').trim();
  switch (upper) {
    case 'BIGINT':
    case 'INT64':
    case 'INTEGER':
    case 'INT':
    case 'SMALLINT':
    case 'TINYINT':
    case 'LONG':
    case 'NUMBER':
      return 'integer';
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'FLOAT':
    case 'FLOAT64':
    case 'REAL':
      return 'number';
    case 'BOOLEAN':
    case 'BOOL':
    case 'UINT8':
      return 'boolean';
    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP_TZ':
    case 'TIMESTAMP WITH TIME ZONE':
    case 'DATETIME64':
      return 'timestamp';
    default:
      // VARCHAR, TEXT, STRING, and everything else maps to string
      return 'string';
  }
}

const SAFE_WIDENINGS: Partial<Record<ColumnType, ReadonlySet<ColumnType>>> = {
  integer: new Set(['number', 'string']),
  number: new Set(['string']),
  boolean: new Set(['string', 'integer']),
};

export function canWidenType(existingType: ColumnType, newType: ColumnType): boolean {
  return SAFE_WIDENINGS[existingType]?.has(newType) ?? false;
}

export function enforceSchemaContract(
  behavior: SchemaBehavior | undefined,
  comparison: SchemaComparisonResult,
  qualifiedTable: string
): { columnsToAdd: SchemaColumn[]; columnsToWiden: SchemaComparisonResult['typeConflicts'] } {
  const effectiveBehavior = behavior ?? 'evolve';

  switch (effectiveBehavior) {
    case 'strict': {
      if (comparison.newColumns.length > 0) {
        throw new Error(
          `Schema contract violation (strict) on ${qualifiedTable}: ` +
            `unexpected new columns: ${comparison.newColumns.map((c) => c.name).join(', ')}`
        );
      }
      if (comparison.removedColumns.length > 0) {
        throw new Error(
          `Schema contract violation (strict) on ${qualifiedTable}: ` +
            `missing expected columns: ${comparison.removedColumns.join(', ')}`
        );
      }
      if (comparison.typeConflicts.length > 0) {
        const first = comparison.typeConflicts[0]!;
        throw new Error(
          `Schema contract violation (strict) on ${qualifiedTable}: ` +
            `type conflict on ${first.column}: ${first.existingType} vs ${first.expectedType}`
        );
      }
      return { columnsToAdd: [], columnsToWiden: [] };
    }

    case 'freeze':
      return { columnsToAdd: [], columnsToWiden: [] };

    case 'evolve':
    default: {
      // Type conflicts that can be widened are returned as columnsToWiden
      // Non-widenable conflicts still error
      const widenable: SchemaComparisonResult['typeConflicts'] = [];
      const nonWidenable: SchemaComparisonResult['typeConflicts'] = [];
      for (const conflict of comparison.typeConflicts) {
        if (canWidenType(conflict.existingColumnType, conflict.expectedColumnType)) {
          widenable.push(conflict);
        } else {
          nonWidenable.push(conflict);
        }
      }
      if (nonWidenable.length > 0) {
        const first = nonWidenable[0]!;
        throw new Error(
          `Schema change conflict on ${qualifiedTable}.${first.column}: ` +
            `existing type ${first.existingType} does not match expected ${first.expectedType}`
        );
      }
      return { columnsToAdd: comparison.newColumns, columnsToWiden: widenable };
    }
  }
}
