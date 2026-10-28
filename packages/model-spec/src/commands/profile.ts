import { getModelOutputColumns } from '../agentic/model.js';
import { interpolateSecrets, resolveRunner } from '@bobsled-inc/connections';

import type { Command } from 'commander';

import { loadProject, selectIntegrationContexts } from '../api/load-project.js';
import { CommandError } from '../errors.js';
import {
  buildSecretResolver,
  pickIntegrationsByHandle,
  type ResolvedIntegration,
} from '../integrations.js';
import * as out from '../output.js';
import { profileTable } from '../profiler/profile.js';
import { buildSampleSql } from '../profiler/sql.js';
import { getSourceEntry } from '../compiler/parser.js';

import {
  createIntegrationOption,
  loadRunnerModule,
  parseConfidenceOption,
  parseGlobalFlags,
  parsePositiveIntOption,
} from './common.js';

import type { SqlRunnerModule } from '../compiler/index.js';
import type { LoadedProject } from '../api/load-project.js';
import type { IntegrationCompileContext } from '../api/integration-context.js';
import type {
  ForeignKeyTarget,
  ProfileColumnInput,
  ProfileReport,
  ProfileSampleRow,
} from '../profiler/types.js';

type QueryProfileRunner = SqlRunnerModule & {
  query: NonNullable<SqlRunnerModule['query']>;
  close?: () => Promise<void> | void;
};

interface ProfileOptions {
  integration?: string;
  runner?: string;
  secrets?: string;
  sampleSize?: number;
  confidenceMin?: number;
  json?: boolean;
}

interface ResolvedProfileTarget {
  table: string;
  columns?: ProfileColumnInput[];
  modelName?: string;
}

interface ForeignKeyTargetSpec {
  table: string;
  physicalTable: string;
  column: string;
}

async function profileHandler(
  table: string | undefined,
  options: ProfileOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean; json?: boolean },
  outputMode: 'profile' | 'cleaning'
): Promise<void> {
  if (!table) {
    throw new CommandError('Missing required table argument.', 2);
  }

  const flags = parseGlobalFlags({ ...globalOptions, json: options.json ?? globalOptions.json });
  const project = await loadProject(process.cwd(), { skipEntities: true });
  const integration = pickActiveIntegration(project, options.integration);
  const integrationContext = selectProfileIntegrationContext(project, integration);
  const target = resolveProfileTarget(project, table, integrationContext);
  const runner = await resolveProfileRunner(project, integration, options);

  try {
    const sampleSize = options.sampleSize ?? 500;
    const foreignKeyTargets = await resolveForeignKeyTargets(
      runner.query,
      integrationContext,
      target,
      sampleSize
    );
    const report = await profileTable(runner.query, {
      table: target.table,
      dialect: integration.dialect,
      sampleSize,
      confidenceMin: options.confidenceMin,
      columns: target.columns,
      foreignKeyTargets,
    });

    if (!flags.quiet && !flags.json) {
      out.info(
        `Profiled ${target.table} (${report.rowCount} row(s), ${report.sampleSize} sampled).`
      );
    }

    if (outputMode === 'cleaning') {
      emitCleaning(report, flags.json);
    } else {
      emitProfile(report, flags.json);
    }
  } finally {
    if (typeof runner.close === 'function') {
      await runner.close();
    }
  }
}

export function registerProfileCommand(program: Command): void {
  program
    .command('profile')
    .description('Profile a warehouse table and emit confidence-scored inferences')
    .argument('[args...]', 'Either <table> or suggest cleaning <table>')
    .addOption(createIntegrationOption())
    .option('--runner <path>', 'Optional query-capable SQL runner module')
    .option(
      '--secrets <path>',
      'Optional YAML file overlaying env-var values on top of process.env'
    )
    .option('--sample-size <rows>', 'Rows to sample for inference', parsePositiveIntOption, 500)
    .option(
      '--confidence-min <number>',
      'Only include inferences at or above this confidence',
      parseConfidenceOption
    )
    .option('--json', 'Output a single JSONL-compatible profile payload')
    .action(async (args: string[], opts: ProfileOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean; json?: boolean }>();
      const parsed = parseProfileArgs(args);
      await profileHandler(parsed.table, opts, globalOptions, parsed.outputMode);
    });
}

function parseProfileArgs(args: string[]): { table: string; outputMode: 'profile' | 'cleaning' } {
  if (args.length === 1 && args[0]) {
    return { table: args[0], outputMode: 'profile' };
  }
  if (args.length === 3 && args[0] === 'suggest' && args[1] === 'cleaning' && args[2]) {
    return { table: args[2], outputMode: 'cleaning' };
  }
  throw new CommandError(
    'Usage: model profile <table> OR model profile suggest cleaning <table>',
    2
  );
}

function pickActiveIntegration(
  project: LoadedProject,
  requestedHandle: string | undefined
): ResolvedIntegration {
  if (requestedHandle !== undefined) {
    const picked = pickIntegrationsByHandle(project.integrations, requestedHandle);
    const first = picked[0];
    if (!first) {
      throw new CommandError(`No integration found for handle "${requestedHandle}".`, 2);
    }
    return first;
  }
  if (project.integrations.size === 0) {
    throw new CommandError(`No integrations found in ${project.config.integrationsDir}/.`, 2);
  }
  if (project.integrations.size === 1) {
    const first = [...project.integrations.values()][0];
    if (!first) {
      throw new CommandError('No integrations found.', 2);
    }
    return first;
  }
  const handles = [...project.integrations.keys()].sort();
  throw new CommandError(
    `Multiple integrations found in ${project.config.integrationsDir}/: ${handles.join(', ')}. ` +
      `Pass --integration <handle> to pick one.`,
    2
  );
}

function selectProfileIntegrationContext(
  project: LoadedProject,
  integration: ResolvedIntegration
): IntegrationCompileContext {
  const [context] = selectIntegrationContexts(project, { integration: integration.handle });
  if (!context) {
    throw new CommandError(`No integration context found for "${integration.handle}".`, 2);
  }
  return context;
}

async function resolveProfileRunner(
  project: LoadedProject,
  integration: ResolvedIntegration,
  options: ProfileOptions
): Promise<QueryProfileRunner> {
  const runner =
    options.runner !== undefined
      ? await loadRunnerModule(options.runner)
      : await resolveIntegrationRunner(project, integration, options.secrets);

  if (typeof runner.query !== 'function') {
    throw new CommandError('Profiler requires a runner module with query(sql).', 1);
  }
  return runner as QueryProfileRunner;
}

async function resolveIntegrationRunner(
  project: LoadedProject,
  integration: ResolvedIntegration,
  secretsPath: string | undefined
): Promise<SqlRunnerModule> {
  const secretResolver = await buildSecretResolver(project.cwd, secretsPath);
  const interpolated = await interpolateSecrets(integration.integration, secretResolver);
  return resolveRunner(interpolated, { secretResolver });
}

function resolveProfileTarget(
  project: LoadedProject,
  table: string,
  integrationContext: IntegrationCompileContext
): ResolvedProfileTarget {
  const direct = getSourceEntry(project.sourceEntries, table);
  if (direct?.kind === 'warehouse_table') {
    return {
      table: direct.fqRef,
      columns: direct.columns.map((column) => ({
        name: column.name,
        dataType: column.type.toUpperCase(),
      })),
    };
  }

  const modelName = table.toLowerCase();
  const model = integrationContext.orderedNodes.find((node) => node.name === modelName);
  const modelTable = integrationContext.modelReg.get(modelName);
  if (model && modelTable) {
    return {
      table: modelTable,
      modelName,
      columns: getModelOutputColumns(model.parsedSpec).map((column) => ({
        name: column.name,
        dataType: column.type?.toUpperCase(),
      })),
    };
  }

  const matches = [...project.sourceEntries.entries()].filter(([key, entry]) => {
    if (entry.kind !== 'warehouse_table') return false;
    const bareName = key.slice(key.indexOf('.') + 1);
    const tableLeaf = entry.fqRef.split('.').at(-1);
    return bareName === table || tableLeaf?.toLowerCase() === table.toLowerCase();
  });

  if (matches.length > 1) {
    throw new CommandError(
      `Table "${table}" matches multiple sources: ${matches.map(([key]) => key).join(', ')}. ` +
        'Use the fully-qualified source ref.',
      2
    );
  }

  const match = matches[0];
  if (match) {
    const [, entry] = match;
    if (entry.kind === 'warehouse_table') {
      return {
        table: entry.fqRef,
        columns: entry.columns.map((column) => ({
          name: column.name,
          dataType: column.type.toUpperCase(),
        })),
      };
    }
  }

  const parts = table
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    throw new CommandError(`Invalid table reference "${table}".`, 2);
  }
  for (const part of parts) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part)) {
      throw new CommandError(`Invalid table identifier "${part}".`, 2);
    }
  }
  return { table };
}

async function resolveForeignKeyTargets(
  query: QueryProfileRunner['query'],
  integrationContext: IntegrationCompileContext,
  target: ResolvedProfileTarget,
  sampleSize: number
): Promise<ForeignKeyTarget[]> {
  const specs = resolveForeignKeyTargetSpecs(integrationContext, target);
  const targets: ForeignKeyTarget[] = [];
  for (const spec of specs) {
    const rows = await query(
      buildSampleSql(spec.physicalTable, integrationContext.dialect, sampleSize)
    );
    const values = rows.map((row) => readColumnValue(row, spec.column));
    const usableValues = values.filter(
      (value) => value !== null && value !== undefined && value !== ''
    );
    const distinctValues = new Set(usableValues.map((value) => String(value)));
    targets.push({
      table: spec.table,
      column: spec.column,
      values,
      uniqueness: usableValues.length === 0 ? 0 : distinctValues.size / usableValues.length,
    });
  }
  return targets;
}

function resolveForeignKeyTargetSpecs(
  integrationContext: IntegrationCompileContext,
  target: ResolvedProfileTarget
): ForeignKeyTargetSpec[] {
  if (!target.modelName) return [];
  const model = integrationContext.orderedNodes.find((node) => node.name === target.modelName);
  if (!model || model.parsedSpec.model_kind === 'agentic') return [];

  const specs = new Map<string, ForeignKeyTargetSpec>();
  for (const column of model.parsedSpec.columns) {
    if (!column.references) continue;
    const reference = parseColumnReference(column.references);
    if (!reference) continue;
    const targetModel = integrationContext.orderedNodes.find(
      (node) => node.name === reference.modelName
    );
    const physicalTable = integrationContext.modelReg.get(reference.modelName);
    if (!targetModel || !physicalTable) continue;
    const targetColumn = resolveModelColumnName(targetModel, reference.columnName);
    if (!targetColumn) continue;
    const key = `${reference.modelName}:${targetColumn}`;
    specs.set(key, {
      table: reference.modelName,
      physicalTable,
      column: targetColumn,
    });
  }
  return [...specs.values()];
}

function parseColumnReference(reference: string): { modelName: string; columnName: string } | null {
  const parts = reference
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const columnName = parts.at(-1);
  const modelName = parts.at(-2);
  if (!modelName || !columnName) return null;
  return { modelName: modelName.toLowerCase(), columnName };
}

function resolveModelColumnName(
  model: IntegrationCompileContext['orderedNodes'][number],
  columnName: string
): string | undefined {
  return getModelOutputColumns(model.parsedSpec).find(
    (column) => column.name.toLowerCase() === columnName.toLowerCase()
  )?.name;
}

function readColumnValue(row: ProfileSampleRow, columnName: string): unknown {
  if (Object.hasOwn(row, columnName)) {
    return row[columnName];
  }
  const matchedColumn = Object.keys(row).find(
    (key) => key.toLowerCase() === columnName.toLowerCase()
  );
  return matchedColumn ? row[matchedColumn] : undefined;
}

function emitProfile(report: ProfileReport, json: boolean): void {
  if (json) {
    out.jsonLine({ command: 'model.profile', ok: true, report });
  } else {
    out.yaml(report);
  }
}

function emitCleaning(report: ProfileReport, json: boolean): void {
  const suggestions = report.cleaningSuggestions;
  if (json) {
    out.jsonLine({
      command: 'model.profile.suggest.cleaning',
      ok: true,
      table: report.table,
      suggestions,
    });
  } else {
    out.yaml({ table: report.table, suggestions });
  }
}
