import type { IntegrationFile } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../../src/compiler/dialect.js';
import { agenticRowDb, type AgenticRowDialect } from '../../src/agentic/row-state-dialect.js';
import type { AgenticRowBackend } from '../../src/agentic/row-state-tables.js';
import { openLimitedRunner } from '../../src/agentic/warehouse-statement-limit.js';

const types = { text: 'TEXT', integer: 'BIGINT', boolean: 'BOOLEAN' };
const q = (name: string) => quoteIdentifier(caseName(name, 'postgres'), 'postgres');
const placeholders = (columns: number, row: number) =>
  `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(', ')})`;

/**
 * Everything the row store needs from PostgreSQL. It is here rather than in the package
 * because this change ships DuckDB only; it exists to run the conformance suite and the
 * benchmark, and to show that an engine is SQL differences and nothing else.
 */
export const postgresRowDialect: AgenticRowDialect = {
  identifier: q,
  bind: (index) => `$${index}`,
  clock: 'CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)',
  createTable: (table, columns, key) =>
    `CREATE TABLE IF NOT EXISTS ${table} (${columns
      .map((column) => `${q(column.name)} ${types[column.type]} NOT NULL`)
      .join(', ')}, PRIMARY KEY (${key.map(q).join(', ')}))`,
  async insertIfAbsent(db, table, values, key) {
    const names = Object.keys(values);
    await db.query(
      `INSERT INTO ${table} (${names.map(q).join(', ')}) VALUES ${placeholders(names.length, 0)} ON CONFLICT (${q(key)}) DO NOTHING`,
      Object.values(values)
    );
  },
  insertRows: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES ${Array.from({ length: rows }, (_, row) => placeholders(columns.length, row)).join(', ')} ON CONFLICT DO NOTHING`,
  changed: async (db, sql, params) =>
    (await db.query(`${sql} RETURNING 1 AS changed`, params)).length,
  maxRowChars: 1024 * 1024,
  maxInsertChars: 4 * 1024 * 1024,
  maxInsertRows: 256,
};

export function postgresRowBackend(
  integration: IntegrationFile,
  schema: string,
  leaseMs: number
): AgenticRowBackend {
  return {
    dialect: postgresRowDialect,
    async connect(handling) {
      const runner = await openLimitedRunner(integration, { leaseMs }, handling);
      return {
        namespace: q(schema),
        use: (operation) => operation(agenticRowDb(runner)),
        close: async () => runner.close?.(),
      };
    },
  };
}
