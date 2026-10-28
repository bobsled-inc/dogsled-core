import { stat } from 'node:fs/promises';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import type { LoadStrategy, SchemaColumn } from '@bobsled-inc/protocol';
import { CommandError } from '@bobsled-inc/protocol';

import { escapeLiteral, quoteIdentifier, tableRef } from './sql-utils.js';

function columnType(column: SchemaColumn): string {
  switch (column.type) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'array':
    case 'object':
      return 'JSON';
    case 'string':
      return 'VARCHAR';
    case 'vector':
      return `FLOAT[${column.dimension}]`;
  }
}

async function rowCount(runner: SqlRunnerModule, schema: string, table: string): Promise<number> {
  if (!runner.query) return 0;
  const rows = (await runner.query(
    `SELECT COUNT(*) AS c FROM ${tableRef(schema, table)}`
  )) as Array<{ c: number | bigint }>;
  const value = rows[0]?.c ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

export interface RunnerDuckDbDestinationOptions {
  temporary?: boolean;
}

export function createRunnerDuckDbDestination(
  runner: SqlRunnerModule,
  options: RunnerDuckDbDestinationOptions = {}
): DatabaseDestination {
  const truncatedTables = new Set<string>();
  return {
    async initialize() {
      // The owning query command creates schemas per source.
    },
    async ensureTable(schemaName, tableName, columns) {
      if (options.temporary && schemaName !== 'temp') {
        throw new CommandError('temporary DuckDB materializations must use the temp schema', 2);
      }
      if (!options.temporary && schemaName !== 'temp') {
        await runner.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
      }
      const defs = columns
        .map((column) => `${quoteIdentifier(column.name)} ${columnType(column)}`)
        .join(', ');
      const kind = options.temporary ? 'TEMP TABLE' : 'TABLE';
      await runner.run(`CREATE ${kind} IF NOT EXISTS ${tableRef(schemaName, tableName)} (${defs})`);
    },
    async loadAndFinalize(schemaName, tableName, filePath, columns, strategy: LoadStrategy) {
      if (strategy !== 'full_refresh') {
        throw new CommandError('runner-backed DuckDB destination only supports full_refresh', 2);
      }
      const ref = tableRef(schemaName, tableName);
      await runner.run(`TRUNCATE TABLE ${ref}`);
      truncatedTables.add(`${schemaName}.${tableName}`);

      const size = await stat(filePath).then((s) => s.size);
      if (size > 0) {
        const columnList = columns.map((column) => quoteIdentifier(column.name)).join(', ');
        await runner.run(
          `INSERT INTO ${ref} (${columnList}) SELECT ${columnList} FROM read_json_auto('${escapeLiteral(
            filePath
          )}')`
        );
      }
      return { rowsAffected: await rowCount(runner, schemaName, tableName) };
    },
    async close() {
      // The owning query command closes the shared runner.
    },
    getTruncatedTables() {
      return new Set(truncatedTables);
    },
    setTruncatedTables(tables) {
      truncatedTables.clear();
      for (const table of tables) truncatedTables.add(table);
    },
  };
}
