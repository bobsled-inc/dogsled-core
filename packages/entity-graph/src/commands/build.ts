import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  compileResolutionCluster,
  compileResolutionProfile,
  compileResolutionRun,
} from '../compiler/identity/codegen.js';
import { compileEntityGraphFoundation } from '../compiler/entity-graph/codegen.js';
import { generateAuditLogDdl, generateSurvivorshipAuditSql } from '../compiler/audit/codegen.js';
import { compileSurvivorship } from '../compiler/survivorship/codegen.js';
import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../compiler/survivorship/parser.js';
import { compileEntityRelationship } from '../compiler/relationship/codegen.js';
import {
  discoverEntityRelationshipSpecs,
  resolveEntityRelationshipSpec,
} from '../compiler/relationship/parser.js';
import type { ResolvedEntityRelationshipSpec } from '../compiler/relationship/types.js';
import { discoverObjectSpecs, resolveObjectSpec } from '../compiler/object/parser.js';
import type { ResolvedObjectSpec } from '../compiler/object/types.js';
import { buildResolveContext } from './resolve-context.js';
import { toResolvePreambleJson, toResolveStatementJson } from './resolve-execution.js';
import { planResolveRunMode } from '../api/resolve-project.js';
import { executeEntityGraphPlan } from '../runtime/execution.js';
import {
  createDialectOption,
  loadRunnerModule,
  out,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';
import { executeSqlStatements } from '@bobsled-inc/model-spec';

import type {
  ModelExecutionResult,
  SqlRunnerModule,
  SupportedDialect,
} from '@bobsled-inc/model-spec';
import type { ProjectConfig } from '@bobsled-inc/model-spec/project';
import type {
  ResolvedResolutionSpec,
  ResolutionCompileResult,
} from '../compiler/identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../compiler/survivorship/types.js';

interface BuildOptions {
  dialect?: string;
  schema?: string;
  runner?: string;
  dryRun?: boolean;
  incremental?: boolean;
  json?: boolean;
}

interface BuildStepJson {
  name: string;
  entity: string;
  executed: boolean;
  dry_run: boolean;
  statement_count: number;
  status: 'ok' | 'failed' | 'skipped';
  warnings: string[];
  preamble?: unknown;
  statements?: unknown[];
}

function discoverBuildSurvivorshipSpecs(
  config: ProjectConfig | null,
  requestedSpecs: ResolvedResolutionSpec[],
  dialect: SupportedDialect,
  schema: string
): ResolvedSurvivorshipSpec[] {
  const cwd = process.cwd();
  const resolved = resolveConfig({ dialect, schema }, config);
  const specDir = path.join(cwd, resolved.entityGraphDir);
  if (!fs.existsSync(specDir)) {
    return [];
  }

  const requested = new Set(requestedSpecs.flatMap((spec) => [spec.name, spec.entity]));
  return discoverSurvivorshipSpecs(specDir)
    .map((spec) => resolveSurvivorshipSpec(spec, specDir, schema))
    .filter(
      (spec) =>
        requested.has(spec.name) ||
        requested.has(spec.entity) ||
        requested.has(spec.resolutionEntity) ||
        requested.has(spec.resolutionRef)
    );
}

function discoverBuildRelationshipSpecs(
  config: ProjectConfig | null,
  schema: string
): {
  specs: ResolvedEntityRelationshipSpec[];
  filePaths: Map<string, string>;
} {
  const cwd = process.cwd();
  const resolved = resolveConfig({}, config);
  const specDir = path.join(cwd, resolved.entityGraphDir);
  if (!fs.existsSync(specDir)) {
    return { specs: [], filePaths: new Map() };
  }
  const parsed = discoverEntityRelationshipSpecs(specDir);
  return {
    specs: parsed.map((spec) => resolveEntityRelationshipSpec(spec, schema)),
    filePaths: new Map(parsed.map((spec) => [spec.name, spec.filePath])),
  };
}

function discoverBuildObjectSpecs(
  config: ProjectConfig | null,
  relationshipSpecs: readonly ResolvedEntityRelationshipSpec[],
  relationshipFilePaths: ReadonlyMap<string, string>
): ResolvedObjectSpec[] {
  const cwd = process.cwd();
  const resolved = resolveConfig({}, config);
  const specDir = path.join(cwd, resolved.entityGraphDir);
  if (!fs.existsSync(specDir)) {
    return [];
  }
  return discoverObjectSpecs(specDir).map((spec) =>
    resolveObjectSpec(spec, relationshipSpecs, relationshipFilePaths)
  );
}

function resolveBuildNamespace(config: ProjectConfig | null): string {
  const resolved = resolveConfig({}, config);
  return path.basename(resolved.entityGraphDir || 'entity-graph');
}

async function executeResolutionStep(
  stepName: string,
  spec: ResolvedResolutionSpec,
  result: ResolutionCompileResult,
  dialect: SupportedDialect,
  options: BuildOptions,
  quiet: boolean,
  runner?: SqlRunnerModule
): Promise<BuildStepJson> {
  if (options.dryRun || !options.runner) {
    return {
      name: stepName,
      entity: spec.entity,
      executed: false,
      dry_run: true,
      statement_count: result.statements.length + (result.preamble ? 1 : 0),
      status: 'ok',
      warnings: result.warnings,
      preamble: result.preamble ? toResolvePreambleJson(result.preamble) : undefined,
      statements: result.statements.map((statement) => toResolveStatementJson(statement)),
    };
  }

  if (!runner) {
    throw new CommandError('runner module was not loaded for entity graph build.', 1);
  }
  const executionResults = await executeEntityGraphPlan(
    spec.entity,
    runner,
    { ...result, dialect },
    quiet || Boolean(options.json),
    {
      onInfo: (msg) => out.info(msg),
      onError: (msg) => out.error(msg),
      onSuccess: (msg) => out.success(msg),
    }
  );
  const preambleResult =
    result.preamble && executionResults.length > 0 ? executionResults[0] : undefined;
  const statementResults = result.preamble ? executionResults.slice(1) : executionResults;
  const failed = executionResults.filter((row) => row.status === 'failed');

  return {
    name: stepName,
    entity: spec.entity,
    executed: true,
    dry_run: false,
    statement_count: result.statements.length + (result.preamble ? 1 : 0),
    status: failed.length > 0 ? 'failed' : 'ok',
    warnings: result.warnings,
    preamble: result.preamble ? toResolvePreambleJson(result.preamble, preambleResult) : undefined,
    statements: result.statements.map((statement, index) =>
      toResolveStatementJson(statement, statementResults[index])
    ),
  };
}

async function compileBuildResolutionRun(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options: BuildOptions,
  runner?: SqlRunnerModule
): Promise<ResolutionCompileResult> {
  if (!options.incremental) {
    return compileResolutionRun(spec, dialect, targetSchema);
  }
  if (options.dryRun || !options.runner) {
    throw new CommandError(
      'entity-graph build --incremental requires --runner and cannot be combined with --dry-run because resolve_state must be checked.',
      2
    );
  }
  if (!runner?.query) {
    throw new CommandError(
      'entity-graph build --incremental requires a runner module that exports query(sql).',
      2
    );
  }
  const modePlan = await planResolveRunMode({
    spec,
    dialect,
    targetSchema,
    incrementalRequested: true,
    query: runner.query,
  });
  return compileResolutionRun(spec, dialect, targetSchema, {
    ...(modePlan.incremental ? { incremental: modePlan.incremental } : {}),
    state: {
      runId: modePlan.runId,
      specFingerprint: modePlan.specFingerprint,
      mode: modePlan.mode,
      modeReason: modePlan.modeReason,
      sources: modePlan.sources,
      ...(modePlan.capturedWatermarkValues
        ? { capturedWatermarkValues: modePlan.capturedWatermarkValues }
        : {}),
    },
  });
}

async function executeSurvivorshipStep(
  spec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect,
  options: BuildOptions,
  quiet: boolean,
  runner?: SqlRunnerModule
): Promise<BuildStepJson> {
  const compiled = compileSurvivorship(spec, dialect);
  const statements = [
    ...generateAuditLogDdl(dialect),
    ...compiled.statements,
    generateSurvivorshipAuditSql(spec, dialect),
  ];

  if (options.dryRun || !options.runner) {
    return {
      name: 'survivorship',
      entity: spec.entity,
      executed: false,
      dry_run: true,
      statement_count: statements.length,
      status: 'ok',
      warnings: compiled.warnings,
      statements: statements.map((statement) => ({
        name: statement.name,
        sql: statement.sql,
        table_created: statement.tableCreated,
      })),
    };
  }

  if (!runner?.run) {
    throw new CommandError('runner must implement run(sql) for survivorship build steps.', 2);
  }
  const executionResults: ModelExecutionResult[] = await executeSqlStatements(
    statements.map((statement) => ({
      modelName: `${spec.entity}:${statement.name}`,
      sql: statement.sql,
      ignoreErrorPatterns: statement.ignoreErrorPatterns,
    })),
    runner.run,
    {
      onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
      onError: (msg) => out.error(msg),
      onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
    }
  );
  const failed = executionResults.filter((row) => row.status === 'failed');

  return {
    name: 'survivorship',
    entity: spec.entity,
    executed: true,
    dry_run: false,
    statement_count: statements.length,
    status: failed.length > 0 ? 'failed' : 'ok',
    warnings: compiled.warnings,
    statements: statements.map((statement, index) => ({
      name: statement.name,
      sql: statement.sql,
      status: executionResults[index]?.status,
      error: executionResults[index]?.error,
      rows_affected: executionResults[index]?.rowsAffected,
    })),
  };
}

async function executeRelationshipStep(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  namespace: string,
  options: BuildOptions,
  quiet: boolean,
  runner?: SqlRunnerModule
): Promise<BuildStepJson> {
  const compiled = compileEntityRelationship(spec, dialect, { targetSchema, namespace });

  if (options.dryRun || !options.runner) {
    return {
      name: 'relate',
      entity: spec.name,
      executed: false,
      dry_run: true,
      statement_count: compiled.statements.length,
      status: 'ok',
      warnings: compiled.warnings,
      statements: compiled.statements.map((statement) => ({
        name: statement.name,
        sql: statement.sql,
        table_created: statement.tableCreated,
      })),
    };
  }

  if (!runner?.run) {
    throw new CommandError('runner must implement run(sql) for relationship build steps.', 2);
  }
  const executionResults: ModelExecutionResult[] = await executeSqlStatements(
    compiled.statements.map((statement) => ({
      modelName: `${spec.name}:${statement.name}`,
      sql: statement.sql,
      ignoreErrorPatterns: statement.ignoreErrorPatterns,
    })),
    runner.run,
    {
      onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
      onError: (msg) => out.error(msg),
      onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
    }
  );
  const failed = executionResults.filter((row) => row.status === 'failed');

  return {
    name: 'relate',
    entity: spec.name,
    executed: true,
    dry_run: false,
    statement_count: compiled.statements.length,
    status: failed.length > 0 ? 'failed' : 'ok',
    warnings: compiled.warnings,
    statements: compiled.statements.map((statement, index) => ({
      name: statement.name,
      sql: statement.sql,
      status: executionResults[index]?.status,
      error: executionResults[index]?.error,
      rows_affected: executionResults[index]?.rowsAffected,
    })),
  };
}

async function executeFoundationStep(
  specs: ResolvedResolutionSpec[],
  relationshipSpecs: readonly ResolvedEntityRelationshipSpec[],
  objectSpecs: readonly ResolvedObjectSpec[],
  dialect: SupportedDialect,
  targetSchema: string,
  namespace: string,
  options: BuildOptions,
  quiet: boolean,
  runner?: SqlRunnerModule
): Promise<BuildStepJson> {
  const statements = compileEntityGraphFoundation(specs, dialect, {
    targetSchema,
    namespace,
    relationshipSpecs,
    objectSpecs,
  });

  if (options.dryRun || !options.runner) {
    return {
      name: 'foundation',
      entity: 'entity_graph',
      executed: false,
      dry_run: true,
      statement_count: statements.length,
      status: 'ok',
      warnings: [],
      statements: statements.map((statement) => ({
        name: statement.name,
        sql: statement.sql,
        table_created: statement.tableCreated,
      })),
    };
  }

  if (!runner?.run) {
    throw new CommandError('runner must implement run(sql) for entity graph foundation.', 2);
  }
  const executionResults: ModelExecutionResult[] = await executeSqlStatements(
    statements.map((statement) => ({
      modelName: `entity_graph:${statement.name}`,
      sql: statement.sql,
      ignoreErrorPatterns: statement.ignoreErrorPatterns,
    })),
    runner.run,
    {
      onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
      onError: (msg) => out.error(msg),
      onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
    }
  );
  const failed = executionResults.filter((row) => row.status === 'failed');

  return {
    name: 'foundation',
    entity: 'entity_graph',
    executed: true,
    dry_run: false,
    statement_count: statements.length,
    status: failed.length > 0 ? 'failed' : 'ok',
    warnings: [],
    statements: statements.map((statement, index) => ({
      name: statement.name,
      sql: statement.sql,
      status: executionResults[index]?.status,
      error: executionResults[index]?.error,
      rows_affected: executionResults[index]?.rowsAffected,
    })),
  };
}

async function buildHandler(
  entityNames: string[],
  options: BuildOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect, targetSchema, quiet, config } = buildResolveContext(
    globalOptions,
    options,
    entityNames
  );
  const namespace = resolveBuildNamespace(config);
  const steps: BuildStepJson[] = [];
  const runner =
    options.runner && !options.dryRun ? await loadRunnerModule(options.runner) : undefined;

  try {
    for (const spec of specs) {
      steps.push(
        await executeResolutionStep(
          'resolve',
          spec,
          await compileBuildResolutionRun(spec, dialect, targetSchema, options, runner),
          dialect,
          options,
          quiet,
          runner
        )
      );
      steps.push(
        await executeResolutionStep(
          'cluster',
          spec,
          compileResolutionCluster(spec, dialect, targetSchema),
          dialect,
          options,
          quiet,
          runner
        )
      );
      steps.push(
        await executeResolutionStep(
          'profile',
          spec,
          compileResolutionProfile(spec, dialect, targetSchema),
          dialect,
          options,
          quiet,
          runner
        )
      );
    }

    const survivorshipSpecs = discoverBuildSurvivorshipSpecs(config, specs, dialect, targetSchema);
    for (const spec of survivorshipSpecs) {
      steps.push(await executeSurvivorshipStep(spec, dialect, options, quiet, runner));
    }
    const relationships = discoverBuildRelationshipSpecs(config, targetSchema);
    const requestedEntities = new Set(specs.map((spec) => spec.entity));
    const scopedRelationships =
      requestedEntities.size > 0
        ? relationships.specs.filter(
            (rel) => requestedEntities.has(rel.leftEntity) || requestedEntities.has(rel.rightEntity)
          )
        : relationships.specs;
    for (const spec of scopedRelationships) {
      steps.push(
        await executeRelationshipStep(
          spec,
          dialect,
          targetSchema,
          namespace,
          options,
          quiet,
          runner
        )
      );
    }
    const hasPriorFailure = steps.some((step) => step.status === 'failed');
    if (!hasPriorFailure) {
      const objectSpecs = discoverBuildObjectSpecs(
        config,
        scopedRelationships,
        relationships.filePaths
      );
      steps.push(
        await executeFoundationStep(
          specs,
          scopedRelationships,
          objectSpecs,
          dialect,
          targetSchema,
          namespace,
          options,
          quiet,
          runner
        )
      );
    }

    const failed = steps.filter((step) => step.status === 'failed');
    if (options.json) {
      out.json({
        command: 'entity-graph.build',
        dialect,
        schema: targetSchema,
        executed: Boolean(options.runner) && !options.dryRun,
        incremental: Boolean(options.incremental),
        steps,
        warnings: [],
      });
    } else if (!quiet) {
      for (const step of steps) {
        out.success(
          `${step.dry_run ? '[dry-run] ' : ''}${step.entity}: ${step.name} ${step.statement_count} statement(s)`
        );
        for (const warning of step.warnings) {
          out.warn(warning);
        }
      }
    }

    if (failed.length > 0) {
      throw new CommandError(`${failed.length} entity graph build step(s) failed.`, 1);
    }
  } finally {
    await runner?.close?.();
  }
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('Run resolve, cluster, profile, and colocated survivorship specs')
    .argument('[entity...]', 'Entity names to build (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--dry-run', 'Show the execution plan without executing')
    .option('--incremental', 'Run resolve steps incrementally when resolve_state matches', false)
    .option('--json', 'Output results as JSON to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: BuildOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await buildHandler(entityNames, opts, globalOptions);
    });
}
