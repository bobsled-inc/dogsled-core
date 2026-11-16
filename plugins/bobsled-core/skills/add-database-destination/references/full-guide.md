# Add Database Destination

Guides an agent through adding a new database destination to `packages/loader/`. The new destination must implement the `DatabaseDestination` interface and wire into the config schema, factory, CLI, and check command.

## Usage

```
/add-database-destination <destination-name>
```

Example: `/add-database-destination snowflake`

## Reference Files

Before starting, read these files to understand the patterns:

| File                                                     | Purpose                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/loader/src/runtime/destinations/database.ts`   | `DatabaseDestination` interface, `SYSTEM_COLUMNS`, sanitizers, `buildClusterColumns()`          |
| `packages/loader/src/runtime/destinations/duckdb.ts`     | Simpler reference implementation (~300 lines)                                                   |
| `packages/loader/src/runtime/destinations/bigquery.ts`   | Complex reference implementation (~500 lines, GCS staging, Parquet conversion)                  |
| `packages/loader/src/schemas/config.ts`                  | Zod config schema (discriminated union on `dest`)                                               |
| `packages/loader/src/commands/run.ts`                    | Factory wiring: `isDatabaseDestConfig`, `createDefaultDatabaseDestination`, `runDatabaseLoader` |
| `packages/loader/src/commands/check.ts`                  | Connectivity check pattern                                                                      |
| `packages/loader/tests/unit/destinations/duckdb.test.ts` | Test patterns for all strategies                                                                |

## Workflow

### Step 1: Check if destination already exists

```bash
ls packages/loader/src/runtime/destinations/
```

If a file for the destination already exists, ask the user whether to update or abort.

### Step 2: Study the DatabaseDestination interface and reference implementations

Read `packages/loader/src/runtime/destinations/database.ts` to understand the contract. Then read both `duckdb.ts` (simpler, good starting point) and `bigquery.ts` (shows DI interfaces, retry patterns, staging format conversion).

Key interface:

```typescript
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
    keyColumns: string[]
  ): Promise<LoadResult>;
  deleteRows(
    schemaName: string,
    tableName: string,
    column: string,
    values: string[]
  ): Promise<void>;
  close(): Promise<void>;
  getTruncatedTables(): Set<string>;
  setTruncatedTables(tables: Set<string>): void;
}
```

Key shared utilities from `database.ts`:

- `SYSTEM_COLUMNS.TIME_EXTRACTED` = `"_time_extracted"` — set by extractor, arrives in JSONL
- `SYSTEM_COLUMNS.LOADED_AT` = `"_bobsled_loaded_at"` — set by destination at load time (CURRENT_TIMESTAMP or equivalent)
- `sanitizeTableName(name)` — validates `[A-Za-z_][A-Za-z0-9_]*`, rejects `_bobsled_stg_` prefix
- `sanitizeSchemaName(name)` — same validation for schema names
- `buildClusterColumns(columns, options)` — builds up to 4 cluster columns from cursor_field + key_properties

### Step 3: Implement the destination class

Create `packages/loader/src/runtime/destinations/<name>.ts`. Follow this structure:

#### 3a: Define DI interfaces for the database client

Define lightweight interfaces that mirror the real SDK's API surface. This enables unit testing without real database connections. Follow the BigQuery pattern:

```typescript
// DI interfaces for testing
export interface <Name>ClientLike {
  // Methods needed: connect, query, close, etc.
}

export interface <Name>DestinationOptions {
  // Connection params (host, port, database, warehouse, etc.)
  // Optional injected client for testing
  client?: <Name>ClientLike;
  logger?: LoaderLogger;
}
```

#### 3b: Implement the type mapping function

Map `ColumnType` (`string | integer | number | boolean | timestamp | array | object`) to the database's native types. Include an exhaustive switch with `never` check:

```typescript
function map<Name>Type(type: ColumnType): string {
  switch (type) {
    case 'integer': return '<DB_INT_TYPE>';
    case 'number': return '<DB_FLOAT_TYPE>';
    case 'boolean': return '<DB_BOOL_TYPE>';
    case 'timestamp': return '<DB_TIMESTAMP_TYPE>';
    case 'string':
    case 'array':
    case 'object': return '<DB_STRING_TYPE>';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}
```

Note: `array` and `object` always map to the string/text type (JSON stored as text).

#### 3c: Implement identifier quoting

Create a `quoteIdentifier()` function appropriate for the database. Different databases use different quoting:

- DuckDB/PostgreSQL: `"identifier"` (double quotes)
- BigQuery: `` `identifier` `` (backticks)
- Snowflake: `"identifier"` (double quotes, case-sensitive when quoted)
- MySQL: `` `identifier` `` (backticks)

Validate that the identifier does not contain the quote character to prevent SQL injection.

#### 3d: Implement the class

```typescript
export class <Name>Destination implements DatabaseDestination {
  // Private fields:
  private cachedClient?: <Name>ClientLike;       // Lazy-initialized client
  private truncatedTables = new Set<string>();    // full_refresh checkpoint
  private columnCache = new Map<string, Map<string, string>>();  // Avoids repeated schema queries

  constructor(options: <Name>DestinationOptions) { ... }
}
```

#### 3e: `initialize()` — Connect to the database

- Use **dynamic import** for the database SDK (it is an optional peer dependency): `const module = await import('<sdk-package>');`
- Wrap the import in try/catch with a helpful error message telling users to install the package
- Create the client and verify connectivity (e.g., `SELECT 1` or equivalent)
- Ensure the target schema/database exists (create if needed, like BigQuery does with datasets)

```typescript
async initialize(): Promise<void> {
  if (!this.cachedClient) {
    try {
      const module = await import('<sdk-package>');
      this.cachedClient = new module.<Client>({ ...connectionOptions });
    } catch (error) {
      throw new Error(`Failed to load <sdk-package>. Install it to use --dest <name>. ${message}`);
    }
  }
  // Verify connectivity and ensure schema exists
}
```

#### 3f: `ensureTable()` — Create or evolve the table schema

This method is called before every `loadAndFinalize()`. It must be idempotent.

**Column cache fast path**: Check `this.columnCache` first. If all requested columns exist with matching types, return immediately without querying the database.

**Cold path** (first call for a table):

1. Query `information_schema.columns` (or equivalent) for existing columns
2. If table does not exist:
   - Build column definitions from `columns` array using the type mapping function
   - Add system columns: `_time_extracted TIMESTAMP` and `_bobsled_loaded_at TIMESTAMP`
   - Execute `CREATE TABLE IF NOT EXISTS`
   - Populate the column cache
3. If table exists:
   - Compare each column's mapped type against the existing type
   - **Type conflict**: throw `Error(`Schema change conflict on ${table}.${col}: existing type ${existing} does not match expected ${expected}`)` — do NOT auto-cast
   - **New columns**: collect and execute `ALTER TABLE ADD COLUMN` (batch if the database supports it, otherwise one at a time)
   - Ensure system columns exist (add via ALTER TABLE if missing)
   - Update the column cache

**Type normalization**: Some databases return type aliases (e.g., BigQuery returns `INTEGER` vs `INT64`). If the target database has aliases, write a `normalizeType()` function and compare normalized forms. See `normalizeBqType()` in `bigquery.ts`.

**Clustering/partitioning** (optional): If the database supports clustering or partitioning, use `buildClusterColumns(columns, options)` to determine cluster keys. BigQuery partitions by `DATE(_time_extracted)` and clusters by cursor_field + key_properties. Adapt to the target database's capabilities.

#### 3g: `loadAndFinalize()` — Load data with strategy-specific logic

This method receives a `filePath` pointing to a JSONL file containing records with all data columns plus `_time_extracted`. The `_bobsled_loaded_at` column is NOT in the JSONL — it must be set by the destination at load time.

**Three strategy branches:**

##### Append strategy (`strategy === 'append'`)

Straightforward INSERT from the JSONL file into the target table. Set `_bobsled_loaded_at` to `CURRENT_TIMESTAMP` (or equivalent) during the INSERT.

```sql
INSERT INTO <target> (<col_list>, _bobsled_loaded_at)
SELECT <data_cols>, CURRENT_TIMESTAMP FROM <staged_data>
```

Return `{ rowsAffected: <count> }`.

##### Full refresh strategy (`strategy === 'full_refresh'`)

Truncate-on-first-flush pattern:

1. Check `this.truncatedTables.has(qualifiedTable)`
2. If NOT truncated yet: `TRUNCATE TABLE` (or `DELETE FROM`), then add to `truncatedTables`
3. If already truncated: skip truncation (subsequent flushes just append)
4. INSERT same as append

This ensures that multi-flush full_refresh runs don't lose data from earlier flushes.

##### Merge strategy (`strategy === 'merge'`)

The most complex path. Uses a staging table + MERGE statement with dedup and time guard.

1. **Validate**: `keyColumns.length > 0` — throw if empty
2. **Create staging table** with a unique name: `_bobsled_stg_<table>_<random_hex>`
   - Load JSONL data into staging
   - **Dedup within the batch** using `ROW_NUMBER() OVER (PARTITION BY <key_cols> ORDER BY _time_extracted DESC NULLS LAST) = 1`
   - Set `_bobsled_loaded_at = CURRENT_TIMESTAMP` in the staging SELECT
3. **Execute MERGE**:

   ```sql
   MERGE INTO <target> T
   USING <staging> S
   ON T.<key1> = S.<key1> AND T.<key2> = S.<key2> ...
   WHEN MATCHED AND S._time_extracted >= T._time_extracted
     THEN UPDATE SET <non-key-cols> = S.<non-key-cols>
   WHEN NOT MATCHED
     THEN INSERT (<all_cols>) VALUES (S.<all_cols>)
   ```

   - The **time guard** (`S._time_extracted >= T._time_extracted`) prevents older data from overwriting newer data during out-of-order flushes
   - If `updateSet` is empty (all columns are keys), omit the `WHEN MATCHED` clause entirely

4. **Cleanup in `finally` block**: `DROP TABLE IF EXISTS <staging>` — must always run, even on error
5. Return `{ rowsAffected: <staging_row_count> }` (exact insert/update split is usually unavailable)

**NULL key behavior**: SQL `NULL = NULL` evaluates to UNKNOWN, so MERGE ON never matches NULL keys. Records with NULL keys always INSERT. This is standard SQL semantics — do not try to work around it.

**BigQuery-specific MERGE patterns** (reference for cloud warehouses):

- Match target rows on key columns only. Never add a partition-column range derived from the staging batch to the ON clause: `_time_extracted` changes every load and cursor or `partition_by` values can move forward, so the key's existing row falls outside the range and is inserted again as a duplicate
- `_bobsled_loaded_at` as tiebreaker in QUALIFY dedup (for cross-batch ordering)
- Staging table expiration (1-hour TTL) as safety net if cleanup fails

#### 3h: `close()` — Release resources

- Null out the client reference
- Close connections, release pools
- If the database supports it, run a final flush/checkpoint (DuckDB runs `CHECKPOINT`)
- Must be idempotent (safe to call multiple times)

#### 3h2: `deleteRows()` — Replace slices for REPLACE

The loader calls this before the next load of a stream that received a protocol `REPLACE`
message. Delete every row whose `column` equals one of `values`:

- Bind or escape every value; quote `column` with the dialect helper.
- Return without error when the table does not exist yet.
- Batch large value lists (existing destinations use 500 per statement).
- The delete must be visible to the next load before the promise resolves.

#### 3i: `getTruncatedTables()` / `setTruncatedTables()`

Simple checkpoint support for full_refresh recovery:

```typescript
getTruncatedTables(): Set<string> {
  return new Set(this.truncatedTables);
}

setTruncatedTables(tables: Set<string>): void {
  this.truncatedTables = new Set(tables);
}
```

### Step 4: Add the type mapping to exports

If the destination needs any shared type helpers (like `mapDuckDbType` in `duckdb-primitives.ts`), co-locate them with the destination class. Do not create separate type files.

### Step 5: Add the Zod config schema

Edit `packages/loader/src/schemas/config.ts`:

1. Add a new config schema object:

```typescript
const <Name>DestConfigSchema = z.object({
  dest: z.literal('<name>'),
  // Connection options (host, port, database, warehouse, role, etc.)
  targetSchema: sqlIdentifier.default('<default_schema>'),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
});
```

2. Add the schema to the `LoaderConfigSchema` discriminated union:

```typescript
export const LoaderConfigSchema = z.discriminatedUnion('dest', [
  LocalDestConfigSchema,
  GcsDestConfigSchema,
  S3DestConfigSchema,
  DuckDbDestConfigSchema,
  BigQueryDestConfigSchema,
  <Name>DestConfigSchema, // Add here
]);
```

3. Export the inferred type:

```typescript
export type <Name>DestConfig = z.infer<typeof <Name>DestConfigSchema>;
```

### Step 6: Wire the factory in `run.ts`

Edit `packages/loader/src/commands/run.ts`:

1. **Import the new config type** at the top:

   ```typescript
   import type { <Name>DestConfig } from '../schemas/config.js';
   ```

2. **Update `isDatabaseDestConfig`** to include the new destination:

   ```typescript
   function isDatabaseDestConfig(
     config: LoaderConfig
   ): config is DuckDbDestConfig | BigQueryDestConfig | <Name>DestConfig {
     return config.dest === 'duckdb' || config.dest === 'bigquery' || config.dest === '<name>';
   }
   ```

3. **Update `createDefaultDatabaseDestination`** to handle the new destination:

   ```typescript
   async function createDefaultDatabaseDestination(
     config: DuckDbDestConfig | BigQueryDestConfig | <Name>DestConfig,
     options?: CreateDatabaseDestOptions
   ): Promise<DatabaseDestination> {
     if (config.dest === 'duckdb') { ... }
     if (config.dest === '<name>') {
       const { <Name>Destination } = await import('../runtime/destinations/<name>.js');
       return new <Name>Destination({
         // Map config fields to constructor options
         logger: options?.logger,
       });
     }
     // BigQuery fallthrough...
   }
   ```

4. **Update `runDatabaseLoader` signature** to accept the new config type:

   ```typescript
   export async function runDatabaseLoader(
     rawConfig: DuckDbDestConfig | BigQueryDestConfig | <Name>DestConfig,
     ...
   ```

5. **Update `RunLoaderDependencies.createDatabaseDestination`** type to include the new config.

6. **Update `registerRunCommand`** to add CLI options for the new destination (e.g., `--host`, `--port`, `--warehouse`).

7. **Update the `--dest` option description** to include the new destination name.

### Step 7: Add a check command

Edit `packages/loader/src/commands/check.ts`:

1. Add a `check<Name>` function following the existing patterns:

```typescript
async function check<Name>(
  options: {/* connection params */},
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const module = await import('<sdk-package>');
    // Create client, run SELECT 1 or equivalent
    stderr.write(chalk.green(`OK: <Name> connected successfully`) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`FAIL: <Name>: ${message}`) + '\n');
    setExitCode(1);
  }
}
```

2. Add a `case '<name>':` to the switch in `registerCheckCommand`'s action handler.

3. Add any new CLI options needed for the check (e.g., `--host`, `--warehouse`).

4. Update the `--dest` default error message to include the new destination.

5. Export the check function for testability.

### Step 8: Wire the CLI options

In `packages/loader/src/commands/run.ts` inside `registerRunCommand`:

1. Add `.option()` calls for every connection parameter
2. Map the option names to the config schema field names in the `.action()` handler

In `packages/loader/src/commands/check.ts` inside `registerCheckCommand`:

1. Add `.option()` calls for connection parameters
2. Add the case to the switch statement

Update the help text for `--dest` in both commands to list the new destination.

### Step 9: Write tests

Create `packages/loader/tests/unit/destinations/<name>.test.ts` following the DuckDB test patterns.

**Required test cases** (see `duckdb.test.ts` for the exact patterns):

1. `initialize()` connects successfully
2. `ensureTable()` creates table with correct column types including system columns
3. `ensureTable()` on existing table with new columns adds them via ALTER TABLE
4. `ensureTable()` on type change throws error
5. `loadAndFinalize("append")` inserts rows directly
6. `loadAndFinalize("merge")` deduplicates by PK and merges into target
7. `loadAndFinalize("merge")` deduplicates within a single flush (keeps latest by `_time_extracted`)
8. `loadAndFinalize("full_refresh")` truncates and inserts
9. `loadAndFinalize("full_refresh")` on second flush appends without re-deleting
10. Staging table is dropped even on error
11. `close()` is idempotent
12. JSONL with missing fields results in NULL
13. `_bobsled_loaded_at` is populated for append and merge
14. `_time_extracted` is populated correctly
15. Merge: older timestamp does not overwrite newer data (time guard test)
16. `deleteRows()` deletes matching rows with bound values, batches, and is a no-op for a missing table
17. Merge: newer timestamp updates existing data
18. Merge: equal timestamps allow update (idempotent)
19. Merge: NULL key always inserts

**Test setup pattern**:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Helper to write JSONL test files
async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
```

For databases that require network connections, use the DI interfaces to inject mock clients. See the BigQuery test patterns where `BigQueryClientLike` is mocked.

### Step 10: Report

Print a summary:

```
Added database destination: <name>
  Files created:
    - packages/loader/src/runtime/destinations/<name>.ts
    - packages/loader/tests/unit/destinations/<name>.test.ts
  Files modified:
    - packages/loader/src/schemas/config.ts (added <Name>DestConfigSchema)
    - packages/loader/src/commands/run.ts (factory + CLI wiring)
    - packages/loader/src/commands/check.ts (connectivity check)
  Config options: <list of config fields>
  Strategies: append, merge, full_refresh
  SDK package: <npm-package-name> (optional peer dep, dynamically imported)
```

## Quality Gates

Run all of these before considering the task complete:

```bash
pnpm --filter @bobsled-inc/loader typecheck
pnpm --filter @bobsled-inc/loader lint
pnpm --filter @bobsled-inc/loader test
```

All must pass. Fix any failures before proceeding.

## Key Patterns

### System Columns

Every table gets two system columns added by `ensureTable()`:

| Column               | Source      | Value                                              |
| -------------------- | ----------- | -------------------------------------------------- |
| `_time_extracted`    | Extractor   | Timestamp when the record was extracted (in JSONL) |
| `_bobsled_loaded_at` | Destination | `CURRENT_TIMESTAMP` at load time (NOT in JSONL)    |

### Staging Table Naming

Merge strategy staging tables use the prefix `_bobsled_stg_` followed by the table name and a random hex suffix:

```
_bobsled_stg_<table>_<16-hex-chars>
```

`sanitizeTableName()` rejects any user table name starting with `_bobsled_stg_` to prevent collisions.

### Identifier Sanitization

Always run schema and table names through `sanitizeSchemaName()` / `sanitizeTableName()` from `database.ts` before using them in SQL. These validate the `[A-Za-z_][A-Za-z0-9_]*` pattern.

### ROW_NUMBER Dedup

Within a single merge batch, dedup using:

```sql
ROW_NUMBER() OVER (PARTITION BY <key_cols> ORDER BY _time_extracted DESC NULLS LAST) = 1
```

This keeps the latest record per key within the batch. Note: `PARTITION BY` groups NULLs together (unlike JOIN), so two records with NULL keys in the same batch will be deduped against each other.

### Time Guard on MERGE

The `WHEN MATCHED AND S._time_extracted >= T._time_extracted` clause prevents out-of-order flushes from overwriting newer data. This is critical for correctness when flushes arrive non-sequentially.

### Column Cache

Cache known column names and types per qualified table name (`Map<string, Map<string, string>>`) to avoid repeated `information_schema` queries. Invalidate/update the cache after any `ALTER TABLE` or `CREATE TABLE`.

### Dynamic Import Pattern

Database SDK packages are optional peer dependencies. Always use dynamic `import()` inside `initialize()` or `getClient()`, wrapped in try/catch:

```typescript
try {
  const module = await import('<package>');
  this.client = new module.<Client>({ ... });
} catch (error) {
  throw new Error(`Failed to load <package>. Install it to use --dest <name>. ${message}`);
}
```

### DI Interfaces for Testing

Define minimal interfaces that mirror the real SDK. Inject via constructor options. This enables unit tests to mock all database interactions without real connections. See `BigQueryClientLike`, `BigQueryDatasetLike`, `BigQueryTableLike` in `bigquery.ts` and `DuckDbDatabaseLike`, `DuckDbConnectionLike` in `duckdb-primitives.ts`.

### Full Refresh Checkpoint

The `truncatedTables` set tracks which tables have been truncated in the current run. On restart recovery, `setTruncatedTables()` restores this state from a checkpoint so already-truncated tables are not re-truncated (which would lose data from earlier flushes in the same run).

### Error Handling

- Use `process.exitCode = N; return;` in commands — never `process.exit()`
- Throw `CommandError` from `@bobsled-inc/protocol` for user-facing errors
- Staging table cleanup must be in a `finally` block — always clean up even on error
- Connection release must be in `close()` and idempotent
