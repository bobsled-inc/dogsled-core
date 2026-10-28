/**
 * Schema discovery for DW/DB sources.
 *
 * Used by `dogsled extract discover` to introspect warehouse schemas and suggest
 * resource configurations including primary keys and cursor fields.
 */

import type { WarehouseClient, TableDiscovery, ColumnDiscovery } from './warehouse-client.js';
import { mapColumnType } from './warehouse-type-mapper.js';
import type { Dialect } from './warehouse-query-builder.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DiscoveredColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface DiscoveredResource {
  name: string;
  table: string;
  database: string;
  schema: string;
  columns: DiscoveredColumn[];
  suggestedPrimaryKey?: string[];
  suggestedCursorField?: string;
}

// ---------------------------------------------------------------------------
// Primary key detection
// ---------------------------------------------------------------------------

/**
 * Detect primary key columns from introspection metadata.
 *
 * Uses two strategies:
 * 1. Columns explicitly marked as primary keys in the source database
 * 2. Heuristic: columns named "id" or ending with "_id" when no explicit PKs exist
 */
function detectPrimaryKey(columns: ColumnDiscovery[]): string[] | undefined {
  // Strategy 1: Use explicit primary keys from source database
  const explicitPks = columns.filter((col) => col.isPrimaryKey).map((col) => col.name);
  if (explicitPks.length > 0) {
    return explicitPks;
  }

  // Strategy 2: Heuristic detection — look for "id" column
  const idColumn = columns.find((col) => col.name.toLowerCase() === 'id');
  if (idColumn) {
    return [idColumn.name];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Cursor field detection
// ---------------------------------------------------------------------------

/** Column names that suggest a good cursor field for incremental extraction. */
const CURSOR_FIELD_PATTERNS = [
  'updated_at',
  'modified_at',
  'last_modified',
  'last_modified_at',
  'updated',
  'modified',
  'created_at',
  'created',
  'inserted_at',
] as const;

/**
 * Detect a suitable cursor field for incremental extraction.
 *
 * Looks for timestamp-like columns with conventional names,
 * preferring "updated_at" variants over "created_at" variants.
 */
function detectCursorField(columns: ColumnDiscovery[], dialect: Dialect): string | undefined {
  const columnNames = new Map(columns.map((col) => [col.name.toLowerCase(), col.name]));

  for (const pattern of CURSOR_FIELD_PATTERNS) {
    const originalName = columnNames.get(pattern);
    if (originalName) {
      // Verify the column type is suitable for cursor-based extraction
      const column = columns.find((c) => c.name === originalName);
      if (column) {
        const mappedType = mapColumnType(dialect, column.sourceType);
        if (mappedType === 'timestamp' || mappedType === 'integer' || mappedType === 'number') {
          return originalName;
        }
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Resource name generation
// ---------------------------------------------------------------------------

/**
 * Generate a snake_case resource name from a table name.
 *
 * Converts PascalCase/camelCase to snake_case and lowercases everything.
 */
function toResourceName(tableName: string): string {
  return tableName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover tables and columns from a warehouse schema.
 *
 * Uses `client.introspect()` and enriches results with:
 * - Suggested primary key detection
 * - Suggested cursor field detection
 * - Resource name generation (snake_case table name)
 */
export async function discoverWarehouseTables(
  client: WarehouseClient,
  database: string,
  schema: string
): Promise<DiscoveredResource[]> {
  const tables = await client.introspect(database, schema);

  return tables.map((table: TableDiscovery) => {
    const columns: DiscoveredColumn[] = table.columns.map((col) => ({
      name: col.name,
      type: col.sourceType,
      nullable: col.nullable,
    }));

    const suggestedPrimaryKey = detectPrimaryKey(table.columns);
    const suggestedCursorField = detectCursorField(table.columns, client.dialect);

    return {
      name: toResourceName(table.tableName),
      table: table.tableName,
      database: table.database ?? database,
      schema: table.schema,
      columns,
      suggestedPrimaryKey,
      suggestedCursorField,
    };
  });
}
