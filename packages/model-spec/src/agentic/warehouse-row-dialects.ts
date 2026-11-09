/** The row store's SQL on PostgreSQL and Snowflake. `row-state-dialect.ts` explains the contract. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier, quoteLiteral } from '../compiler/dialect.js';
import {
  agenticQuotedParts,
  agenticTablesMatch,
  type AgenticRowDb,
  type AgenticRowDialect,
} from './row-state-dialect.js';
import { agenticTableReplaced } from './row-state-tables.js';
import { AGENTIC_ROW_STORE_LIMITS } from './store-limits.js';

const pg = (name: string): string => quoteIdentifier(caseName(name, 'postgres'), 'postgres');
/**
 * Whether nothing another role attached to table `k` runs when the store writes to it. A trigger,
 * rule, check or domain runs with the privileges of the role that writes, and a row policy decides
 * what the store sees. Only the owner can add most of these, so the store's own role must own the
 * table; a trigger can also come from a role it was granted to.
 */
const pgTrusted = `(k.relkind = 'r' AND k.relowner = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER) AND NOT k.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = k.oid AND NOT g.tgisinternal) AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite AS w WHERE w.ev_class = k.oid) AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS x WHERE x.conrelid = k.oid AND x.contype = 'c'))`;
const pgTypes = { text: 'TEXT', integer: 'BIGINT', boolean: 'BOOLEAN' };
const pgTuple = (columns: number, row: number): string =>
  `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(', ')})`;

/**
 * PostgreSQL enforces keys and locks rows, so runs do not contend with each other and the two
 * rules that need uniqueness are one clause each. `clock_timestamp()` rather than `now()`:
 * `now()` is the start of the transaction, which is not the moment a fence is checked.
 */
export const postgresRowDialect: AgenticRowDialect = {
  limits: AGENTIC_ROW_STORE_LIMITS,
  headerTables: [1],
  identifier: pg,
  bind: (index) => `$${index}`,
  clock: 'CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)',
  createTable: (table, columns, key) =>
    `CREATE TABLE IF NOT EXISTS ${table} (${columns
      .map((column) => `${pg(column.name)} ${pgTypes[column.type]} NOT NULL`)
      .join(', ')}, PRIMARY KEY (${key.map(pg).join(', ')}))`,
  /** A name resolves `pg_catalog` first, unless a role's `search_path` lists it later, so a
   * stored function cannot change what this means. It calls none, and names its views in full.
   * It reads only the store's own tables, and refuses one that could run another role's code. */
  async hasBaseTables(db, namespace, tables) {
    const names = tables.map(({ name }) => caseName(name, 'postgres'));
    const columns = await db.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.domain_name, c.is_nullable, c.column_default, c.is_generated, ${pgTrusted} AS trusted FROM information_schema.columns AS c JOIN information_schema.tables AS t ON c.table_schema = t.table_schema AND c.table_name = t.table_name JOIN pg_catalog.pg_namespace AS n ON n.nspname = c.table_schema JOIN pg_catalog.pg_class AS k ON k.relnamespace = n.oid AND k.relname = c.table_name WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE' AND c.table_name IN (${names.map((_, index) => `$${index + 2}`).join(', ')})`,
      [agenticQuotedParts(namespace).at(-1)!, ...names]
    );
    const found = columns.map((row) => ({
      table: String(row.table_name),
      name: String(row.column_name),
      type: String(row.data_type),
      plain:
        row.trusted === true &&
        row.domain_name === null &&
        row.is_nullable === 'NO' &&
        row.column_default === null &&
        row.is_generated === 'NEVER',
    }));
    return agenticTablesMatch(found, tables, {
      text: 'text',
      integer: 'bigint',
      boolean: 'boolean',
    });
  },
  async insertIfAbsent(db, table, values, key, _namespace, absentFrom = []) {
    // A key covers one table, and nothing here could cover two at once.
    if (absentFrom.length) throw new Error('PostgreSQL keeps run headers in one table');
    const names = Object.keys(values);
    await db.query(
      `INSERT INTO ${table} (${names.map(pg).join(', ')}) VALUES ${pgTuple(names.length, 0)} ON CONFLICT (${pg(key)}) DO NOTHING`,
      Object.values(values)
    );
  },
  insertRows: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.map(pg).join(', ')}) VALUES ${Array.from({ length: rows }, (_, row) => pgTuple(columns.length, row)).join(', ')} ON CONFLICT DO NOTHING`,
  changed: async (db, sql, params) =>
    (await db.query(`${sql} RETURNING 1 AS changed`, params)).length,
  maxRowChars: 1024 * 1024,
  maxInsertChars: 4 * 1024 * 1024,
  maxInsertRows: 256,
};

const sf = (name: string): string => quoteIdentifier(caseName(name, 'snowflake'), 'snowflake');
const sfTypes = { text: 'VARCHAR', integer: 'BIGINT', boolean: 'BOOLEAN' };
const sfLiteral = (value: string | number | bigint | boolean): string =>
  typeof value === 'string' || typeof value === 'number'
    ? quoteLiteral(value, 'snowflake')
    : String(value).toUpperCase();
const guardName = '__dogsled_agentic_guard';
const guardTable = (namespace: string): string => `${namespace}.${sf(guardName)}`;

/**
 * One submission, because a reconnect between statements would split a client-side transaction.
 * It has the shape of the publication scripts, which run live. The guard's `UPDATE` waits for
 * every earlier script to commit, and under READ COMMITTED the count that follows it sees what
 * they added, so a key gets one row. The lock is what serializes this: a count alone cannot,
 * and an `INSERT` does not wait for anything.
 */
function insertOnceScript(
  namespace: string,
  table: string,
  values: Readonly<Record<string, string | number | bigint | boolean>>,
  key: string,
  absentFrom: readonly string[]
): string {
  const names = Object.keys(values);
  const tuple = names.map((name) => sfLiteral(values[name]!)).join(', ');
  const match = `${sf(key)} = ${sfLiteral(values[key]!)}`;
  // Every script takes the same guard, so counting the other tables here too means that no two
  // of them can each get a first row for one key.
  const count = absentFrom.length
    ? `(SELECT COUNT(*) FROM (${[table, ...absentFrom].map((from) => `SELECT ${sf(key)} FROM ${from} WHERE ${match}`).join(' UNION ALL ')}))`
    : `(SELECT COUNT(*) FROM ${table} WHERE ${match})`;
  return [
    "DECLARE no_guard EXCEPTION (-20001, 'The row store guard table must hold one row'); matches INTEGER;",
    'BEGIN',
    'BEGIN TRANSACTION;',
    `UPDATE ${guardTable(namespace)} SET ${sf('token')} = ${sfLiteral(randomUUID())};`,
    'IF (SQLROWCOUNT <> 1) THEN RAISE no_guard; END IF;',
    `matches := ${count};`,
    'IF (matches = 0) THEN',
    `INSERT INTO ${table} (${names.map(sf).join(', ')}) VALUES (${tuple});`,
    'END IF;',
    'COMMIT;',
    'EXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;',
    'END;',
  ].join('\n');
}

/** The driver reports a raised `no_guard` with its own number, as the text `-20001`. */
const isNoGuard = (error: unknown): boolean =>
  /^-?0*20001$/.test(String((error as { code?: unknown }).code));

/** A DML result is one row of counts. Without it the write's outcome is unknown, which is not
 * the same as changing nothing: that would read as lost ownership. */
function rowsUpdated(rows: readonly Record<string, unknown>[]): number {
  const reported = rows[0]?.['number of rows updated'];
  const count = ['string', 'number', 'bigint'].includes(typeof reported) ? Number(reported) : NaN;
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('Snowflake did not report how many rows an update changed');
  }
  return count;
}

/**
 * Standard tables enforce no keys, and `UPDATE`s on one table generally run one at a time. The
 * row bounds keep a statement under Snowflake's 1 MB limit, which includes bound values, in the
 * worst case: a UTF-16 unit is at most three bytes, and JSON escaping at most doubles ASCII.
 * Snowflake documents no limit on bind variables, so 1,280 per statement is a cautious choice.
 * No table is clustered: Automatic Clustering is billed background work, and a run is read in
 * full only about eight times.
 */
export const snowflakeRowDialect: AgenticRowDialect = {
  // Measured on a real account up to these limits. Every step that reads the whole run is many
  // statements there, and the session renews its lease between them: see docs/agentic-state.md.
  limits: AGENTIC_ROW_STORE_LIMITS,
  headerTables: [8],
  identifier: sf,
  bind: () => '?',
  // SYSDATE is UTC by definition. CURRENT_TIMESTAMP is in the session's time zone, and the
  // documentation does not say that an epoch taken from it ignores that.
  clock: 'DATE_PART(EPOCH_MILLISECOND, SYSDATE())',
  createTable: (table, columns) =>
    `CREATE TABLE IF NOT EXISTS ${table} (${columns
      .map((column) => `${sf(column.name)} ${sfTypes[column.type]} NOT NULL`)
      .join(', ')})`,
  /** Snowflake refuses a function named like a system one, so nothing stored can change what
   * this means. Its catalog folds names to upper case and reports `BIGINT` as `NUMBER`, so a
   * scale is what tells it from a decimal. A table has no generated columns, but a default or an
   * identity would still put a value there that the store did not write. */
  async hasBaseTables(db, namespace, tables) {
    const parts = agenticQuotedParts(namespace);
    const catalog = parts.length > 1 ? `${sf(parts[0]!)}.` : '';
    const folded = tables.map(({ name, columns: shape }) => ({
      name: caseName(name, 'snowflake'),
      columns: shape.map((column) => ({ ...column, name: caseName(column.name, 'snowflake') })),
    }));
    const guard = caseName(guardName, 'snowflake');
    const names = [...folded.map(({ name }) => name), guard];
    // Only the store's own tables: the schema can hold others, such as the old store's.
    const columns = await db.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.numeric_scale, c.is_nullable, c.column_default, c.is_identity FROM ${catalog}information_schema.columns AS c JOIN ${catalog}information_schema.tables AS t ON c.table_schema = t.table_schema AND c.table_name = t.table_name WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE' AND c.table_name IN (${names.map(() => '?').join(', ')})`,
      [parts.at(-1)!, ...names]
    );
    const found = columns.map((row) => ({
      table: String(row.table_name),
      name: String(row.column_name),
      // Only a number has a scale. Other columns read back the text NULL.
      type:
        row.data_type === 'NUMBER' && Number(row.numeric_scale) !== 0
          ? 'decimal'
          : String(row.data_type),
      plain: row.is_nullable === 'NO' && row.column_default === null && row.is_identity === 'NO',
    }));
    if (!found.some((row) => row.table === guard)) return false;
    return agenticTablesMatch(found, folded, {
      text: 'TEXT',
      integer: 'NUMBER',
      boolean: 'BOOLEAN',
    });
  },
  // Snowflake refuses a table where a view holds the name, rather than keeping the view.
  nameTaken: (error) => String((error as { code?: unknown }).code).replace(/^0+/, '') === '1998',
  // A single atomic CTAS, so the guard is never empty.
  setup: (namespace) => [
    `CREATE TABLE IF NOT EXISTS ${guardTable(namespace)} AS SELECT CAST('' AS VARCHAR) AS ${sf('token')}`,
  ],
  async insertIfAbsent(db, table, values, key, namespace, absentFrom = []) {
    // A resumed run or a known key needs no lock. A row, once present, stays.
    const tables = [table, ...absentFrom];
    const found = await db.query(
      `${tables.map((from) => `SELECT 1 AS found FROM ${from} WHERE ${sf(key)} = ?`).join(' UNION ALL ')} LIMIT 1`,
      tables.map(() => values[key]!)
    );
    if (found.length) return;
    const script = insertOnceScript(namespace, table, values, key, absentFrom);
    try {
      await db.run(`EXECUTE IMMEDIATE ${quoteLiteral(script, 'snowflake')}`);
    } catch (error) {
      // `no_guard`: the guard had no row to lock, so the script stopped before adding anything.
      if (isNoGuard(error)) throw agenticTableReplaced(error);
      throw error;
    }
  },
  insertRows(table, columns, rows) {
    const tuple = `(${columns.map(() => '?').join(', ')})`;
    return `INSERT INTO ${table} (${columns.map(sf).join(', ')}) VALUES ${Array.from({ length: rows }, () => tuple).join(', ')}`;
  },
  changed: async (db, sql, params) => rowsUpdated(await db.query(sql, params)),
  maxRowChars: 256 * 1024,
  maxInsertChars: 256 * 1024,
  maxInsertRows: 128,
};

const lockQueueWaitsMs = [100, 250, 500, 1_000, 2_000, 4_000, 8_000];

function isLockQueueFull(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    String(code).replace(/^0+/, '') === '625' ||
    (typeof message === 'string' && message.includes('number of waiters for this lock exceeds'))
  );
}

/**
 * Snowflake aborts a statement when too many others already wait for the same table lock. Its
 * documentation does not say so, but public reports do, at 20 waiters:
 * https://community.streamsets.com/community-articles-and-got-a-question-7/jdbcqueryexecutor-can-t-execute-querynet-snowflake-client-jdbc-snowflakesqlexception-2177
 * Such a statement never ran, so repeating it is safe, and without this a burst of header updates
 * would read as uncertain writes and lost leases.
 */
export function waitForSnowflakeLockQueue(db: AgenticRowDb, signal?: AbortSignal): AgenticRowDb {
  const retrying = async <T>(statement: () => Promise<T>): Promise<T> => {
    for (const waitMs of lockQueueWaitsMs) {
      try {
        return await statement();
      } catch (error) {
        if (!isLockQueueFull(error)) throw error;
        const jittered = Math.floor(waitMs * (0.5 + Math.random() / 2));
        await delay(jittered, undefined, signal ? { signal } : undefined).catch(() =>
          throwIfCancelled(signal)
        );
      }
    }
    return statement();
  };
  return {
    run: (sql) => retrying(() => db.run(sql)),
    query: (sql, params) => retrying(() => db.query(sql, params)),
  };
}
