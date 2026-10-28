import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadProjectConfig,
  loadRunnerModule,
  out,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';
import { executeSqlStatements } from '@bobsled-inc/model-spec';

import type { ModelExecutionResult, SupportedDialect } from '@bobsled-inc/model-spec';
import { compileLineage, buildLineageQuerySql } from '../compiler/lineage/codegen.js';
import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../compiler/survivorship/parser.js';
import { generateAuditLogDdl } from '../compiler/audit/codegen.js';
import { buildResolveContext } from './resolve-context.js';
import type { SqlQueryRow } from '@bobsled-inc/model-spec';

interface LineageCompileOptions {
  specDir?: string;
  dryRun?: boolean;
  json?: boolean;
  runner?: string;
  dialect?: string;
  contractSchema?: string;
}

interface LineageQueryOptions {
  entity?: string;
  attribute?: string;
  entityId?: string;
  format?: string;
  json?: boolean;
  runner?: string;
  dialect?: string;
  contractSchema?: string;
}

function normalizeFormat(value: string | undefined): 'json' | 'table' | 'markdown' {
  if (value === undefined || value === 'json') return 'json';
  if (value === 'table' || value === 'markdown') return value;
  throw new CommandError('--format must be json, table, or markdown', 2);
}

function renderTable(rows: SqlQueryRow[]): string {
  if (rows.length === 0) return 'No lineage rows found.\n';
  const keys = Object.keys(rows[0] ?? {}).map((k) => k.toLowerCase());
  const header = keys.join(' | ');
  const divider = keys.map((k) => '-'.repeat(k.length)).join('-|-');
  const dataRows = rows.map((row) =>
    keys.map((k) => String(row[k] ?? row[k.toUpperCase()] ?? '')).join(' | ')
  );
  return [header, divider, ...dataRows].join('\n') + '\n';
}

function renderMarkdownLineage(entityType: string, attribute: string, rows: SqlQueryRow[]): string {
  const lines = [`# Lineage: ${entityType}.${attribute}`, ''];
  if (rows.length === 0) {
    lines.push('No lineage rows found.', '');
  } else {
    lines.push('```json');
    lines.push(
      JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]))
        ),
        null,
        2
      )
    );
    lines.push('```', '');
  }
  return lines.join('\n') + '\n';
}

async function lineageCompileHandler(
  options: LineageCompileOptions,
  globalOptions: { quiet?: boolean }
): Promise<void> {
  const quiet = Boolean(globalOptions.quiet);
  const cwd = process.cwd();

  const resolveCtx = buildResolveContext(globalOptions, options, []);
  const { specs: resolutionSpecs, dialect, targetSchema, entityGraphDir } = resolveCtx;

  const specDir = options.specDir ? path.resolve(cwd, options.specDir) : entityGraphDir;

  if (!fs.existsSync(specDir)) {
    throw new CommandError(`Spec directory not found: ${specDir}`, 2);
  }

  const parsedSurvivorship = discoverSurvivorshipSpecs(specDir);
  if (parsedSurvivorship.length === 0) {
    throw new CommandError('No survivorship specs found — lineage requires survivorship rules.', 2);
  }

  const survivorshipSpecs = parsedSurvivorship.map((p) =>
    resolveSurvivorshipSpec(p, specDir, targetSchema)
  );

  // Pair survivorship specs with their resolution spec
  const resolutionByEntity = new Map(resolutionSpecs.map((s) => [s.entity, s]));
  const resolutionByName = new Map(resolutionSpecs.map((s) => [s.name, s]));

  interface CompileStepJson {
    entity_type: string;
    executed: boolean;
    dry_run: boolean;
    row_count: number;
    complete_count: number;
    incomplete_count: number;
    statement_count: number;
    status: 'ok' | 'failed' | 'skipped';
    warnings: string[];
    statements?: unknown[];
  }

  const steps: CompileStepJson[] = [];
  const allWarnings: string[] = [];
  const auditDdl = generateAuditLogDdl(dialect, options.contractSchema);
  let auditDdlEmitted = false;

  const runner =
    options.runner && !options.dryRun ? await loadRunnerModule(options.runner) : undefined;
  if (runner !== undefined && runner.run == null) {
    throw new CommandError('runner must implement run(sql) for lineage compile.', 2);
  }

  for (const survSpec of survivorshipSpecs) {
    const resSpec =
      resolutionByName.get(survSpec.resolutionRef) ??
      resolutionByEntity.get(survSpec.resolutionEntity) ??
      resolutionByEntity.get(survSpec.entity);

    if (resSpec === undefined) {
      allWarnings.push(
        `Skipping survivorship spec ${survSpec.name}: no matching resolution spec for entity '${survSpec.entity}'`
      );
      steps.push({
        entity_type: survSpec.entity,
        executed: false,
        dry_run: false,
        row_count: 0,
        complete_count: 0,
        incomplete_count: 0,
        statement_count: 0,
        status: 'skipped',
        warnings: [`No matching resolution spec for entity '${survSpec.entity}'`],
      });
      continue;
    }

    const result = compileLineage(resSpec, survSpec, dialect, options.contractSchema);
    const preamble = auditDdlEmitted ? [] : auditDdl;
    auditDdlEmitted = true;
    const allStatements = [...preamble, ...result.statements];
    allWarnings.push(...result.warnings);

    if (options.dryRun || !options.runner || runner === undefined) {
      steps.push({
        entity_type: result.entity_type,
        executed: false,
        dry_run: true,
        row_count: result.rows.length,
        complete_count: result.rows.filter((r) => r.is_complete).length,
        incomplete_count: result.rows.filter((r) => !r.is_complete).length,
        statement_count: allStatements.length,
        status: 'ok',
        warnings: result.warnings,
        statements: allStatements.map((s) => ({ name: s.name, sql: s.sql })),
      });
      continue;
    }

    const executionResults: ModelExecutionResult[] = await executeSqlStatements(
      allStatements.map((s) => ({ modelName: s.name, sql: s.sql })),
      runner.run,
      {
        onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
        onError: (msg) => out.error(msg),
        onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
      }
    );
    const failed = executionResults.filter((r) => r.status === 'failed');

    steps.push({
      entity_type: result.entity_type,
      executed: true,
      dry_run: false,
      row_count: result.rows.length,
      complete_count: result.rows.filter((r) => r.is_complete).length,
      incomplete_count: result.rows.filter((r) => !r.is_complete).length,
      statement_count: allStatements.length,
      status: failed.length > 0 ? 'failed' : 'ok',
      warnings: result.warnings,
    });
  }

  const failedSteps = steps.filter((s) => s.status === 'failed');

  if (options.json) {
    out.json({
      command: 'entity-graph.lineage.compile',
      dialect,
      schema: targetSchema,
      executed: Boolean(options.runner) && !options.dryRun,
      steps,
      warnings: allWarnings,
    });
  } else if (!quiet) {
    for (const step of steps) {
      const prefix = step.dry_run ? '[dry-run] ' : '';
      out.success(
        `${prefix}${step.entity_type}: ${step.row_count} lineage rows (${step.complete_count} complete, ${step.incomplete_count} incomplete)`
      );
    }
    for (const w of allWarnings) {
      out.warn(w);
    }
  }

  if (failedSteps.length > 0) {
    throw new CommandError(`${failedSteps.length} lineage compile step(s) failed.`, 1);
  }
}

async function lineageQueryHandler(
  options: LineageQueryOptions,
  _globalOptions: { quiet?: boolean }
): Promise<void> {
  if (!options.entity || !options.attribute) {
    throw new CommandError(
      'entity-graph lineage requires --entity <name> and --attribute <attr>',
      2
    );
  }

  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const format = options.json ? 'json' : normalizeFormat(options.format);
  const dialect = resolveConfig(
    { dialect: options.dialect as SupportedDialect | undefined },
    config
  ).dialect;

  const query = buildLineageQuerySql({
    entityType: options.entity,
    attribute: options.attribute,
    entityId: options.entityId,
    dialect,
    contractSchema: options.contractSchema,
  });

  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql) for entity-graph lineage.', 2);
  }

  if (runner?.query == null) {
    if (format === 'json') {
      out.json({
        command: 'entity-graph.lineage',
        entity: options.entity,
        attribute: options.attribute,
        entity_id: options.entityId ?? null,
        dialect,
        warnings: [],
        executed: false,
        query,
      });
    } else {
      out.text(`\`\`\`sql\n${query}\n\`\`\`\n`);
    }
    return;
  }

  const rows = await runner.query(query);

  if (format === 'json') {
    out.json({
      command: 'entity-graph.lineage',
      entity: options.entity,
      attribute: options.attribute,
      entity_id: options.entityId ?? null,
      dialect,
      warnings: [],
      executed: true,
      rows,
    });
  } else if (format === 'table') {
    out.text(renderTable(rows));
  } else {
    out.text(renderMarkdownLineage(options.entity, options.attribute, rows));
  }
}

export function registerLineageCommand(program: Command): void {
  const lineage = program
    .command('lineage')
    .description('Column-level lineage: compile provenance and query attribute origins')
    .option('--entity <name>', 'Entity type name to query lineage for')
    .option('--attribute <attr>', 'Profile attribute name to query')
    .option('--entity-id <id>', 'Filter results to a specific entity instance (optional)')
    .option('--format <format>', 'Output format: json | table | markdown', 'json')
    .option('--json', 'Output results as JSON')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema')
    .addOption(createDialectOption())
    .action(async (opts: LineageQueryOptions) => {
      const globalOpts = program.opts<{ quiet?: boolean }>();
      await lineageQueryHandler(opts, globalOpts);
    });

  lineage
    .command('compile')
    .description('Compile and persist column-level lineage for all entity types')
    .option('--spec-dir <path>', 'Path to entity graph spec directory')
    .option('--dry-run', 'Show the execution plan without executing')
    .option('--json', 'Output results as JSON')
    .option('--runner <path>', 'Path to SQL runner module with run(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema')
    .addOption(createDialectOption())
    .action(async (opts: LineageCompileOptions) => {
      const globalOpts = program.opts<{ quiet?: boolean }>();
      await lineageCompileHandler(opts, globalOpts);
    });
}
