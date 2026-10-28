import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadProjectConfig,
  loadRunnerModule,
  out,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';
import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SqlQueryRow,
} from '@bobsled-inc/model-spec';

import { AUDIT_LOG_TABLE, ENTITY_GRAPH_SCHEMA } from '../compiler/audit/codegen.js';
import { outputTableName } from '../compiler/output-tables/index.js';

import type { SupportedDialect } from '@bobsled-inc/model-spec';

interface StatusOptions {
  runner?: string;
  dialect?: SupportedDialect;
  contractSchema?: string;
  entity?: string;
  json?: boolean;
}

const CONTRACT_TABLES = [
  'entity_profiles',
  'entity_quality_current',
  'crosswalks',
  'clusters',
  'entity_schema_catalog',
  AUDIT_LOG_TABLE,
] as const;

function buildSurfaceCountQuery(
  surface: string,
  dialect: SupportedDialect,
  contractSchema: string
): string {
  return [
    `SELECT`,
    `  ${quoteLiteral(surface, dialect)} AS ${quoteIdentifier('surface', dialect)},`,
    `  COUNT(*) AS ${quoteIdentifier('row_count', dialect)}`,
    `FROM ${buildFqName(contractSchema, surface, dialect)}`,
  ].join('\n');
}

function contractTables(entity?: string): readonly string[] {
  return entity
    ? [...CONTRACT_TABLES, outputTableName(entity, '__forgotten_records')]
    : CONTRACT_TABLES;
}

function buildEntityGraphStatusQuery(
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA,
  entity?: string
): string {
  return contractTables(entity)
    .map((table) => buildSurfaceCountQuery(table, dialect, contractSchema))
    .join('\nUNION ALL\n');
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|not found|unknown table|no such table|object .* does not exist|table or view .* not found/i.test(
    message
  );
}

function readRowCount(rows: SqlQueryRow[]): number {
  const firstRow = rows[0];
  if (!firstRow) return 0;
  const lowerCaseEntries = new Map(
    Object.entries(firstRow).map(([key, value]) => [key.toLowerCase(), value])
  );
  const rowCount = Number(lowerCaseEntries.get('row_count'));
  return Number.isFinite(rowCount) ? rowCount : 0;
}

async function runEntityGraphStatusQuery(
  dialect: SupportedDialect,
  contractSchema: string,
  entity: string | undefined,
  query: SqlQueryRow[] | ((sql: string) => Promise<SqlQueryRow[]>)
): Promise<SqlQueryRow[]> {
  if (typeof query !== 'function') return query;
  try {
    return await query(buildEntityGraphStatusQuery(dialect, contractSchema, entity));
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  const rows: SqlQueryRow[] = [];
  for (const surface of contractTables(entity)) {
    try {
      const surfaceRows = await query(buildSurfaceCountQuery(surface, dialect, contractSchema));
      rows.push({ surface, row_count: readRowCount(surfaceRows) });
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      rows.push({ surface, row_count: 0 });
    }
  }
  return rows;
}

function rethrowAsCommandError(error: unknown, prefix: string, exitCode: 1 | 2 = 1): never {
  if (error instanceof CommandError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new CommandError(`${prefix}: ${message}`, exitCode);
}

async function statusHandler(options: StatusOptions): Promise<void> {
  const { config } = loadProjectConfig(process.cwd());
  const dialect = resolveConfig({ dialect: options.dialect }, config).dialect;
  const contractSchema = options.contractSchema ?? ENTITY_GRAPH_SCHEMA;
  const query = buildEntityGraphStatusQuery(dialect, contractSchema, options.entity);
  let runner: Awaited<ReturnType<typeof loadRunnerModule>> | undefined;
  try {
    runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  } catch (error) {
    rethrowAsCommandError(error, `failed to load runner ${options.runner ?? ''}`.trimEnd(), 2);
  }
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'entity-graph.status',
        dialect,
        contract_schema: contractSchema,
        entity: options.entity ?? null,
        executed: false,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  let rows: SqlQueryRow[];
  try {
    rows = await runEntityGraphStatusQuery(dialect, contractSchema, options.entity, runner.query);
  } catch (error) {
    rethrowAsCommandError(error, 'entity-graph status query failed', 1);
  }
  const result = {
    command: 'entity-graph.status',
    dialect,
    contract_schema: contractSchema,
    entity: options.entity ?? null,
    executed: true,
    rows,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show row counts for entity_graph contract surfaces')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema', ENTITY_GRAPH_SCHEMA)
    .option(
      '--entity <name>',
      'Include entity-scoped contract surfaces such as __forgotten_records'
    )
    .option('--json', 'Output results as JSON')
    .addOption(createDialectOption())
    .action(async (opts: StatusOptions) => {
      await statusHandler(opts);
    });
}
