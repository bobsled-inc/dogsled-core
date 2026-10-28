import { assertDriverVersion } from '@bobsled-inc/connections';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { allRows, closeDuckDbResources, openDuckDb } from '../runtime/duckdb-primitives.js';

import type { Command } from 'commander';
import type { DuckDbConnectionLike, DuckDbDatabaseLike } from '../runtime/duckdb-primitives.js';

export interface QueryDependencies {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  databaseFactory?: (dbPath: string) => Promise<DuckDbDatabaseLike>;
  format?: boolean;
}

function formatRows(
  rows: Record<string, unknown>[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): void {
  if (rows.length === 0) {
    stderr.write('(no results)\n');
    return;
  }

  const columns = Object.keys(rows[0]!);
  stdout.write(columns.join('\t') + '\n');
  for (const row of rows) {
    const values = columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return 'NULL';
      if (val instanceof Date) return val.toISOString();
      // BigQuery returns some values as { value: '...' } objects
      if (typeof val === 'object' && val !== null && 'value' in val) {
        return String((val as { value: unknown }).value);
      }
      return String(val);
    });
    stdout.write(values.join('\t') + '\n');
  }
}

/**
 * Execute operator-supplied SQL against a local DuckDB database.
 * TRUST BOUNDARY: sql parameter is not sanitized — callers must ensure
 * this is only invoked from trusted CLI input, never from user-controlled data.
 */
export async function runQuery(
  dbPath: string,
  sql: string,
  dependencies: QueryDependencies = {}
): Promise<Record<string, unknown>[]> {
  const stderr = dependencies.stderr ?? process.stderr;
  const stdout = dependencies.stdout ?? process.stdout;
  const factory = dependencies.databaseFactory ?? openDuckDb;

  const resolvedPath = path.resolve(dbPath);
  let db: DuckDbDatabaseLike | null = null;
  let conn: DuckDbConnectionLike | null = null;

  try {
    db = await factory(resolvedPath);
    conn = await db.connect();
    const rows = await allRows(conn, sql);
    if (dependencies.format !== false) {
      formatRows(rows, stdout, stderr);
    }
    return rows;
  } finally {
    try {
      await closeDuckDbResources(conn, db);
    } catch {
      // best-effort cleanup
    }
  }
}

export interface BigQueryQueryOptions {
  projectId?: string;
  location?: string;
  keyFilename?: string;
}

/**
 * Execute operator-supplied SQL against BigQuery.
 * TRUST BOUNDARY: sql parameter is not sanitized — callers must ensure
 * this is only invoked from trusted CLI input, never from user-controlled data.
 */
export async function runBigQueryQuery(
  sql: string,
  options: BigQueryQueryOptions,
  dependencies: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    format?: boolean;
  } = {}
): Promise<Record<string, unknown>[]> {
  const stderr = dependencies.stderr ?? process.stderr;
  const stdout = dependencies.stdout ?? process.stdout;

  let module: typeof import('@google-cloud/bigquery');
  assertDriverVersion('@google-cloud/bigquery', '8.1.1', createRequire(import.meta.url));
  try {
    module = await import('@google-cloud/bigquery');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load @google-cloud/bigquery. Install it to use --dest bigquery. ${message}`
    );
  }
  const client = new module.BigQuery({
    projectId: options.projectId,
    location: options.location,
    keyFilename: options.keyFilename,
  });

  const [rows] = await client.query({ query: sql });
  if (dependencies.format !== false) {
    formatRows(rows as Record<string, unknown>[], stdout, stderr);
  }
  return rows as Record<string, unknown>[];
}

type OutputMode = 'json' | 'yaml' | 'text';

function detectOutputMode(yamlFlag: boolean): OutputMode {
  if (yamlFlag) return 'yaml';
  const envFormat = process.env['DOGSLED_OUTPUT_FORMAT']?.toLowerCase();
  if (envFormat === 'json') return 'json';
  if (envFormat === 'text') return 'text';
  if (process.env['CI'] === '1' || process.env['CI'] === 'true') return 'json';
  if (!process.stdout.isTTY) return 'json';
  return 'text';
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function safeYaml(value: unknown): string {
  return stringifyYaml(JSON.parse(safeJson(value)));
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query')
    .description('Run a SQL query against a DuckDB or BigQuery database and print results')
    .option('--dest <dest>', 'Destination: duckdb or bigquery (default: duckdb)')
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID (accepted for CLI compatibility)')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option('--yaml', 'Emit results as YAML (overrides auto-JSON detection)')
    .argument('<sql>', 'SQL query to execute')
    .action(async (sql: string, options: Record<string, unknown>) => {
      const mode = detectOutputMode(!!(options.yaml as boolean | undefined));
      const emit = (payload: unknown) => {
        if (mode === 'yaml') {
          process.stdout.write(safeYaml(payload));
        } else {
          process.stdout.write(`${safeJson(payload)}\n`);
        }
      };
      const emitError = (message: string) => {
        if (mode !== 'text') {
          emit({ error: message, exit_code: 1 });
        } else {
          process.stderr.write(`Error: ${message}\n`);
        }
        process.exitCode = 1;
      };
      try {
        const dest = (options.dest as string | undefined) ?? 'duckdb';

        switch (dest) {
          case 'duckdb': {
            const dbPath = options.dbPath as string | undefined;
            if (!dbPath) {
              emitError(
                '--db-path is required for DuckDB query. To query Dogsled API sources, use `dogsled source-query <sql>` instead.'
              );
              return;
            }
            const rows = await runQuery(dbPath, sql, { format: mode === 'text' });
            if (mode !== 'text') emit({ rows });
            break;
          }
          case 'bigquery': {
            const rows = await runBigQueryQuery(
              sql,
              {
                projectId: options.projectId as string | undefined,
                location: options.location as string | undefined,
                keyFilename: options.keyFilename as string | undefined,
              },
              { format: mode === 'text' }
            );
            if (mode !== 'text') emit({ rows });
            break;
          }
          default: {
            emitError(`unsupported destination "${dest}" for query`);
          }
        }
      } catch (error) {
        emitError(error instanceof Error ? error.message : String(error));
      }
    });
}
