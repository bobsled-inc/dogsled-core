/**
 * Dialect-specific identifier handling for multi-warehouse SQL codegen.
 *
 * Supports Snowflake (uppercase, double-quoted), BigQuery (lowercase, backtick),
 * and PostgreSQL (lowercase, double-quoted).
 */

import {
  assertBacktickIdentifier,
  CommandError,
  quoteWarehouseLiteral,
} from '@bobsled-inc/protocol';

import { Dialect } from '@polyglot-sql/sdk';

import { RESERVED_WORDS } from './reserved-words.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CANONICAL_DIALECTS = [
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'mysql',
  'duckdb',
  'clickhouse',
] as const;

export const SUPPORTED_DIALECTS = [...CANONICAL_DIALECTS, 'pgvector', 'redshift'] as const;

export type CanonicalDialect = (typeof CANONICAL_DIALECTS)[number];
export type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number];

export type DialectIdentifierStyle =
  | 'double_quote_upper'
  | 'double_quote_lower'
  | 'backtick_lower'
  | 'backtick_preserve';
export type DialectFqnStyle = 'schema_table' | 'database_table' | 'database_schema_table';
export type FuzzyAlgorithmCapability =
  | 'jaro_winkler'
  | 'edit_distance'
  | 'soundex'
  | 'metaphone'
  | 'token_cosine';
export type DialectCapability =
  | 'qualify'
  | 'selectStarExcept'
  | 'flattenJson'
  | 'outerFlatten'
  | 'materializedView'
  | 'dynamicTable'
  | 'incrementalMerge'
  | 'snapshot'
  | 'windowNullsOrdering'
  | 'windowGroupsFrame'
  | 'windowFrameExclude'
  | 'namedWindowClause'
  | 'recursiveCte';

export interface DialectCapabilities {
  qualify: boolean;
  selectStarExcept: boolean;
  selectStarModifier?: 'EXCEPT' | 'EXCLUDE';
  flattenJson: boolean;
  outerFlatten: boolean;
  materializedView: boolean;
  dynamicTable: boolean;
  incrementalMerge: boolean;
  snapshot: boolean;
  /**
   * Native `NULLS FIRST` / `NULLS LAST` in an ORDER BY. False only for MySQL,
   * where the emitter rewrites null placement into a leading sort key.
   */
  windowNullsOrdering: boolean;
  /** `GROUPS` window frame unit (SQL:2011). */
  windowGroupsFrame: boolean;
  /** Window frame `EXCLUDE` clause (SQL:2003). */
  windowFrameExclude: boolean;
  /**
   * `WINDOW <name> AS (...)` clause in a SELECT. False means the compiler
   * inlines each named window at its use site, which is always equivalent, so
   * a conservative false costs verbosity rather than correctness.
   */
  namedWindowClause: boolean;
  /**
   * `WITH RECURSIVE`. Databricks gained it in DBSQL 2025.20 / Runtime 17.0 and
   * it is still preview there, and the compiler cannot see the runtime version,
   * so that target stays off until a connection-level check exists.
   */
  recursiveCte: boolean;
  fuzzyAlgorithms: Record<FuzzyAlgorithmCapability, boolean>;
}

export interface DialectProfile {
  target: SupportedDialect;
  canonicalDialect: CanonicalDialect;
  identifierStyle: DialectIdentifierStyle;
  fqnStyle: DialectFqnStyle;
  capabilities: DialectCapabilities;
}

const FULL_FUZZY_SUPPORT: Record<FuzzyAlgorithmCapability, boolean> = {
  jaro_winkler: true,
  edit_distance: true,
  soundex: true,
  metaphone: false,
  token_cosine: true,
};

const SOUNDEX_ONLY_FUZZY_SUPPORT: Record<FuzzyAlgorithmCapability, boolean> = {
  jaro_winkler: false,
  edit_distance: false,
  soundex: true,
  metaphone: false,
  token_cosine: false,
};

const REDSHIFT_FUZZY_SUPPORT: Record<FuzzyAlgorithmCapability, boolean> = {
  ...SOUNDEX_ONLY_FUZZY_SUPPORT,
  token_cosine: true,
};

/**
 * ClickHouse ships `editDistance`/`levenshteinDistance` and `soundex`. It has
 * no native Jaro-Winkler or Metaphone, and `ngramDistance` is a character-ngram
 * measure rather than the token-cosine the planner expects, so both stay off.
 */
const CLICKHOUSE_FUZZY_SUPPORT: Record<FuzzyAlgorithmCapability, boolean> = {
  jaro_winkler: false,
  edit_distance: true,
  soundex: true,
  metaphone: false,
  token_cosine: false,
};

const POSTGRES_FUZZY_SUPPORT: Record<FuzzyAlgorithmCapability, boolean> = {
  ...FULL_FUZZY_SUPPORT,
  metaphone: true,
};

const POSTGRES_PROFILE: DialectProfile = {
  target: 'postgres',
  canonicalDialect: 'postgres',
  identifierStyle: 'double_quote_lower',
  fqnStyle: 'schema_table',
  capabilities: {
    qualify: false,
    selectStarExcept: false,
    flattenJson: true,
    outerFlatten: true,
    materializedView: true,
    dynamicTable: false,
    incrementalMerge: true,
    snapshot: true,
    windowNullsOrdering: true,
    windowGroupsFrame: true,
    windowFrameExclude: true,
    namedWindowClause: true,
    recursiveCte: true,
    fuzzyAlgorithms: POSTGRES_FUZZY_SUPPORT,
  },
};

const DIALECT_PROFILES: Readonly<Record<SupportedDialect, DialectProfile>> = {
  snowflake: {
    target: 'snowflake',
    canonicalDialect: 'snowflake',
    identifierStyle: 'double_quote_upper',
    fqnStyle: 'database_schema_table',
    capabilities: {
      qualify: true,
      selectStarExcept: true,
      selectStarModifier: 'EXCLUDE',
      flattenJson: true,
      outerFlatten: true,
      materializedView: true,
      dynamicTable: true,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: true,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: false,
      recursiveCte: true,
      fuzzyAlgorithms: FULL_FUZZY_SUPPORT,
    },
  },
  bigquery: {
    target: 'bigquery',
    canonicalDialect: 'bigquery',
    identifierStyle: 'backtick_lower',
    fqnStyle: 'database_schema_table',
    capabilities: {
      qualify: true,
      selectStarExcept: true,
      selectStarModifier: 'EXCEPT',
      flattenJson: true,
      outerFlatten: true,
      materializedView: true,
      dynamicTable: false,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: true,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: true,
      recursiveCte: true,
      fuzzyAlgorithms: FULL_FUZZY_SUPPORT,
    },
  },
  postgres: POSTGRES_PROFILE,
  pgvector: { ...POSTGRES_PROFILE, target: 'pgvector' },
  redshift: {
    target: 'redshift',
    canonicalDialect: 'postgres',
    identifierStyle: 'double_quote_lower',
    fqnStyle: 'schema_table',
    capabilities: {
      qualify: true,
      selectStarExcept: false,
      flattenJson: false,
      outerFlatten: false,
      materializedView: true,
      dynamicTable: false,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: true,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: false,
      recursiveCte: true,
      fuzzyAlgorithms: REDSHIFT_FUZZY_SUPPORT,
    },
  },
  databricks: {
    target: 'databricks',
    canonicalDialect: 'databricks',
    identifierStyle: 'backtick_lower',
    fqnStyle: 'database_schema_table',
    capabilities: {
      qualify: true,
      selectStarExcept: true,
      selectStarModifier: 'EXCEPT',
      flattenJson: true,
      outerFlatten: true,
      materializedView: true,
      dynamicTable: false,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: true,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: true,
      recursiveCte: false,
      fuzzyAlgorithms: FULL_FUZZY_SUPPORT,
    },
  },
  clickhouse: {
    target: 'clickhouse',
    canonicalDialect: 'clickhouse',
    // ClickHouse is case-SENSITIVE for database, table and column names, so
    // it must not reuse `backtick_lower` the way MySQL and BigQuery do —
    // folding `Orders` to `orders` would address a table that does not exist.
    identifierStyle: 'backtick_preserve',
    // No schema level between database and table.
    fqnStyle: 'database_table',
    capabilities: {
      qualify: true,
      selectStarExcept: true,
      selectStarModifier: 'EXCEPT',
      flattenJson: false,
      outerFlatten: false,
      // ClickHouse's MATERIALIZED VIEW is an insert trigger, not a refreshable
      // snapshot of a query over existing data: it only ever sees rows written
      // after it was created. Claiming support would silently produce a view
      // missing every pre-existing row, so models must use `table` instead.
      // (REFRESHABLE MATERIALIZED VIEW is closer but still experimental.)
      materializedView: false,
      dynamicTable: false,
      // ClickHouse has no MERGE statement. The loader emulates upserts with a
      // staging table plus an `ALTER TABLE ... DELETE` mutation, which is not
      // something the model compiler can express, so incremental merge and the
      // snapshot strategy that builds on it stay off.
      incrementalMerge: false,
      snapshot: false,
      windowNullsOrdering: true,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: true,
      // Recursive CTEs arrived in 24.3 and the compiler cannot see the server
      // version, so this follows the Databricks precedent and stays off until
      // a connection-level capability check exists.
      recursiveCte: false,
      fuzzyAlgorithms: CLICKHOUSE_FUZZY_SUPPORT,
    },
  },
  mysql: {
    target: 'mysql',
    canonicalDialect: 'mysql',
    identifierStyle: 'backtick_lower',
    fqnStyle: 'database_table',
    capabilities: {
      qualify: false,
      selectStarExcept: false,
      flattenJson: true,
      outerFlatten: false,
      materializedView: false,
      dynamicTable: false,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: false,
      windowGroupsFrame: false,
      windowFrameExclude: false,
      namedWindowClause: true,
      recursiveCte: true,
      fuzzyAlgorithms: SOUNDEX_ONLY_FUZZY_SUPPORT,
    },
  },
  duckdb: {
    target: 'duckdb',
    canonicalDialect: 'duckdb',
    identifierStyle: 'double_quote_lower',
    fqnStyle: 'database_schema_table',
    capabilities: {
      qualify: true,
      selectStarExcept: true,
      selectStarModifier: 'EXCLUDE',
      flattenJson: true,
      outerFlatten: false,
      materializedView: false,
      dynamicTable: false,
      incrementalMerge: true,
      snapshot: true,
      windowNullsOrdering: true,
      windowGroupsFrame: true,
      windowFrameExclude: true,
      namedWindowClause: true,
      recursiveCte: true,
      fuzzyAlgorithms: FULL_FUZZY_SUPPORT,
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveDialectProfile(target: SupportedDialect): DialectProfile {
  return DIALECT_PROFILES[target];
}

export function getCanonicalDialect(target: SupportedDialect): CanonicalDialect {
  return resolveDialectProfile(target).canonicalDialect;
}

export function isSupportedDialect(value: string): value is SupportedDialect {
  return SUPPORTED_DIALECTS.includes(value as SupportedDialect);
}

export function supportsDialectCapability(
  target: SupportedDialect,
  capability: DialectCapability
): boolean {
  return resolveDialectProfile(target).capabilities[capability];
}

export function getSelectStarModifier(
  target: SupportedDialect
): DialectCapabilities['selectStarModifier'] {
  return resolveDialectProfile(target).capabilities.selectStarModifier;
}

export function supportsFuzzyAlgorithm(
  target: SupportedDialect,
  algorithm: FuzzyAlgorithmCapability
): boolean {
  return resolveDialectProfile(target).capabilities.fuzzyAlgorithms[algorithm];
}

export function unsupportedDialectFeatureError(
  target: SupportedDialect,
  capability:
    | DialectCapability
    | `fuzzy:${FuzzyAlgorithmCapability}`
    // A catalog function with no faithful equivalent on the target. Not a
    // profile capability — it is per-function — but it must still carry the
    // `[unsupported_feature:...]` prefix so callers that classify compile
    // failures by that tag recognise it instead of seeing a bare Error.
    | `catalogFunction:${string}`,
  message: string
): Error {
  return new Error(`[unsupported_feature:${capability}] ${message}`);
}

/** Map a SupportedDialect string to the polyglot-sql Dialect enum. */
export function toPolyglotDialect(d: SupportedDialect): Dialect {
  switch (getCanonicalDialect(d)) {
    case 'snowflake':
      return Dialect.Snowflake;
    case 'bigquery':
      return Dialect.BigQuery;
    case 'postgres':
      return Dialect.PostgreSQL;
    case 'databricks':
      return Dialect.Databricks;
    case 'mysql':
      return Dialect.MySQL;
    case 'clickhouse':
      return Dialect.ClickHouse;
    case 'duckdb':
      return Dialect.DuckDB;
  }
}

/**
 * Quote an identifier per dialect convention.
 *
 * - snowflake:  "UPPER_CASE" (double-quote, escape embedded quotes)
 * - bigquery:   `lower_case` (backtick, escape embedded backticks)
 * - postgres:   "lower_case" (double-quote, escape embedded quotes)
 */
function backtickQuote(name: string, dialect: SupportedDialect): string {
  assertBacktickIdentifier(name);
  if (name.includes('`') && getCanonicalDialect(dialect) === 'bigquery') {
    throw new CommandError('Invalid identifier: BigQuery identifiers cannot contain backticks.', 2);
  }
  return `\`${name.replace(/`/g, '``')}\``;
}

export function quoteIdentifier(name: string, dialect: SupportedDialect): string {
  switch (resolveDialectProfile(dialect).identifierStyle) {
    case 'double_quote_upper':
      return `"${name.toUpperCase().replace(/"/g, '""')}"`;
    case 'backtick_lower':
      return backtickQuote(name.toLowerCase(), dialect);
    case 'backtick_preserve':
      return backtickQuote(name, dialect);
    case 'double_quote_lower':
      return `"${name.toLowerCase().replace(/"/g, '""')}"`;
  }
}

/**
 * Case-fold a name per dialect convention.
 *
 * - snowflake:  UPPER_CASE
 * - bigquery:   lower_case
 * - postgres:   lower_case
 */
export function caseName(name: string, dialect: SupportedDialect): string {
  switch (resolveDialectProfile(dialect).identifierStyle) {
    case 'double_quote_upper':
      return name.toUpperCase();
    case 'backtick_lower':
    case 'double_quote_lower':
      return name.toLowerCase();
    // Case-sensitive dialect: the name is already the name.
    case 'backtick_preserve':
      return name;
  }
}

/**
 * Check whether a name is a reserved word in the given dialect.
 */
export function isReservedWord(name: string, dialect: SupportedDialect): boolean {
  return RESERVED_WORDS[getCanonicalDialect(dialect)].has(name.toUpperCase());
}

/**
 * Return a dialect-appropriate identifier that is quoted if it collides
 * with a reserved word, otherwise case-folded per convention.
 *
 * Use for column references in expressions where the original name comes
 * from user input or source schemas and might collide with reserved words.
 */
export function safeIdentifier(name: string, dialect: SupportedDialect): string {
  if (isReservedWord(name, dialect)) {
    return quoteIdentifier(name, dialect);
  }
  return caseName(name, dialect);
}

/**
 * Quote a column alias preserving the original case from the YAML spec.
 *
 * Unlike `caseName()` which case-folds (UPPER for Snowflake, lower for others),
 * this function wraps the alias in dialect-appropriate quotes when the name
 * contains mixed case, so that `logId`, `eventName`, `authorEmail` etc.
 * appear with their original casing in view definitions and INFORMATION_SCHEMA.
 */
export function quoteColumnAlias(name: string, dialect: SupportedDialect): string {
  // Always quote reserved words regardless of casing
  if (isReservedWord(name, dialect)) {
    return quoteIdentifier(name, dialect);
  }

  switch (resolveDialectProfile(dialect).identifierStyle) {
    case 'double_quote_upper':
      if (name !== name.toUpperCase() && name !== name.toLowerCase()) {
        return `"${name.replace(/"/g, '""')}"`;
      }
      return name.toUpperCase();
    case 'backtick_lower':
      if (name !== name.toLowerCase()) {
        return backtickQuote(name, dialect);
      }
      return name.toLowerCase();
    case 'backtick_preserve':
      return backtickQuote(name, dialect);
    case 'double_quote_lower':
      if (name !== name.toLowerCase()) {
        return `"${name.replace(/"/g, '""')}"`;
      }
      return name.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/**
 * Escape single quotes for SQL string literals. MySQL, BigQuery, Databricks, and
 * Snowflake also require backslash escaping.
 *
 * Order matters: backslash escaping runs FIRST so that the single-quote pass
 * doesn't introduce new backslashes that would then need escaping. Both passes
 * are safe to compose because `''` contains no backslashes and `\\` contains no
 * single quotes.
 *
 * Backslash escaping is applied for MySQL, BigQuery, Databricks, and Snowflake.
 * All four treat backslash as an escape character in single-quoted string
 * literals (e.g. `\n` is a newline, `\t` is a tab), so a literal backslash must
 * be doubled — otherwise a value ending in `\` would escape the closing quote
 * and a `\t`/`\n` inside the data would be silently reinterpreted as a tab or
 * newline. Postgres and DuckDB follow the ANSI standard and do not treat
 * backslash as an escape character. When the caller omits `dialect`, we take the
 * conservative path and still escape backslashes so literal Windows-style paths
 * survive helpers that did not thread the dialect through.
 * This diverges from `@bobsled-inc/extractor`'s `escapeSqlString`, which takes
 * a more conservative approach and escapes backslashes for all dialects.
 */
export function escapeSqlString(value: string, dialect?: SupportedDialect): string {
  let result = value;
  const canonicalDialect = dialect === undefined ? undefined : getCanonicalDialect(dialect);
  if (canonicalDialect === 'snowflake' || canonicalDialect === 'databricks') {
    return quoteWarehouseLiteral(value).slice(1, -1);
  }
  if (
    dialect === undefined ||
    canonicalDialect === 'mysql' ||
    canonicalDialect === 'bigquery' ||
    canonicalDialect === 'clickhouse'
  ) {
    result = result.replace(/\\/g, '\\\\');
    // These dialects treat backslash as an escape character in single-quoted
    // string literals, so raw control characters must be escaped to their
    // backslash sequences. Postgres/DuckDB/Redshift/pgvector follow ANSI
    // semantics and accept raw control chars, so they are left untouched.
    // ClickHouse belongs in this group: it consumes \\, \', \n, \t, \b and
    // friends inside single-quoted literals, so a value ending in a backslash
    // would otherwise close as `'foo\'` — an unterminated literal — and a
    // regex `\b` would reach RE2 as a backspace rather than a word boundary.
    result = result
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\x08/g, '\\b')
      .replace(/\f/g, '\\f');
  }
  // BigQuery parses '' as two adjacent string literals and rejects them with
  // "Syntax error: concatenated string literals must be separated by whitespace
  // or comments". Because BigQuery (like the other backslash dialects handled
  // above) treats backslash as an escape character in single-quoted literals,
  // the apostrophe must be backslash-escaped instead. MySQL, Databricks,
  // Snowflake, and the ANSI dialects accept the standard '' doubling.
  if (canonicalDialect === 'bigquery') {
    result = result.replace(/'/g, "\\'");
  } else {
    result = result.replace(/'/g, "''");
  }
  return result;
}

/** Quote a literal value for SQL. Strings get single-quoted; numbers are stringified. */
export function quoteLiteral(value: string | number, dialect?: SupportedDialect): string {
  return typeof value === 'string' ? `'${escapeSqlString(value, dialect)}'` : String(value);
}

// ---------------------------------------------------------------------------
// Map helper
// ---------------------------------------------------------------------------

/** Get a value from a Map or throw with a descriptive message. */
export function getOrThrow<K, V>(map: Map<K, V>, key: K, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing map key "${String(key)}" in ${context}`);
  }
  return value;
}

/** Build a fully-qualified name from schema + table, quoting both per dialect. */
export function buildFqName(schema: string, name: string, dialect: SupportedDialect): string {
  return `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(name, dialect)}`;
}

/**
 * Emit dialect-safe CREATE TABLE ... AS replacement DDL.
 *
 * PostgreSQL and MySQL do not support `CREATE OR REPLACE TABLE`.
 * For those dialects we emit `DROP TABLE IF EXISTS` followed by `CREATE TABLE ... AS`.
 */
export function createOrReplaceTableAs(fqTableName: string, dialect: SupportedDialect): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  if (canonicalDialect === 'postgres' || canonicalDialect === 'mysql') {
    return `DROP TABLE IF EXISTS ${fqTableName};\nCREATE TABLE ${fqTableName} AS`;
  }
  return `CREATE OR REPLACE TABLE ${fqTableName} AS`;
}

/**
 * Build a fully-qualified name with optional database prefix.
 *
 * - Snowflake:   "DB"."SCHEMA"."TABLE"
 * - BigQuery:    `project`.`dataset`.`table`
 * - Databricks:  `catalog`.`schema`.`table`
 * - Postgres:    "schema"."table" (database ignored — Postgres uses single DB)
 * - MySQL:       `database`.`table` (MySQL uses database, not schema)
 */
export function buildFqNameWithDatabase(
  schema: string,
  name: string,
  dialect: SupportedDialect,
  database?: string
): string {
  if (!database) {
    return buildFqName(schema, name, dialect);
  }

  switch (resolveDialectProfile(dialect).fqnStyle) {
    case 'database_schema_table':
      return `${quoteIdentifier(database, dialect)}.${quoteIdentifier(schema, dialect)}.${quoteIdentifier(name, dialect)}`;
    case 'database_table':
      // MySQL: database.table (schema is the database)
      return `${quoteIdentifier(database, dialect)}.${quoteIdentifier(name, dialect)}`;
    case 'schema_table':
      // Postgres-family targets ignore database in v1.
      return buildFqName(schema, name, dialect);
  }
}

/**
 * Build a dialect-correct `CREATE SCHEMA IF NOT EXISTS` statement for the
 * namespace that owns a materialized object.
 *
 * Mirrors `buildFqNameWithDatabase`'s namespace resolution — everything to the
 * left of the table name — so the schema we ensure is exactly the one the table
 * DDL targets:
 *
 * - `database_schema_table` (snowflake/bigquery/databricks/duckdb):
 *     `CREATE SCHEMA IF NOT EXISTS "DB"."SCHEMA"` (or `"SCHEMA"` when no database).
 *     The database/catalog/project itself is assumed to already exist — only the
 *     schema is created, matching dbt's `create_schema` behavior.
 * - `database_table` (mysql): the "schema" *is* a database and `CREATE SCHEMA` is
 *     a synonym for `CREATE DATABASE`, so we create `database ?? schema`.
 * - `schema_table` (postgres/redshift/pgvector): database is ignored (single-DB
 *     connection), matching `buildFqNameWithDatabase`.
 *
 * Idempotent on every supported dialect — safe to issue on each run.
 */
export function createSchemaIfNotExistsStatement(
  schema: string,
  dialect: SupportedDialect,
  database?: string
): string {
  switch (resolveDialectProfile(dialect).fqnStyle) {
    case 'database_schema_table': {
      const qualified = database
        ? `${quoteIdentifier(database, dialect)}.${quoteIdentifier(schema, dialect)}`
        : quoteIdentifier(schema, dialect);
      return `CREATE SCHEMA IF NOT EXISTS ${qualified}`;
    }
    case 'database_table':
      // MySQL: the Model Spec "schema" maps to a database; `database` wins when set,
      // mirroring buildFqNameWithDatabase's `database.table` routing.
      return `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(database ?? schema, dialect)}`;
    case 'schema_table':
      // Postgres-family targets ignore database (single-DB connection).
      return `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, dialect)}`;
  }
}

/**
 * Format a fully-qualified table name with optional alias,
 * applying dialect-appropriate casing to both the table name and alias.
 *
 * For BigQuery, preserves case of project/dataset identifiers (they are case-sensitive).
 * For other dialects, applies standard casing.
 *
 * Example: "RAW.RAW_ORDERS" with alias "o" and bigquery → "raw.raw_orders AS o"
 * Example: "MyProject.MyDataset.MyTable" with bigquery → "MyProject.MyDataset.MyTable" (preserved)
 */
export function formatTableRef(
  fqTableName: string,
  alias: string | undefined,
  dialect: SupportedDialect
): string {
  let casedTable: string;

  if (getCanonicalDialect(dialect) === 'bigquery') {
    // BigQuery: preserve case for 3-part names (project.dataset.table)
    // but case-fold 2-part names (dataset.table) which are auto-generated
    const parts = fqTableName.split('.');
    if (parts.length >= 3) {
      casedTable = fqTableName; // preserve project/dataset case
    } else {
      casedTable = caseName(fqTableName, dialect);
    }
  } else {
    casedTable = caseName(fqTableName, dialect);
  }

  if (!alias) return casedTable;
  return `${casedTable} AS ${caseName(alias, dialect)}`;
}
