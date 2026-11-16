/**
 * `bobsled entity-graph resolve` command group.
 *
 * Exit codes:
 *   0 = success
 *   2 = validation error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Option, type Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  emitResolveReport,
  registerOverviewReportCommand,
  type ReportOptions,
} from './resolve-report.js';
import {
  loadProjectConfig,
  out,
  resolveConfig,
  createIntegrationOption,
  createDialectOption,
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';
import type { SqlQueryRow, SupportedDialect } from '@bobsled-inc/model-spec';
import {
  buildResolveIncrementalEstimateQuery,
  buildResolveEstimateQuery as buildResolveEstimateQueryInternal,
  buildResolveInspectPairQuery,
  buildResolveStatusQuery as buildResolveStatusQueryInternal,
  transformInspectPairResult,
  emitResolutionSql,
  isMissingTableError,
  runResolveStatusQuery,
} from './resolve-support.js';
import { buildResolveContext } from './resolve-context.js';
import {
  inspectClusterHandler,
  type ResolveInspectClusterOptions,
} from './resolve-inspect-cluster.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import {
  clusterResolveProject,
  compileResolveProject,
  describeWorkflowFailure,
  profileResolveProject,
  runResolveProject,
  validateResolveProject,
  type ResolveExecutionEntity,
} from '../api/resolve-project.js';
import { registerResolveReviewCommand } from './resolve-review.js';
import { getFuzzyAlgorithmNotes } from '../compiler/core/dialect-similarity.js';
import { generateGovernanceArtifacts } from '../compiler/identity/codegen-governance.js';
import {
  buildResolveStateSelectQuery,
  normalizeResolveStateRows,
} from '../compiler/identity/codegen-resolve-state.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import {
  resolveEntityGraphRunner,
  type EntityGraphRunnerHandle,
} from '../runtime/runner-resolver.js';
export {
  buildResolveIncrementalEstimateQuery,
  buildResolveEstimateQueryInternal as buildResolveEstimateQuery,
  buildResolveStatusQueryInternal as buildResolveStatusQuery,
};
export { buildResolveContext, type ResolveContext } from './resolve-context.js';

interface ResolveCompileJsonStatement {
  name: string;
  sql: string;
  table_created?: string;
}

interface ResolveCompileJsonEntity {
  entity: string;
  name: string;
  dialect: SupportedDialect;
  schema: string;
  statement_count: number;
  warnings: string[];
  output_dir?: string;
  written_files: string[];
  preamble?: { sql: string };
  statements?: ResolveCompileJsonStatement[];
  governance_artifacts?: Array<{ name: string; format: string; content?: string; path?: string }>;
}

type ResolveExecutionJsonEntity = ResolveExecutionEntity;

interface ValidateOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

function resolveResolveOutputFormat(options: {
  format?: string;
  json?: boolean;
  yaml?: boolean;
}): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'text',
  });
}

function shouldEmitStructured(options: {
  format?: string;
  json?: boolean;
  yaml?: boolean;
}): boolean {
  return resolveResolveOutputFormat(options) !== 'text';
}

/** Validate one or more resolution specs and emit human or JSON output. */
async function validateHandler(
  entityNames: string[],
  localOptions: ValidateOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const result = await validateResolveProject({
    entityNames,
    integration: localOptions.integration,
    dialect: localOptions.dialect,
    schema: localOptions.schema,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet,
  });
  const { dialect, targetSchema, quiet } = result.context;
  for (const warning of result.context.warnings) out.warn(warning);
  const fuzzyAlgorithmNotes = globalOptions.verbose ? getFuzzyAlgorithmNotes(dialect) : [];

  const payload = {
    command: 'resolve.validate',
    dialect,
    schema: targetSchema,
    entities: result.entities,
    ...(globalOptions.verbose ? { fuzzy_algorithm_notes: fuzzyAlgorithmNotes } : {}),
  };
  const format = resolveResolveOutputFormat(localOptions);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
    return;
  }

  for (const entity of result.entities) {
    if (!quiet) {
      out.success(
        `${entity.name} (${entity.input_count} inputs, ${entity.blocking_rule_count} blocking rules)`
      );
    }
  }
  if (globalOptions.verbose && fuzzyAlgorithmNotes.length > 0 && !quiet) {
    for (const note of fuzzyAlgorithmNotes) {
      out.info(`fuzzy: ${note}`);
    }
  }

  out.success(`Validated ${result.entities.length} resolution spec(s).`);
}

interface CompileOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  output?: string;
  governance?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

function initHandler(entity: string, globalOptions: { verbose?: boolean; quiet?: boolean }): void {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const entityGraphDir = path.join(cwd, resolved.entityGraphDir);
  const filePath = resolvePathWithinDir(
    entityGraphDir,
    `${safeEntity}_resolution.yml`,
    'Resolution path'
  );
  fs.mkdirSync(entityGraphDir, { recursive: true });

  if (fs.existsSync(filePath)) {
    throw new CommandError(`Resolution scaffold already exists for ${safeEntity}.`, 2);
  }

  fs.writeFileSync(
    filePath,
    [
      `spec_version: '0.2'`,
      `name: ${safeEntity}_resolution`,
      `type: resolution`,
      `description: Resolve ${safeEntity} records across source systems.`,
      ``,
      `inputs:`,
      `  - ref: source.primary_${safeEntity}`,
      `    role: internal`,
      `    id_fields: [id]`,
      `  - ref: source.secondary_${safeEntity}`,
      `    role: provider`,
      `    id_fields: [id]`,
      ``,
      `standardize:`,
      `  - field: name`,
      `    transforms: [lowercase, collapse_whitespace]`,
      ``,
      `blocking:`,
      `  rules:`,
      `    - name: exact_name`,
      `      key: standardized_name`,
      ``,
      `scoring:`,
      `  method: weighted_features`,
      `  features:`,
      `    - field: standardized_name`,
      `      algorithm: jaro_winkler`,
      `      weight: 1.0`,
      ``,
      `thresholds:`,
      `  auto_merge: 0.95`,
      `  review: 0.6`,
      `  auto_reject: 0.4`,
      ``,
    ].join('\n'),
    'utf-8'
  );

  if (!globalOptions.quiet) {
    out.success(`Created resolution scaffold ${filePath}`);
  }
}

/** Compile one or more resolution specs into SQL or JSON envelopes. */
async function compileHandler(
  entityNames: string[],
  options: CompileOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const compiled = await compileResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet,
  });
  const { dialect, targetSchema } = compiled.context;
  for (const warning of compiled.context.warnings) out.warn(warning);
  const outputDir = options.output ? path.resolve(options.output) : undefined;
  const jsonEntities: ResolveCompileJsonEntity[] = [];

  for (const entity of compiled.entities) {
    const result = entity.result;
    const writtenFiles: string[] = [];
    const governanceArtifacts = options.governance
      ? generateGovernanceArtifacts(entity.spec, dialect, entity.schema)
      : [];
    const writtenGovernanceArtifacts: Array<{
      name: string;
      format: string;
      content?: string;
      path?: string;
    }> = [];

    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });

      if (result.preamble) {
        const preamblePath = resolvePathWithinDir(
          outputDir,
          `${entity.entity}_preamble.sql`,
          'Resolve preamble output path'
        );
        fs.writeFileSync(preamblePath, result.preamble + '\n');
        writtenFiles.push(preamblePath);
      }

      for (const stmt of result.statements) {
        const filePath = resolvePathWithinDir(
          outputDir,
          `${entity.entity}_${stmt.name}.sql`,
          'Resolve statement output path'
        );
        fs.writeFileSync(filePath, stmt.sql + ';\n');
        writtenFiles.push(filePath);
      }
      for (const artifact of governanceArtifacts) {
        const extension = artifact.format === 'sql' ? 'sql' : 'json';
        const filePath = resolvePathWithinDir(
          outputDir,
          `${entity.entity}_${artifact.name}.${extension}`,
          'Resolve governance output path'
        );
        fs.writeFileSync(filePath, `${artifact.content}\n`);
        writtenFiles.push(filePath);
        writtenGovernanceArtifacts.push({
          name: artifact.name,
          format: artifact.format,
          path: filePath,
        });
      }

      if (!shouldEmitStructured(options)) {
        out.success(`Wrote ${result.statements.length} SQL files to ${outputDir}/`);
      }
    } else {
      if (!shouldEmitStructured(options)) {
        emitResolutionSql(result, true);
        for (const artifact of governanceArtifacts) {
          // Generated governance artifacts are pipeable content; emit as raw
          // text (like emitResolutionSql) rather than routing through out.info.
          out.text(`\n-- ${artifact.name}.${artifact.format}\n`);
          out.text(`${artifact.content}\n`);
        }
      }
      writtenGovernanceArtifacts.push(
        ...governanceArtifacts.map((artifact) => ({
          name: artifact.name,
          format: artifact.format,
          content: artifact.content,
        }))
      );
    }

    jsonEntities.push({
      entity: entity.entity,
      name: entity.name,
      dialect,
      schema: entity.schema,
      statement_count: entity.statement_count,
      warnings: entity.warnings,
      output_dir: outputDir,
      written_files: writtenFiles,
      preamble: outputDir || !result.preamble ? undefined : { sql: result.preamble },
      statements: outputDir
        ? undefined
        : result.statements.map((stmt) => ({
            name: stmt.name,
            sql: stmt.sql,
            table_created: stmt.tableCreated,
          })),
      governance_artifacts:
        writtenGovernanceArtifacts.length > 0 ? writtenGovernanceArtifacts : undefined,
    });
  }

  const payload = {
    command: 'resolve.compile',
    dialect,
    schema: targetSchema,
    output_dir: outputDir,
    entities: jsonEntities,
  };
  const format = resolveResolveOutputFormat(options);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
  }
}

interface RunOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  dryRun?: boolean;
  mode?: 'staged' | 'direct';
  format?: string;
  json?: boolean;
  yaml?: boolean;
  withSurvivorship?: boolean;
  withoutSurvivorship?: boolean;
  incremental?: boolean;
}

/** Execute the run phase through threshold routing for each requested entity. */
async function runHandler(
  entityNames: string[],
  options: RunOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const result = await runResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    runner: options.runner,
    dryRun: options.dryRun,
    mode: options.mode,
    withSurvivorship: options.withSurvivorship,
    withoutSurvivorship: options.withoutSurvivorship,
    incremental: options.incremental,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet || shouldEmitStructured(options),
  });
  const { dialect, targetSchema } = result.context;
  for (const warning of result.context.warnings) out.warn(warning);
  const jsonEntities: ResolveExecutionJsonEntity[] = result.entities;

  for (const entity of result.entities) {
    const entityFailed = result.failure?.entity === entity.entity;
    if (entity.dry_run) {
      if (!shouldEmitStructured(options)) {
        out.info(
          `[dry-run] Would execute ${entity.statements.length} statements for ${entity.entity}`
        );
        for (const stmt of entity.statements) {
          out.info(`  ${stmt.name}: ${stmt.table_created ?? 'DDL'}`);
        }
        emitResolutionSql(
          {
            statements: entity.statements.map((stmt) => ({
              name: stmt.name,
              sql: stmt.sql,
              tableCreated: stmt.table_created,
            })),
            preamble: entity.preamble?.sql,
          },
          false
        );
      }
    } else {
      if (!shouldEmitStructured(options) && !entityFailed) {
        out.success(`Executed ${entity.entity}: ${entity.statement_count} statement(s)`);
        for (const warning of entity.warnings) {
          out.warn(warning);
        }
      }
    }

    if (!shouldEmitStructured(options)) {
      if (entity.dry_run) {
        for (const w of entity.warnings) {
          out.warn(w);
        }
      }
    }
  }

  const payload = {
    command: 'resolve.run',
    mode: options.mode ?? 'staged',
    dialect,
    schema: targetSchema,
    entities: jsonEntities,
  };
  const format = resolveResolveOutputFormat(options);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
  }

  if (result.failure) {
    throw new CommandError(describeWorkflowFailure(result.failure), 1);
  }
}

interface ClusterOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

/** Execute the cluster and crosswalk stages for each requested entity. */
async function clusterHandler(
  entityNames: string[],
  options: ClusterOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const result = await clusterResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    runner: options.runner,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet || shouldEmitStructured(options),
  });
  const { dialect, targetSchema } = result.context;
  for (const warning of result.context.warnings) out.warn(warning);
  const jsonEntities: ResolveExecutionJsonEntity[] = result.entities;

  for (const entity of result.entities) {
    const entityFailed = result.failure?.entity === entity.entity;
    if (entity.dry_run) {
      if (!shouldEmitStructured(options)) {
        out.info(
          `[dry-run] Would execute ${entity.statements.length} statements for ${entity.entity}`
        );
        emitResolutionSql(
          {
            statements: entity.statements.map((stmt) => ({
              name: stmt.name,
              sql: stmt.sql,
              tableCreated: stmt.table_created,
            })),
          },
          false
        );
      }
    } else {
      if (!shouldEmitStructured(options) && !entityFailed) {
        out.success(
          `Executed cluster for ${entity.entity}: ${entity.statement_count} statement(s)`
        );
      }
    }

    if (!shouldEmitStructured(options)) {
      for (const w of entity.warnings) {
        out.warn(w);
      }
    }
  }

  const payload = {
    command: 'resolve.cluster',
    dialect,
    schema: targetSchema,
    entities: jsonEntities,
  };
  const format = resolveResolveOutputFormat(options);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
  }

  if (result.failure) {
    throw new CommandError(describeWorkflowFailure(result.failure), 1);
  }
}

interface ProfileOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

/** Execute the entity profile, trust, and activation stages for each requested entity. */
async function profileHandler(
  entityNames: string[],
  options: ProfileOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const result = await profileResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    runner: options.runner,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet || shouldEmitStructured(options),
  });
  const { dialect, targetSchema } = result.context;
  for (const warning of result.context.warnings) out.warn(warning);
  const jsonEntities: ResolveExecutionJsonEntity[] = result.entities;

  for (const entity of result.entities) {
    const entityFailed = result.failure?.entity === entity.entity;
    if (entity.dry_run) {
      if (!shouldEmitStructured(options)) {
        out.info(
          `[dry-run] Would execute ${entity.statements.length} statements for ${entity.entity}`
        );
        emitResolutionSql(
          {
            statements: entity.statements.map((stmt) => ({
              name: stmt.name,
              sql: stmt.sql,
              tableCreated: stmt.table_created,
            })),
          },
          false
        );
      }
      continue;
    }

    if (!shouldEmitStructured(options) && !entityFailed) {
      out.success(`Executed profile for ${entity.entity}: ${entity.statement_count} statement(s)`);
      for (const warning of entity.warnings) {
        out.warn(warning);
      }
    }
  }

  const payload = {
    command: 'resolve.profile',
    dialect,
    schema: targetSchema,
    entities: jsonEntities,
  };
  const format = resolveResolveOutputFormat(options);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
  }

  if (result.failure) {
    throw new CommandError(describeWorkflowFailure(result.failure), 1);
  }
}

/** Print a compact spec report for each requested resolution entity. */
function reportHandler(
  entityNames: string[],
  options: ReportOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const { specs } = buildResolveContext(globalOptions, options, entityNames);
  emitResolveReport(specs, options);
}

interface ResolveQueryOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  secrets?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  includeSemanticTriage?: boolean;
  incremental?: boolean;
}

async function resolveQueryRunner(
  entityNames: string[],
  options: ResolveQueryOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<{
  specs: Awaited<ReturnType<typeof loadEntityGraphProjectContext>>['specs'];
  dialect: SupportedDialect;
  targetSchema: string;
  runnerHandle?: EntityGraphRunnerHandle;
}> {
  const context = await loadEntityGraphProjectContext({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet,
  });
  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
  });
  if (runnerHandle && runnerHandle.runner.query == null) {
    await runnerHandle.close();
    throw new CommandError('Runner module does not implement query(sql).', 2);
  }
  return {
    specs: context.specs,
    dialect: context.dialect,
    targetSchema: context.targetSchema,
    ...(runnerHandle ? { runnerHandle } : {}),
  };
}

async function statusHandler(
  entityNames: string[],
  options: ResolveQueryOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect, targetSchema, runnerHandle } = await resolveQueryRunner(
    entityNames,
    options,
    globalOptions
  );
  const runner = runnerHandle?.runner;
  const entities: Array<{
    entity: string;
    schema: string;
    executed: boolean;
    query: string;
    rows?: unknown[];
    resolve_state_query?: string;
    resolve_state?: unknown[];
  }> = [];

  try {
    for (const spec of specs) {
      const schema = spec.targetSchema ?? targetSchema;
      const query = buildResolveStatusQueryInternal(spec.entity, schema, dialect);
      const resolveStateQuery = buildResolveStateSelectQuery(spec.entity, schema, dialect);
      if (runner?.query == null) {
        entities.push({
          entity: spec.entity,
          schema,
          executed: false,
          query,
          resolve_state_query: resolveStateQuery,
        });
        continue;
      }
      const rows = await runResolveStatusQuery(spec.entity, schema, dialect, runner.query);
      let resolveState: unknown[] = [];
      try {
        resolveState = normalizeResolveStateRows(await runner.query(resolveStateQuery));
      } catch (error) {
        if (!isMissingTableError(error)) {
          throw error;
        }
      }
      entities.push({
        entity: spec.entity,
        schema,
        executed: true,
        query,
        rows,
        resolve_state: resolveState,
      });
    }
  } finally {
    await runnerHandle?.close();
  }

  const statusResult = { command: 'resolve.status', dialect, entities };
  const format = resolveResolveOutputFormat(options);
  if (format === 'json') {
    out.json(statusResult);
    return;
  }
  if (format === 'yaml') {
    out.yaml(statusResult);
    return;
  }

  for (const entity of entities) {
    out.text(`${entity.query}\n`);
    if (entity.resolve_state_query) {
      out.text(`${entity.resolve_state_query}\n`);
    }
  }
}

async function estimateHandler(
  entityNames: string[],
  options: ResolveQueryOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect, targetSchema, runnerHandle } = await resolveQueryRunner(
    entityNames,
    options,
    globalOptions
  );
  const runner = runnerHandle?.runner;
  const entities: Array<{
    entity: string;
    schema: string;
    executed: boolean;
    query: string;
    rows?: unknown[];
  }> = [];

  try {
    for (const spec of specs) {
      const schema = spec.targetSchema ?? targetSchema;
      const query = options.incremental
        ? buildResolveIncrementalEstimateQuery(spec, schema, dialect)
        : buildResolveEstimateQueryInternal(spec, schema, dialect, {
            includeSemanticTriage: options.includeSemanticTriage,
          });
      if (runner?.query == null) {
        entities.push({ entity: spec.entity, schema, executed: false, query });
        continue;
      }
      try {
        const rows = await runner.query(query);
        entities.push({ entity: spec.entity, schema, executed: true, query, rows });
      } catch (error) {
        if (
          options.incremental ||
          !options.includeSemanticTriage ||
          !spec.semanticTriage ||
          !isMissingTableError(error)
        ) {
          throw error;
        }
        const fallbackQuery = buildResolveEstimateQueryInternal(spec, schema, dialect, {
          includeSemanticTriage: true,
          useSemanticCache: false,
        });
        const rows = await runner.query(fallbackQuery);
        entities.push({
          entity: spec.entity,
          schema,
          executed: true,
          query: fallbackQuery,
          rows,
        });
      }
    }
  } finally {
    await runnerHandle?.close();
  }

  const estimateResult = { command: 'resolve.estimate', dialect, entities };
  const format = resolveResolveOutputFormat(options);
  if (format === 'json') {
    out.json(estimateResult);
    return;
  }
  if (format === 'yaml') {
    out.yaml(estimateResult);
    return;
  }

  for (const entity of entities) {
    out.text(`${entity.query}\n`);
  }
}

interface ResolveInspectPairOptions extends ResolveQueryOptions {
  entity: string;
  pairId: string;
}

async function inspectPairHandler(
  options: ResolveInspectPairOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect, targetSchema, runnerHandle } = await resolveQueryRunner(
    [options.entity],
    options,
    globalOptions
  );
  const spec = specs[0];
  if (!spec) {
    await runnerHandle?.close();
    throw new CommandError(`No resolution specs found matching: ${options.entity}`);
  }

  const schema = spec.targetSchema ?? targetSchema;
  const query = buildResolveInspectPairQuery(spec.entity, schema, options.pairId, dialect);
  const runner = runnerHandle?.runner;
  const format = resolveResolveOutputFormat(options);

  if (runner?.query == null) {
    const payload = {
      command: 'resolve.inspect.pair',
      entity: spec.entity,
      pair_id: options.pairId,
      dialect,
      schema,
      executed: false,
      query,
    };
    if (format === 'json') {
      out.json(payload);
      return;
    }
    if (format === 'yaml') {
      out.yaml(payload);
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  let rows: SqlQueryRow[];
  try {
    rows = await runner.query(query);
  } finally {
    await runnerHandle?.close();
  }
  const transformed = transformInspectPairResult(rows);
  if (transformed == null) {
    if (format === 'json' || format === 'yaml') {
      const payload = {
        command: 'resolve.inspect.pair',
        entity: spec.entity,
        pair_id: options.pairId,
        dialect,
        schema,
        executed: true,
        found: false,
      };
      if (format === 'json') {
        out.json(payload);
      } else {
        out.yaml(payload);
      }
      return;
    }
    throw new CommandError(`Pair ${options.pairId} was not found for ${spec.entity}.`, 2);
  }
  const result = {
    command: 'resolve.inspect.pair',
    entity: spec.entity,
    dialect,
    schema,
    executed: true,
    ...transformed,
  };
  if (format === 'json') {
    out.json(result);
  } else if (format === 'yaml') {
    out.yaml(result);
  } else {
    out.yaml(result);
  }
}

/** Register the full resolve command tree with Commander. */
export function registerResolveCommand(program: Command): void {
  const resolve = program.command('resolve').description('Entity resolution pipeline commands');

  resolve
    .command('init')
    .description('Scaffold a new resolution spec')
    .argument('<entity>', 'Entity name')
    .action((entity: string) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initHandler(entity, globalOptions);
    });

  resolve
    .command('validate')
    .description('Validate resolution specs for correctness')
    .argument('[entity...]', 'Entity names to validate (default: all)')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ValidateOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await validateHandler(entityNames, opts, globalOptions);
    });

  resolve
    .command('compile')
    .description('Generate resolution SQL to stdout or files')
    .argument('[entity...]', 'Entity names to compile (default: all)')
    .option('-o, --output <dir>', 'Write SQL files to directory')
    .option('--governance', 'Emit governance artifacts for masked golden views')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: CompileOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await compileHandler(entityNames, opts, globalOptions);
    });

  resolve
    .command('run')
    .description('Run resolution pipeline through threshold routing')
    .argument('[entity...]', 'Entity names to run (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--dry-run', 'Show the execution plan without executing')
    .option('--incremental', 'Process only rows newer than the warehouse resolve_state baseline')
    .addOption(new Option('--mode <mode>', 'Run mode').choices(['staged', 'direct']))
    .option('--with-survivorship', 'Require and run colocated survivorship after profile')
    .option('--without-survivorship', 'Skip colocated survivorship even when present')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: RunOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await runHandler(entityNames, opts, globalOptions);
    });

  resolve
    .command('cluster')
    .description('Run clustering on reviewed pairs')
    .argument('[entity...]', 'Entity names to cluster (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ClusterOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await clusterHandler(entityNames, opts, globalOptions);
    });

  registerResolveReviewCommand(resolve, program);

  resolve
    .command('profile')
    .description('Build entity profiles, trust scores, and activation projections')
    .argument('[entity...]', 'Entity names to profile (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ProfileOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await profileHandler(entityNames, opts, globalOptions);
    });

  const report = resolve
    .command('report')
    .description('Resolution reports')
    .argument('[entity...]', 'Entity names to report on (default: all)')
    .option('--json', 'Output as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((entityNames: string[], opts: ReportOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      reportHandler(entityNames, opts, globalOptions);
    });

  registerOverviewReportCommand(report, program, buildResolveContext);

  resolve
    .command('status')
    .description('Show row counts for Entity Graph runtime tables')
    .argument('[entity...]', 'Entity names to inspect (default: all)')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--secrets <path>', 'Path to secrets file for integration-backed queries')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output as JSON')
    .option('--yaml', 'Output as YAML')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ResolveQueryOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await statusHandler(entityNames, opts, globalOptions);
    });

  resolve
    .command('estimate')
    .description('Estimate pair volumes across threshold bands')
    .argument('[entity...]', 'Entity names to inspect (default: all)')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--secrets <path>', 'Path to secrets file for integration-backed queries')
    .option('--include-semantic-triage', 'Include semantic triage embedding cost estimates')
    .option('--incremental', 'Estimate delta rows/pairs from resolve_state watermarks')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output as JSON')
    .option('--yaml', 'Output as YAML')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ResolveQueryOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await estimateHandler(entityNames, opts, globalOptions);
    });

  const inspect = resolve.command('inspect').description('Inspect pairs and clusters');

  inspect
    .command('pair')
    .description('Inspect a single pair')
    .requiredOption('--entity <name>', 'Entity name to inspect')
    .requiredOption('--pair-id <value>', 'Pair ID to inspect')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--secrets <path>', 'Path to secrets file for integration-backed queries')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output as JSON')
    .option('--yaml', 'Output as YAML')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (opts: ResolveInspectPairOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await inspectPairHandler(opts, globalOptions);
    });

  inspect
    .command('cluster')
    .description('Inspect a single cluster')
    .requiredOption('--entity <name>', 'Entity name to inspect')
    .option('--entity-id <value>', 'Stable entity ID to inspect')
    .option('--cluster-id <value>', 'Cluster ID to inspect (alias for --entity-id)')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--json', 'Output as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ResolveInspectClusterOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await inspectClusterHandler(opts, globalOptions);
    });
}
