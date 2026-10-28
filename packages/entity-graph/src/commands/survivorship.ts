import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';

import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type ModelExecutionResult,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { compileSurvivorship } from '../compiler/survivorship/codegen.js';
import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../compiler/survivorship/parser.js';
import { loadProjectConfig, resolveConfig } from '@bobsled-inc/model-spec/shared';
import { out } from '@bobsled-inc/model-spec/shared';
import { executeSqlStatements } from '@bobsled-inc/model-spec';

import type { ResolvedSurvivorshipSpec } from '../compiler/survivorship/types.js';

import {
  createDialectOption,
  loadRunnerModule,
  parseGlobalFlags,
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';

interface SurvivorshipContext {
  specs: ResolvedSurvivorshipSpec[];
  dialect: SupportedDialect;
  quiet: boolean;
}

function initHandler(entity: string, globalOptions: { verbose?: boolean; quiet?: boolean }): void {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const entityGraphDir = path.join(cwd, resolved.entityGraphDir);
  const filePath = resolvePathWithinDir(
    entityGraphDir,
    `${safeEntity}_survivorship.yml`,
    'Survivorship scaffold path'
  );
  fs.mkdirSync(entityGraphDir, { recursive: true });
  if (fs.existsSync(filePath)) {
    throw new CommandError(`Survivorship scaffold already exists for ${safeEntity}.`, 2);
  }

  fs.writeFileSync(
    filePath,
    [
      `spec_version: '0.2'`,
      `name: ${safeEntity}_survivorship`,
      `type: survivorship`,
      `description: Golden-record rules for ${safeEntity}.`,
      `resolution_ref: ${safeEntity}_resolution`,
      ``,
      `default_timestamp_field: updated_at`,
      ``,
    ].join('\n'),
    'utf-8'
  );

  if (!globalOptions.quiet) {
    out.success(`Created survivorship scaffold ${filePath}`);
  }
}

function buildSurvivorshipContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: string; schema?: string },
  names: string[]
): SurvivorshipContext {
  const flags = parseGlobalFlags(globalOptions);
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);

  const resolved = resolveConfig(
    {
      dialect: localOptions.dialect as SupportedDialect | undefined,
      schema: localOptions.schema,
    },
    config
  );
  const entityGraphDir = path.join(cwd, resolved.entityGraphDir);
  if (!fs.existsSync(entityGraphDir)) {
    throw new CommandError(`No ${resolved.entityGraphDir}/ directory found.`, 2);
  }

  let specs = discoverSurvivorshipSpecs(entityGraphDir).map((spec) =>
    resolveSurvivorshipSpec(spec, entityGraphDir, resolved.schema)
  );
  if (names.length > 0) {
    specs = specs.filter(
      (spec) =>
        names.includes(spec.name) ||
        names.includes(spec.entity) ||
        names.includes(spec.resolutionEntity)
    );
  }
  if (specs.length === 0) {
    throw new CommandError('No survivorship specs found matching the requested names.', 2);
  }

  return {
    specs,
    dialect: resolved.dialect,
    quiet: flags.quiet,
  };
}

function buildSurvivorshipInspectQuery(
  spec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect,
  clusterId?: string
): string {
  const goldenTable = buildFqName(
    spec.targetSchema,
    `${spec.resolutionEntity}__golden_record`,
    dialect
  );
  const auditTable = buildFqName(
    spec.targetSchema,
    `${spec.resolutionEntity}__survivorship_audit`,
    dialect
  );
  const historyTable = buildFqName(
    spec.targetSchema,
    `${spec.resolutionEntity}__golden_history`,
    dialect
  );
  const clusterFilter = clusterId
    ? `WHERE ${quoteIdentifier('cluster_id', dialect)} = ${quoteLiteral(clusterId, dialect)}`
    : '';

  return [
    `SELECT`,
    `  ${quoteLiteral('golden_record', dialect)} AS ${quoteIdentifier('section', dialect)},`,
    `  ${quoteIdentifier('entity_id', dialect)},`,
    `  ${quoteIdentifier('cluster_id', dialect)},`,
    `  ${quoteIdentifier('attribute_name', dialect)},`,
    `  ${quoteIdentifier('attribute_value', dialect)} AS ${quoteIdentifier('value', dialect)},`,
    `  ${quoteIdentifier('source_system', dialect)},`,
    `  ${quoteIdentifier('updated_at', dialect)} AS ${quoteIdentifier('event_at', dialect)}`,
    `FROM ${goldenTable}`,
    clusterFilter,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('audit', dialect)} AS ${quoteIdentifier('section', dialect)},`,
    `  ${quoteIdentifier('entity_id', dialect)},`,
    `  ${quoteIdentifier('cluster_id', dialect)},`,
    `  ${quoteIdentifier('attribute_name', dialect)},`,
    `  ${quoteIdentifier('chosen_value', dialect)} AS ${quoteIdentifier('value', dialect)},`,
    `  ${quoteIdentifier('source_system', dialect)},`,
    `  ${quoteIdentifier('decided_at', dialect)} AS ${quoteIdentifier('event_at', dialect)}`,
    `FROM ${auditTable}`,
    clusterFilter,
    `UNION ALL`,
    `SELECT`,
    `  ${quoteLiteral('history', dialect)} AS ${quoteIdentifier('section', dialect)},`,
    `  ${quoteIdentifier('entity_id', dialect)},`,
    `  ${quoteIdentifier('cluster_id', dialect)},`,
    `  ${quoteIdentifier('attribute_name', dialect)},`,
    `  ${quoteIdentifier('new_value', dialect)} AS ${quoteIdentifier('value', dialect)},`,
    `  NULL AS ${quoteIdentifier('source_system', dialect)},`,
    `  ${quoteIdentifier('changed_at', dialect)} AS ${quoteIdentifier('event_at', dialect)}`,
    `FROM ${historyTable}`,
    clusterFilter,
  ]
    .filter(Boolean)
    .join('\n');
}

function validateHandler(
  names: string[],
  options: { dialect?: string; schema?: string; json?: boolean },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const { specs, dialect } = buildSurvivorshipContext(globalOptions, options, names);
  if (options.json) {
    out.json({
      command: 'survivorship.validate',
      dialect,
      specs: specs.map((spec) => ({
        name: spec.name,
        entity: spec.entity,
        resolution_ref: spec.resolutionRef,
        schema: spec.targetSchema,
        attribute_rule_count: spec.attributeRules.length,
      })),
    });
    return;
  }

  for (const spec of specs) {
    out.success(`Validated survivorship spec ${spec.name} (${spec.attributeRules.length} rules)`);
  }
}

function compileHandler(
  names: string[],
  options: { dialect?: string; schema?: string; output?: string; json?: boolean },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const { specs, dialect } = buildSurvivorshipContext(globalOptions, options, names);
  const outputDir = options.output ? path.resolve(options.output) : undefined;
  const entities: Array<{
    name: string;
    entity: string;
    schema: string;
    warnings: string[];
    statements?: unknown[];
    written_files: string[];
  }> = [];

  for (const spec of specs) {
    const compiled = compileSurvivorship(spec, dialect);
    const writtenFiles: string[] = [];
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      for (const statement of compiled.statements) {
        const filePath = resolvePathWithinDir(
          outputDir,
          `${spec.entity}_${statement.name}.sql`,
          'Survivorship statement output path'
        );
        fs.writeFileSync(filePath, `${statement.sql};\n`, 'utf-8');
        writtenFiles.push(filePath);
      }
    } else if (!options.json) {
      for (const statement of compiled.statements) {
        out.text(`-- ${statement.name}\n${statement.sql};\n\n`);
      }
    }

    entities.push({
      name: spec.name,
      entity: spec.entity,
      schema: spec.targetSchema,
      warnings: compiled.warnings,
      statements: outputDir
        ? undefined
        : compiled.statements.map((statement) => ({
            name: statement.name,
            sql: statement.sql,
            table_created: statement.tableCreated,
          })),
      written_files: writtenFiles,
    });

    emitWarnings(compiled.warnings, options.json);
  }

  if (options.json) {
    out.json({
      command: 'survivorship.compile',
      dialect,
      entities,
    });
  }
}

async function runHandler(
  names: string[],
  options: { dialect?: string; schema?: string; runner?: string; json?: boolean },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect, quiet } = buildSurvivorshipContext(globalOptions, options, names);
  const entities: Array<{
    name: string;
    entity: string;
    schema: string;
    executed: boolean;
    warnings: string[];
    statements: unknown[];
  }> = [];

  for (const spec of specs) {
    const compiled = compileSurvivorship(spec, dialect);
    let executionResults: ModelExecutionResult[] = [];
    if (options.runner) {
      const { run } = await loadRunnerModule(options.runner);
      executionResults = await executeSqlStatements(
        compiled.statements.map((statement) => ({
          modelName: `${spec.entity}:${statement.name}`,
          sql: statement.sql,
        })),
        run,
        {
          onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
          onError: (msg) => out.error(msg),
          onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
        }
      );
    } else if (!options.json) {
      for (const statement of compiled.statements) {
        out.text(`-- ${statement.name}\n${statement.sql};\n\n`);
      }
    }

    entities.push({
      name: spec.name,
      entity: spec.entity,
      schema: spec.targetSchema,
      executed: Boolean(options.runner),
      warnings: compiled.warnings,
      statements: options.runner
        ? compiled.statements.map((statement, index) => ({
            name: statement.name,
            sql: statement.sql,
            status: executionResults[index]?.status,
            error: executionResults[index]?.error,
            rows_affected: executionResults[index]?.rowsAffected,
          }))
        : compiled.statements.map((statement) => ({
            name: statement.name,
            sql: statement.sql,
          })),
    });

    emitWarnings(compiled.warnings, options.json);

    const failed = executionResults.filter((result) => result.status === 'failed');
    if (failed.length > 0) {
      if (options.json) {
        out.json({
          command: 'survivorship.run',
          dialect,
          entities,
        });
      }
      throw new CommandError(`${spec.entity}: ${failed.length} statement(s) failed.`, 1);
    }
  }

  if (options.json) {
    out.json({
      command: 'survivorship.run',
      dialect,
      entities,
    });
  }
}

function emitWarnings(warnings: string[], json?: boolean): void {
  if (json) {
    return;
  }
  for (const warning of warnings) {
    out.warn(warning);
  }
}

async function inspectHandler(
  name: string,
  options: {
    dialect?: string;
    schema?: string;
    runner?: string;
    clusterId?: string;
    json?: boolean;
  },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { specs, dialect } = buildSurvivorshipContext(globalOptions, options, [name]);
  const spec = specs[0]!;
  const query = buildSurvivorshipInspectQuery(spec, dialect, options.clusterId);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'survivorship.inspect',
        name: spec.name,
        dialect,
        schema: spec.targetSchema,
        executed: false,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  const rows = await runner.query(query);
  const result = {
    command: 'survivorship.inspect',
    name: spec.name,
    dialect,
    schema: spec.targetSchema,
    executed: true,
    rows,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
}

export function registerSurvivorshipCommand(program: Command): void {
  const survivorship = program
    .command('survivorship')
    .description('Golden record survivorship commands');

  survivorship
    .command('init')
    .argument('<entity>', 'Entity name')
    .description('Scaffold a new survivorship spec')
    .action((entity: string) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initHandler(entity, globalOptions);
    });

  survivorship
    .command('validate')
    .argument('[name...]', 'Survivorship spec names (default: all)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((names: string[], opts: { dialect?: string; schema?: string; json?: boolean }) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      validateHandler(names, opts, globalOptions);
    });

  survivorship
    .command('compile')
    .argument('[name...]', 'Survivorship spec names (default: all)')
    .option('-o, --output <dir>', 'Write SQL files to directory')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(
      (
        names: string[],
        opts: { dialect?: string; schema?: string; output?: string; json?: boolean }
      ) => {
        const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
        compileHandler(names, opts, globalOptions);
      }
    );

  survivorship
    .command('run')
    .argument('[name...]', 'Survivorship spec names (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(
      async (
        names: string[],
        opts: { dialect?: string; schema?: string; runner?: string; json?: boolean }
      ) => {
        const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
        await runHandler(names, opts, globalOptions);
      }
    );

  survivorship
    .command('inspect')
    .argument('<name>', 'Survivorship spec name or entity')
    .option('--cluster-id <value>', 'Filter to a specific cluster')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(
      async (
        name: string,
        opts: {
          dialect?: string;
          schema?: string;
          runner?: string;
          clusterId?: string;
          json?: boolean;
        }
      ) => {
        const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
        await inspectHandler(name, opts, globalOptions);
      }
    );
}
