---
name: add-warehouse-source
description: Add a new warehouse or database extractor source to
  @bobsled-inc/extractor. Guides through schema definitions, client
  implementation, SQL dialect support, type mappings, factory wiring, and tests.
---

# Add a Warehouse Source

Use this skill to add or extend a warehouse/database extractor source.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Identify the dialect, authentication shape, discovery behavior, and replication modes.
- Reuse the shared warehouse schemas, client interfaces, query builder, and type mapper.
- Keep credentials indirect, quote identifiers per dialect, and bound reads and retries.

## Completion

- Validate configuration and schema discovery.
- Cover query generation, cursor/state behavior, errors, and mocked client execution.
- Run extractor package gates and the repository precommit gate.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

# Add Warehouse Source

Adds a new warehouse or database source type to `packages/extractor/`. This covers the full vertical: Zod schemas, WarehouseClient implementation, query builder dialect, type mapper, factory wiring, and tests.

## Usage

```
/add-warehouse-source <source-name>
```

Example: `/add-warehouse-source oracle`, `/add-warehouse-source clickhouse`

## Reference Files

Before starting, read these files to understand existing patterns:

| File                                                        | Purpose                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/extractor/src/runtime/warehouse-client.ts`        | `WarehouseClient` interface + `createWarehouseClient()` factory      |
| `packages/extractor/src/runtime/pg-base-client.ts`          | Shared base for PG-compatible clients (connection pooling, batching) |
| `packages/extractor/src/runtime/postgres-client.ts`         | Reference implementation (thin subclass of PgBase)                   |
| `packages/extractor/src/runtime/snowflake-client.ts`        | REST API-based client (alternative pattern, no native driver)        |
| `packages/extractor/src/runtime/mysql-client.ts`            | Standalone client with its own driver (mysql2)                       |
| `packages/extractor/src/framework/core/warehouse.ts`        | Zod schemas: connection, auth, SSL, replication                      |
| `packages/extractor/src/framework/extractor/resource.ts`    | Integration + resource spec discriminated unions                     |
| `packages/extractor/src/runtime/warehouse-query-builder.ts` | Dialect-aware SQL generation (quoting, placeholders, FQN)            |
| `packages/extractor/src/runtime/warehouse-type-mapper.ts`   | Source column types to protocol ColumnType mapping                   |
| `packages/extractor/AGENTS.md`                              | Existing 7-step checklist to expand on                               |

## Workflow

### Step 1: Check if source already exists

```bash
grep -r '<source-name>' packages/extractor/src/framework/core/warehouse.ts
ls packages/extractor/src/runtime/<source-name>-client.ts 2>/dev/null
```

Check `SourceTypeValues` in `packages/extractor/src/framework/core/warehouse.ts`:

```typescript
export const SourceTypeValues = [
  'api',
  'snowflake',
  'bigquery',
  'postgres',
  'redshift',
  'mysql',
  'clickhouse',
  'iceberg',
  'delta',
] as const;
```

If the source already exists, ask the user whether to update or abort.

### Step 2: Study reference implementations

Choose the right pattern based on the source's driver model:

| Pattern                      | When to use                                                            | Reference                                  |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| **PG-compatible base**       | Source uses the `pg` driver (e.g., CockroachDB, AlloyDB, TimescaleDB)  | `pg-base-client.ts` + `postgres-client.ts` |
| **Standalone native driver** | Source has its own npm driver (e.g., `oracledb`, `@clickhouse/client`) | `mysql-client.ts`                          |
| **REST API**                 | Source exposes a SQL-over-HTTP API (e.g., Databricks SQL, Trino)       | `snowflake-client.ts`                      |

Read the chosen reference implementation end-to-end. Pay attention to:

- Config parsing (constructor validates raw config object)
- Connection pooling / lifecycle
- `execute()` async generator yielding ~10K row batches
- `introspect()` using INFORMATION_SCHEMA or system catalog
- `testConnection()` via `SELECT 1`
- `close()` draining pools or no-op for REST

### Step 3: Add connection and auth Zod schemas

**File:** `packages/extractor/src/framework/core/warehouse.ts`

#### 3a: Add the source to SourceTypeValues

```typescript
export const SourceTypeValues = [
  'api',
  'snowflake',
  'bigquery',
  'postgres',
  'redshift',
  'mysql',
  'iceberg',
  'delta',
  '<source-name>', // <-- add here
] as const;
```

#### 3b: Define the connection schema

Follow these conventions:

- Use `.strict()` on every object schema (catches YAML typos)
- Secrets use `*_env` fields (env var name, not the secret itself)
- Non-secret connection fields are plain values (host, port, database)
- Add `.describe()` on every field

Example for a hypothetical Oracle source:

```typescript
export const OracleConnectionSchema = z
  .object({
    host_env: z.string().describe('Env var holding the Oracle host'),
    port: z.number().int().positive().describe('Oracle listener port'),
    service_name: z.string().describe('Oracle service name or SID'),
    schema: z.string().optional().describe('Default schema for unqualified table names'),
  })
  .strict();
```

#### 3c: Define auth schema (if not reusing DatabaseAuthSchema)

Most SQL databases can reuse the existing `DatabaseAuthSchema` (password + IAM variants). Only define a new auth schema if the source has unique auth mechanisms (like Snowflake's PAT/OAuth or BigQuery's ADC/WIF).

```typescript
// Reuse for standard username/password databases:
// DatabaseAuthSchema = discriminatedUnion('type', [DatabasePasswordAuthSchema, DatabaseIamAuthSchema])
```

If the source needs unique auth:

```typescript
export const OracleWalletAuthSchema = z
  .object({
    type: z.literal('wallet'),
    wallet_path_env: z.string().describe('Env var holding the Oracle wallet directory path'),
  })
  .strict();

export const OracleAuthSchema = z.discriminatedUnion('type', [
  DatabasePasswordAuthSchema,
  OracleWalletAuthSchema,
]);
```

#### 3d: Define SSL schema (if needed)

If the source has unique SSL modes, create a dedicated schema. Otherwise reuse `PostgresSslConfigSchema` patterns:

```typescript
export const OracleSslConfigSchema = z
  .object({
    mode: z.enum(['disable', 'require', 'verify-ca', 'verify-dn']).describe('Oracle SSL mode'),
    ca_cert_env: z.string().optional().describe('Env var holding PEM-encoded CA certificate'),
  })
  .strict();
```

#### 3e: Export inferred types

At the bottom of the file, add the inferred TypeScript types:

```typescript
export type OracleConnection = z.infer<typeof OracleConnectionSchema>;
// export type OracleAuth = z.infer<typeof OracleAuthSchema>;  // if custom auth
// export type OracleSslConfig = z.infer<typeof OracleSslConfigSchema>;  // if custom SSL
```

### Step 4: Add the integration spec variant

**File:** `packages/extractor/src/framework/extractor/resource.ts`

#### 4a: Import new schemas

Add the new connection schema (and auth/SSL if custom) to the imports from `../core/index.js`.

#### 4b: Define the integration spec

```typescript
const OracleIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('oracle'),
    connection: OracleConnectionSchema,
    auth: DatabaseAuthSchema, // or OracleAuthSchema if custom
    ssl: OracleSslConfigSchema.optional(), // if applicable
  })
  .strict();
```

#### 4c: Add to the IntegrationSpecSchema union

```typescript
export const IntegrationSpecSchema = z.union([
  SnowflakeIntegrationSpecSchema,
  BigQueryIntegrationSpecSchema,
  PostgresIntegrationSpecSchema,
  RedshiftIntegrationSpecSchema,
  MysqlIntegrationSpecSchema,
  OracleIntegrationSpecSchema, // <-- add before ApiIntegrationSpecSchema
  IcebergIntegrationSpecSchema,
  DeltaIntegrationSpecSchema,
  ApiIntegrationSpecSchema, // API variant MUST be last (fallback)
]);
```

#### 4d: Export the narrowed type

```typescript
export type OracleIntegrationSpec = z.infer<typeof OracleIntegrationSpecSchema>;
```

### Step 5: Implement the WarehouseClient

**File:** `packages/extractor/src/runtime/<source-name>-client.ts`

The client must implement the `WarehouseClient` interface:

```typescript
export interface WarehouseClient {
  readonly dialect: Dialect;
  execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
  introspect(database: string, schema: string): Promise<TableDiscovery[]>;
  close(): Promise<void>;
}
```

#### Key implementation requirements:

**Constructor:**

- Accepts `rawConfig: Record<string, unknown>` and validates into a typed config
- Write a `parse<Source>Config()` function that validates required/optional fields
- Use `requireString()`, `requireNumber()`, `optionalString()` helpers (copy from pg-base or mysql client)
- Do NOT create the driver connection in the constructor -- lazy-initialize in a `getPool()` or `getClient()` method

**Dynamic import for the driver:**

- Use `await import('<driver-package>')` inside a method, never at module top level
- This avoids crashing when the driver package is not installed
- Handle both CJS default exports and ESM named exports: `const Driver = pkg.default?.Pool ?? pkg.Pool;`

```typescript
private async getPool(): Promise<PoolLike> {
  if (this.pool) return this.pool;
  const driver = await import('<driver-package>');
  const Pool = driver.default?.Pool ?? driver.Pool;
  this.pool = new Pool({ /* config */ });
  return this.pool;
}
```

**`execute()` -- AsyncGenerator yielding batches:**

- Yield arrays of `Record<string, unknown>[]` with ~10,000 rows per batch
- Use `BATCH_SIZE = 10_000` constant
- Apply `opts.maxRows` limit across batches
- Stream results if the driver supports it; otherwise fetch all rows and chunk
- Always release connections in a `finally` block

```typescript
async *execute(
  sql: string,
  params?: unknown[],
  opts?: ExecuteOptions
): AsyncGenerator<Record<string, unknown>[]> {
  const pool = await this.getPool();
  const conn = await pool.getConnection();
  try {
    const result = await conn.query(sql, params ?? []);
    const rows = result.rows;
    const maxRows = opts?.maxRows;
    const total = maxRows !== undefined ? Math.min(rows.length, maxRows) : rows.length;
    let offset = 0;
    while (offset < total) {
      const end = Math.min(offset + BATCH_SIZE, total);
      const batch = rows.slice(offset, end);
      if (batch.length > 0) yield batch;
      offset = end;
    }
  } finally {
    conn.release();
  }
}
```

**`testConnection()`:**

- Execute `SELECT 1 AS connected` and consume the generator
- Wrap in try/catch, return `{ success: true }` or `{ success: false, error: message }`

**`introspect(database, schema)`:**

- Query INFORMATION_SCHEMA.COLUMNS (or system catalog) for table/column metadata
- Join to constraint tables to detect primary keys
- Return `TableDiscovery[]` with `ColumnDiscovery` per column
- Use parameterized queries (not string interpolation) for schema/database filters
- Column discovery fields: `name`, `sourceType` (raw DB type string), `nullable`, `isPrimaryKey`, `comment`

**`close()`:**

- Drain the connection pool: `await this.pool.end()`
- Set pool reference to null
- For REST clients: no-op

#### Internal driver type interfaces:

Define minimal interfaces for the driver to avoid importing driver types at the module level:

```typescript
interface PoolLike {
  getConnection(): Promise<ConnectionLike>;
  end(): Promise<void>;
}

interface ConnectionLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  release(): void;
}

interface QueryResultLike {
  rows: Record<string, unknown>[];
}
```

### Step 6: Wire into the factory

**File:** `packages/extractor/src/runtime/warehouse-client.ts`

Add a case to `createWarehouseClient()`:

```typescript
case '<source-name>': {
  const { <SourceName>WarehouseClient } = await import('./<source-name>-client.js');
  return new <SourceName>WarehouseClient(config);
}
```

Place it alphabetically or logically among the existing cases. The dynamic `import()` ensures the driver is only loaded when this source type is actually used.

### Step 7: Add SQL dialect support

**File:** `packages/extractor/src/runtime/warehouse-query-builder.ts`

#### 7a: Add to the Dialect union type

```typescript
export type Dialect =
  | 'snowflake'
  | 'bigquery'
  | 'postgres'
  | 'redshift'
  | 'mysql'
  | 'iceberg'
  | 'delta'
  | '<source-name>';
```

#### 7b: Add identifier quoting

In `quoteIdentifier()`, add the source to the appropriate case:

```typescript
export function quoteIdentifier(dialect: Dialect, name: string): string {
  switch (dialect) {
    case 'snowflake':
    case 'postgres':
    case 'redshift':
    case 'iceberg':
    case 'delta':
    case '<source-name>': // if uses double-quote
      return `"${name.replace(/"/g, '""')}"`;
    case 'bigquery':
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``;
  }
}
```

Quoting rules by database:

- **Double-quote** `"name"`: PostgreSQL, Snowflake, Redshift, Oracle, DuckDB
- **Backtick** `` `name` ``: MySQL, BigQuery, ClickHouse
- **Square bracket** `[name]`: SQL Server (also supports double-quote)

#### 7c: Add parameter placeholder style

In `buildParamPlaceholder()`:

```typescript
function buildParamPlaceholder(dialect: Dialect, index: number): string {
  switch (dialect) {
    case 'snowflake':
      return `:${index}`;
    case 'bigquery':
      return `@p${index}`;
    case 'postgres':
    case 'redshift':
    case 'iceberg':
    case 'delta':
      return `$${index}`;
    case 'mysql':
      return '?';
    case '<source-name>':
      return ':<source-placeholder>'; // dialect-specific
  }
}
```

Placeholder styles:

- `$1, $2, ...` -- PostgreSQL, Redshift, DuckDB
- `:1, :2, ...` -- Snowflake, Oracle
- `@p1, @p2, ...` -- BigQuery
- `?` (positional) -- MySQL, ClickHouse
- `:name` (named) -- some drivers support this

#### 7d: Add table qualification

In `buildFullyQualifiedTable()`, add a case:

```typescript
case '<source-name>': {
  const parts: string[] = [];
  // Adapt based on the source's namespace hierarchy:
  // e.g., Oracle: schema.table, ClickHouse: database.table
  if (config.schema) parts.push(quoteIdentifier(dialect, config.schema));
  parts.push(quoteIdentifier(dialect, config.table));
  return parts.join('.');
}
```

Table qualification patterns:

- `"database"."schema"."table"` -- Snowflake
- `` `project.dataset.table` `` -- BigQuery
- `"schema"."table"` -- PostgreSQL, Redshift, Oracle
- `` `database`.`table` `` -- MySQL, ClickHouse

#### 7e: Handle change_tracking (if applicable)

If the source supports CDC/change tracking, add a builder function and wire it into `buildChangeTrackingQuery()`. Most traditional databases do NOT support change tracking -- they should throw:

```typescript
case '<source-name>':
  throw new Error(
    `change_tracking is not supported for ${config.dialect}. Use incremental_append or incremental_merge instead.`
  );
```

### Step 8: Add type mappings

**File:** `packages/extractor/src/runtime/warehouse-type-mapper.ts`

#### 8a: Create the dialect-specific mapper function

```typescript
function map<SourceName>Type(normalized: string, baseType: string): ColumnType {
  switch (baseType) {
    // Integer types
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
      return 'integer';

    // Number types
    case 'FLOAT':
    case 'DOUBLE':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'NUMBER':
      return 'number';

    // String types
    case 'VARCHAR':
    case 'CHAR':
    case 'TEXT':
    case 'CLOB':
      return 'string';

    // Boolean
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';

    // Timestamps
    case 'TIMESTAMP':
    case 'DATETIME':
      return 'timestamp';

    // Date (mapped to string, not timestamp)
    case 'DATE':
      return 'string';

    // JSON/structured
    case 'JSON':
    case 'JSONB':
      return 'object';

    // Arrays
    case 'ARRAY':
      return 'array';

    // Default fallback
    default:
      return 'string';
  }
}
```

Protocol ColumnType values: `'string' | 'integer' | 'number' | 'boolean' | 'timestamp' | 'array' | 'object'`

Mapping rules:

- **DATE** maps to `'string'` (not timestamp) -- consistent across all dialects
- **TIME** maps to `'string'`
- **DECIMAL/NUMERIC with scale=0** maps to `'integer'` (check for Snowflake/Redshift pattern)
- **Unknown types** default to `'string'`
- Matching is **case-insensitive** (input is uppercased before the switch)
- `baseType` has precision/scale parentheses stripped; `normalized` retains them for scale checks

#### 8b: Wire into mapColumnType()

```typescript
export function mapColumnType(dialect: Dialect, sourceType: string): ColumnType {
  const normalized = sourceType.toUpperCase().trim();
  const baseType = normalized.split('(')[0]?.trim() ?? normalized;

  switch (dialect) {
    // ... existing cases ...
    case '<source-name>':
      return map < SourceName > Type(normalized, baseType);
  }
}
```

### Step 9: Write tests

#### 9a: Add a test fixture YAML

**File:** `packages/extractor/tests/fixtures/integrations/<source-name>.yml`

```yaml
spec_version: '1'
type: integration
name: test_<source_name>
auth_env_vars: [<SOURCE>_HOST, <SOURCE>_USER, <SOURCE>_PASSWORD]
source_type: <source-name>
connection:
  host_env: <SOURCE>_HOST
  port: <default-port>
  database: test_db
  schema: public # if applicable
auth:
  type: password
  username_env: <SOURCE>_USER
  password_env: <SOURCE>_PASSWORD
```

#### 9b: Add schema validation test

**File:** `packages/extractor/tests/unit/warehouse-schemas.test.ts`

Add a test case to the existing `IntegrationSpecSchema -- warehouse integrations` describe block:

```typescript
it('validates <source-name> integration spec', () => {
  const spec = loadYaml('integrations/<source-name>.yml');
  const result = IntegrationSpecSchema.safeParse(spec);
  expect(result.success).toBe(true);
});
```

Also add rejection tests for invalid configs (missing required fields, wrong types).

#### 9c: Add type mapper tests

**File:** `packages/extractor/tests/unit/warehouse-type-mapper.test.ts`

Add a new describe block:

```typescript
describe('mapColumnType -- <source-name>', () => {
  const map = (t: string) => mapColumnType('<source-name>', t);

  describe('integer types', () => {
    it.each(['INT', 'INTEGER', 'BIGINT', 'SMALLINT'])('maps %s to integer', (t) => {
      expect(map(t)).toBe('integer');
    });
  });

  describe('number types', () => {
    it.each(['FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC'])('maps %s to number', (t) => {
      expect(map(t)).toBe('number');
    });
  });

  describe('string types', () => {
    it.each(['VARCHAR', 'CHAR', 'TEXT'])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });
  });

  describe('boolean types', () => {
    it('maps BOOLEAN to boolean', () => {
      expect(map('BOOLEAN')).toBe('boolean');
    });
  });

  describe('timestamp types', () => {
    it.each(['TIMESTAMP', 'DATETIME'])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  describe('date/time types', () => {
    it('maps DATE to string', () => {
      expect(map('DATE')).toBe('string');
    });
  });

  describe('fallback', () => {
    it('maps unknown types to string', () => {
      expect(map('CUSTOMTYPE')).toBe('string');
    });
  });
});
```

#### 9d: Add query builder tests

**File:** `packages/extractor/tests/unit/warehouse-query-builder.test.ts`

Add tests for the new dialect's identifier quoting, placeholder style, and FQN generation:

```typescript
describe('<source-name> dialect', () => {
  it('quotes identifiers correctly', () => {
    expect(quoteIdentifier('<source-name>', 'my_table')).toBe('"my_table"'); // or backtick
  });

  it('builds full refresh query', () => {
    const result = buildExtractionQuery({
      dialect: '<source-name>',
      table: 'users',
      schema: 'public',
      method: 'full_refresh',
    });
    expect(result.sql).toContain('SELECT * FROM');
    expect(result.params).toEqual([]);
  });

  it('builds incremental query with cursor', () => {
    const result = buildExtractionQuery({
      dialect: '<source-name>',
      table: 'events',
      schema: 'public',
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2024-01-01T00:00:00Z',
    });
    expect(result.sql).toContain('WHERE');
    expect(result.params).toHaveLength(1);
  });
});
```

#### 9e: Run all tests

```bash
pnpm --filter @bobsled-inc/extractor test
```

All existing tests must continue to pass. New tests must pass.

## Quality Gates

Run these before considering the work complete:

```bash
# Type-check (catches missing Dialect union members, schema type mismatches)
pnpm --filter @bobsled-inc/extractor run typecheck

# Lint
pnpm --filter @bobsled-inc/extractor run lint

# All extractor tests (includes schema, query builder, type mapper tests)
pnpm --filter @bobsled-inc/extractor test

# Full repo check
pnpm check && pnpm test:unit
```

### Exhaustive switch verification

TypeScript will flag non-exhaustive switches when you add a new Dialect value. Check that ALL switch statements in these files handle the new dialect:

- `warehouse-query-builder.ts`: `quoteIdentifier()`, `buildParamPlaceholder()`, `buildFullyQualifiedTable()`, `buildChangeTrackingQuery()`
- `warehouse-type-mapper.ts`: `mapColumnType()`
- `warehouse-client.ts`: `createWarehouseClient()`

## Key Patterns

### Dynamic import for drivers

Never import database drivers at the module top level. Use dynamic `import()` inside a lazy getter. This prevents crashes when the driver is not installed:

```typescript
// WRONG - crashes if oracledb not installed
import oracledb from 'oracledb';

// CORRECT - only loaded when Oracle source is used
private async getPool() {
  const oracledb = await import('oracledb');
  // ...
}
```

### Connection pooling

All connection-based clients (not REST) must use a connection pool:

- Lazy-create the pool on first use (not in the constructor)
- Default to 5 max connections (`DEFAULT_MAX_CONNECTIONS = 5`)
- Set idle timeout (~30s) and connection timeout (~10s)
- Swallow unexpected pool errors to avoid crashing the process
- `close()` drains the pool and sets the reference to null

### Batch streaming, not row-by-row

`execute()` yields arrays of rows, not individual rows. Target ~10,000 rows per batch for optimal throughput. If the driver supports streaming, stream into a batch buffer and yield when full. If not, fetch all rows and slice into chunks.

### Env var indirection for secrets

Secrets are NEVER stored in YAML. All secret fields use `*_env` suffix and contain an environment variable name. The runtime reads `process.env[config.host_env]` at connection time. This pattern is enforced by the Zod schemas.

### Test fixtures

Test fixtures live in `packages/extractor/tests/fixtures/integrations/`. Each source has a YAML file that the schema validation tests parse. These fixtures must pass `IntegrationSpecSchema.safeParse()`.

### PG-compatible shortcut

If the new source uses the PostgreSQL wire protocol (CockroachDB, AlloyDB, TimescaleDB, Yugabyte), extend `PgCompatibleWarehouseClient` from `pg-base-client.ts`. You only need to:

1. Set `readonly dialect: Dialect = '<source-name>'`
2. Override `introspect()` with source-specific catalog queries
3. Optionally override the constructor if config parsing differs

```typescript
export class CockroachWarehouseClient extends PgCompatibleWarehouseClient {
  readonly dialect: Dialect = 'cockroach';

  constructor(rawConfig: Record<string, unknown>) {
    super(rawConfig, 'CockroachConfig');
  }

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // CockroachDB uses pg_catalog, same as PostgreSQL
    // ...
  }
}
```

### Introspect query patterns

Most databases expose metadata via INFORMATION_SCHEMA. Key tables:

- `INFORMATION_SCHEMA.COLUMNS` -- column names, types, nullability
- `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` + `KEY_COLUMN_USAGE` -- primary key detection

PostgreSQL/Redshift use `pg_catalog` for better visibility with restricted users. Oracle uses `ALL_TAB_COLUMNS` and `ALL_CONSTRAINTS`. ClickHouse uses `system.columns`.

Always use parameterized queries for schema/database filter values to prevent SQL injection.

## Checklist

- [ ] `SourceTypeValues` includes the new source name
- [ ] Connection schema defined with `.strict()` and `*_env` for secrets
- [ ] Auth schema defined or existing `DatabaseAuthSchema` reused
- [ ] SSL schema defined (if applicable)
- [ ] Integration spec variant added to `IntegrationSpecSchema` union (before API fallback)
- [ ] Narrowed TypeScript types exported
- [ ] Client class implements full `WarehouseClient` interface
- [ ] Driver loaded via dynamic `import()`
- [ ] Connection pool with lazy init, idle timeout, connection timeout
- [ ] `execute()` yields ~10K row batches via AsyncGenerator
- [ ] `testConnection()` runs `SELECT 1` with try/catch
- [ ] `introspect()` queries system catalog with PK detection
- [ ] `close()` drains pool
- [ ] Factory case added to `createWarehouseClient()`
- [ ] Dialect added to `Dialect` type union
- [ ] `quoteIdentifier()` handles the new dialect
- [ ] `buildParamPlaceholder()` handles the new dialect
- [ ] `buildFullyQualifiedTable()` handles the new dialect
- [ ] `buildChangeTrackingQuery()` handles the new dialect (throw if unsupported)
- [ ] Type mapper function covers all source column types
- [ ] `mapColumnType()` switch handles the new dialect
- [ ] Test fixture YAML added
- [ ] Schema validation test added
- [ ] Type mapper tests added
- [ ] Query builder tests added
- [ ] `pnpm check && pnpm test:unit` passes
