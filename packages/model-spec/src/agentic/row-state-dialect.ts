/**
 * Everything about the row store that differs between engines. `row-state.ts` and
 * `row-cursors.ts` contain no engine-specific SQL, so adding an engine means adding one
 * `AgenticRowDialect` and a way to connect. See `sql-publication-dialect.ts` for the same
 * split in publication.
 */
import { throwIfCancelled, type SqlParams, type SqlRunnerModule } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../compiler/dialect.js';

export interface AgenticRowDb {
  run(sql: string): Promise<unknown>;
  query(sql: string, params?: SqlParams): Promise<Record<string, unknown>[]>;
}
export interface AgenticRowColumn {
  name: string;
  type: 'text' | 'integer' | 'boolean';
}
export interface AgenticRowTableShape {
  name: string;
  columns: readonly AgenticRowColumn[];
}
/** One column as an engine's catalog reports it. */
export interface AgenticCatalogColumn {
  table: string;
  name: string;
  type: string;
  /** Not nullable, and neither defaulted nor computed. */
  plain: boolean;
}
export interface AgenticRowDialect {
  /** Case-folds and quotes one identifier. */
  identifier(name: string): string;
  /** The placeholder for the 1-based parameter `index`. */
  bind(index: number): string;
  /** The store's own clock in epoch milliseconds. Leases and retention use only this clock. */
  clock: string;
  /** Creates one table. `key` names the row identity, where the engine benefits from one. */
  createTable(table: string, columns: readonly AgenticRowColumn[], key: readonly string[]): string;
  /** Whether every one of `tables` in `namespace` is a base table with exactly these columns.
   * `CREATE TABLE IF NOT EXISTS` keeps whatever already has the name: a view runs its definition
   * on every read, and so does a generated column. An engine where something stored can change
   * what the store's own SQL means also answers false for that, and must ask in a way that
   * stored objects cannot answer for it. */
  hasBaseTables(
    db: AgenticRowDb,
    namespace: string,
    tables: readonly AgenticRowTableShape[]
  ): Promise<boolean>;
  /** Statements to run after the tables, for an engine that needs more than them. */
  setup?(namespace: string): readonly string[];
  /** Adds one row unless `key` already exists. Concurrent calls must add one row between
   * them. Engines that enforce no keys need their own way to do that, which may take more
   * than one statement. A second row fails closed: readers report the run as corrupt. */
  insertIfAbsent(
    db: AgenticRowDb,
    table: string,
    values: Readonly<Record<string, string | number | bigint | boolean>>,
    key: string,
    namespace: string
  ): Promise<void>;
  /** Inserts `rows` rows of `columns`. Repeating identical rows must be harmless. */
  insertRows(table: string, columns: readonly string[], rows: number): string;
  /** Runs one UPDATE and reports how many rows it changed. An engine that fails a concurrent
   * update with an error, as BigQuery and Delta can, retries here within a bound: the callers
   * treat an error as an uncertain write, and a failed heartbeat as lost ownership. */
  changed(db: AgenticRowDb, sql: string, params: SqlParams): Promise<number>;
  /** Longest `data` value per row, in UTF-16 code units. */
  maxRowChars: number;
  /** Largest total `data`, and most rows, in one INSERT. */
  maxInsertChars: number;
  maxInsertRows: number;
}

/** The unquoted parts of a name that was quoted with double quotes. */
export function agenticQuotedParts(quoted: string): string[] {
  return [...quoted.matchAll(/"((?:[^"]|"")*)"/g)].map((part) => part[1]!.replaceAll('""', '"'));
}

/** Whether the catalog reports exactly `tables`, with each type spelled as `types` spells it. */
export function agenticTablesMatch(
  found: readonly AgenticCatalogColumn[],
  tables: readonly AgenticRowTableShape[],
  types: Readonly<Record<AgenticRowColumn['type'], string>>
): boolean {
  return tables.every(({ name, columns }) => {
    const rows = found.filter((row) => row.table === name);
    return (
      rows.length === columns.length &&
      columns.every((column) =>
        rows.some((row) => row.name === column.name && row.type === types[column.type] && row.plain)
      )
    );
  });
}

/** Forwards cancellation with the runner's original call shape when there is no signal. */
export function agenticRowDb(runner: SqlRunnerModule, signal?: AbortSignal): AgenticRowDb {
  if (!runner.query || !runner.supportsBindings) {
    throw new Error('The agentic row store requires a query runner with parameter bindings');
  }
  const query = runner.query;
  return {
    run: (sql) => {
      throwIfCancelled(signal);
      return signal ? runner.run(sql, { signal }) : runner.run(sql);
    },
    async query(sql, params) {
      throwIfCancelled(signal);
      const rows = signal
        ? await query(sql, params, { signal })
        : params === undefined
          ? await query(sql)
          : await query(sql, params);
      return rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value]))
      );
    },
  };
}

const types = { text: 'VARCHAR', integer: 'BIGINT', boolean: 'BOOLEAN' };

/**
 * No keys or indexes: closing a file persists its indexes, and a file with a primary key
 * opened per operation grew by about 250 KiB per checkpoint where the same table without
 * one stayed flat. The layout does not need them. DuckDB allows one writing process, and the
 * store serializes the connections inside it, so `insertIfAbsent` cannot race.
 */
export const duckDbRowDialect: AgenticRowDialect = {
  identifier: (name) => quoteIdentifier(caseName(name, 'duckdb'), 'duckdb'),
  bind: (index) => `$${index}`,
  clock: 'CAST(epoch(now()) * 1000 AS BIGINT)',
  createTable: (table, columns) =>
    `CREATE TABLE IF NOT EXISTS ${table} (${columns
      .map((column) => `${duckDbRowDialect.identifier(column.name)} ${types[column.type]} NOT NULL`)
      .join(', ')})`,
  /**
   * A function name resolves in the open file before the built-ins, and that covers operators
   * and everything `information_schema` is defined with, so a stored macro can change what any
   * statement here means. Only `system.main.duckdb_functions()` keeps working whatever the file
   * holds, so it goes first. A state file has no reason to store a function. Once none is
   * stored, the catalog can be believed, and names are compared here rather than in SQL. The
   * tables have no keys or indexes, and `NOT NULL` is their only constraint, so anything else
   * would run on the store's own writes.
   */
  async hasBaseTables(db, namespace, tables) {
    const schema = agenticQuotedParts(namespace).at(-1)!.toLowerCase();
    const names = new Set(tables.map((table) => table.name));
    const inSchema = (row: Record<string, unknown>): boolean =>
      String(row.schema_name).toLowerCase() === schema;
    try {
      const functions = await db.query(
        `SELECT function_name FROM system.main.duckdb_functions() WHERE database_name <> 'system' LIMIT 1`
      );
      if (functions.length) return false;
      const additions = await db.query(
        `SELECT schema_name, table_name FROM system.main.duckdb_indexes() UNION ALL SELECT schema_name, table_name FROM system.main.duckdb_constraints() WHERE constraint_type <> 'NOT NULL'`
      );
      if (additions.some((row) => inSchema(row) && names.has(String(row.table_name)))) return false;
      const columns = await db.query(
        `SELECT c.schema_name, c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default FROM system.main.duckdb_columns() AS c JOIN system.main.duckdb_tables() AS t ON c.table_oid = t.table_oid WHERE NOT t.internal`
      );
      const found = columns.filter(inSchema).map((row) => ({
        table: String(row.table_name),
        name: String(row.column_name),
        type: String(row.data_type),
        plain: row.is_nullable === false && row.column_default === null,
      }));
      return agenticTablesMatch(found, tables, types);
    } catch (error) {
      // A stored object named like a system one stops the catalog functions from binding.
      if (error instanceof Error && error.message.includes('Binder Error')) return false;
      throw error;
    }
  },
  async insertIfAbsent(db, table, values, key) {
    const names = Object.keys(values);
    const quoted = names.map((name) => duckDbRowDialect.identifier(name)).join(', ');
    const binds = names.map((_, index) => `$${index + 1}`).join(', ');
    await db.query(
      `INSERT INTO ${table} (${quoted}) SELECT ${binds} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${duckDbRowDialect.identifier(key)} = $${names.indexOf(key) + 1})`,
      Object.values(values)
    );
  },
  insertRows(table, columns, rows) {
    const quoted = columns.map((name) => duckDbRowDialect.identifier(name)).join(', ');
    const tuples = Array.from(
      { length: rows },
      (_, row) =>
        `(${columns.map((__, column) => `$${row * columns.length + column + 1}`).join(', ')})`
    );
    return `INSERT INTO ${table} (${quoted}) VALUES ${tuples.join(', ')}`;
  },
  async changed(db, sql, params) {
    return (await db.query(`${sql} RETURNING 1 AS changed`, params)).length;
  },
  maxRowChars: 1024 * 1024,
  maxInsertChars: 4 * 1024 * 1024,
  maxInsertRows: 256,
};
