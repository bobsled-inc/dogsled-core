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
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';
import {
  buildFqName,
  executeSqlStatements,
  quoteIdentifier,
  quoteLiteral,
  type ModelExecutionResult,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { compileEntityRelationship } from '../compiler/relationship/codegen.js';
import {
  discoverEntityRelationshipSpecs,
  resolveEntityRelationshipSpec,
} from '../compiler/relationship/parser.js';
import type {
  ParsedEntityRelationshipSpec,
  ResolvedEntityRelationshipSpec,
} from '../compiler/relationship/types.js';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import { outputTableName } from '../compiler/output-tables/index.js';

interface RelateContext {
  warnings: string[];
  specs: ResolvedEntityRelationshipSpec[];
  parsedSpecs: ParsedEntityRelationshipSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
  namespace: string;
  quiet: boolean;
}

interface RelateOptions {
  dialect?: string;
  schema?: string;
  json?: boolean;
}

interface GlobalOptions {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface RelateInitOptions {
  json?: boolean;
}

interface RelateCompileOptions extends RelateOptions {
  output?: string;
}

interface RelateRunOptions extends RelateOptions {
  runner?: string;
  dryRun?: boolean;
}

interface RelateReviewOptions extends RelateOptions {
  runner?: string;
  limit?: number;
}

function parsePositiveLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommandError('--limit must be a positive integer.', 2);
  }
  return parsed;
}

interface RelateInspectOptions extends RelateOptions {
  runner?: string;
  edgeId: string;
}

function buildRelateContext(
  globalOptions: GlobalOptions,
  localOptions: { dialect?: string; schema?: string },
  relationshipNames: string[]
): RelateContext {
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig(
    { dialect: localOptions.dialect as SupportedDialect | undefined, schema: localOptions.schema },
    config
  );
  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  if (!fs.existsSync(entityGraphDir)) {
    throw new CommandError(
      `No ${resolved.entityGraphDir}/ directory found. Create it with entity relationship YAML files.`,
      2
    );
  }

  let parsedSpecs: ParsedEntityRelationshipSpec[];
  try {
    parsedSpecs = discoverEntityRelationshipSpecs(entityGraphDir);
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), 2);
  }
  if (parsedSpecs.length === 0) {
    throw new CommandError(`No entity relationship specs found in ${resolved.entityGraphDir}/.`, 2);
  }

  if (relationshipNames.length > 0) {
    const knownNames = new Set(parsedSpecs.map((spec) => spec.name));
    const unknown = relationshipNames.filter((name) => !knownNames.has(name));
    if (unknown.length > 0) {
      throw new CommandError(`Unknown entity relationship spec(s): ${unknown.join(', ')}`, 2);
    }
    parsedSpecs = parsedSpecs.filter((spec) => relationshipNames.includes(spec.name));
    if (parsedSpecs.length === 0) {
      throw new CommandError(
        `No entity relationship specs found matching: ${relationshipNames.join(', ')}`,
        2
      );
    }
  }

  const specs = parsedSpecs.map((spec) => resolveEntityRelationshipSpec(spec, resolved.schema));
  validateEntityRefs(entityGraphDir, specs);
  return {
    warnings: [],
    specs,
    parsedSpecs,
    dialect: resolved.dialect,
    targetSchema: resolved.schema,
    namespace: path.basename(entityGraphDir),
    quiet: Boolean(globalOptions.quiet),
  };
}

function validateEntityRefs(
  entityGraphDir: string,
  specs: readonly ResolvedEntityRelationshipSpec[]
): void {
  let resolutionSpecs: ReturnType<typeof discoverResolutionSpecs>;
  try {
    resolutionSpecs = discoverResolutionSpecs(entityGraphDir);
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), 2);
  }
  const resolutionEntities = new Set(
    resolutionSpecs.map((spec) => spec.raw.name.replace(/_resolution$/, ''))
  );
  if (resolutionEntities.size === 0) return;

  const errors: string[] = [];
  for (const spec of specs) {
    if (!resolutionEntities.has(spec.leftEntity)) {
      errors.push(`${spec.name} references unknown left_entity "${spec.leftEntity}"`);
    }
    if (!resolutionEntities.has(spec.rightEntity)) {
      errors.push(`${spec.name} references unknown right_entity "${spec.rightEntity}"`);
    }
  }
  if (errors.length > 0) {
    throw new CommandError(
      `Entity relationship validation failed:\n  - ${errors.join('\n  - ')}`,
      2
    );
  }
}

function emitContextWarnings(context: RelateContext, options: { json?: boolean }): void {
  if (context.quiet || options.json) return;
  for (const warning of context.warnings) out.warn(warning);
}

function initHandler(name: string, globalOptions: GlobalOptions): void {
  const safeName = validateScaffoldName(name, 'Relationship name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  const relationshipsDir = resolvePathWithinDir(
    entityGraphDir,
    'relationships',
    'Entity relationship directory'
  );
  const filePath = resolvePathWithinDir(
    relationshipsDir,
    `${safeName}.entity-relationship.yml`,
    'Entity relationship path'
  );
  fs.mkdirSync(relationshipsDir, { recursive: true });

  if (fs.existsSync(filePath)) {
    throw new CommandError(`Entity relationship scaffold already exists for ${safeName}.`, 2);
  }

  fs.writeFileSync(
    filePath,
    [
      `spec_version: '0.2'`,
      `type: entity_relationship`,
      `name: ${safeName}`,
      `left_entity: contact`,
      `right_entity: company`,
      `join_columns:`,
      `  - left: email_domain`,
      `    right: domain`,
      `join_type: inner`,
      `relationship_type: many_to_one`,
      `review:`,
      `  thresholds:`,
      `    auto_confirm: 0.92`,
      `    review: 0.65`,
      `    auto_reject: 0.4`,
      ``,
    ].join('\n'),
    'utf-8'
  );

  if (globalOptions.json) {
    out.json({
      command: 'relate.init',
      relationship: safeName,
      file_path: filePath,
      created: true,
    });
  } else if (!globalOptions.quiet) {
    out.success(`Created entity relationship scaffold ${filePath}`);
  }
}

function validateHandler(
  relationshipNames: string[],
  options: RelateOptions,
  globalOptions: GlobalOptions
): void {
  const context = buildRelateContext(globalOptions, options, relationshipNames);

  if (options.json) {
    out.json({
      command: 'relate.validate',
      dialect: context.dialect,
      schema: context.targetSchema,
      warnings: context.warnings,
      relationships: context.specs.map((spec) => ({
        name: spec.name,
        left_entity: spec.leftEntity,
        right_entity: spec.rightEntity,
        join_column_count: spec.joinColumns.length,
        relationship_type: spec.relationshipType,
        join_type: spec.joinType,
      })),
    });
    return;
  }

  if (!context.quiet) {
    emitContextWarnings(context, options);
    for (const spec of context.specs) {
      out.success(`${spec.name} (${spec.leftEntity} -> ${spec.rightEntity})`);
    }
    out.success(`Validated ${context.specs.length} entity relationship spec(s).`);
  }
}

function compileHandler(
  relationshipNames: string[],
  options: RelateCompileOptions,
  globalOptions: GlobalOptions
): void {
  const context = buildRelateContext(globalOptions, options, relationshipNames);
  const outputDir = options.output ? path.resolve(options.output) : undefined;
  emitContextWarnings(context, options);
  const relationships = context.specs.map((spec) => {
    const result = compileEntityRelationship(spec, context.dialect, {
      targetSchema: context.targetSchema,
      namespace: context.namespace,
    });
    const writtenFiles: string[] = [];

    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      for (const statement of result.statements) {
        const filePath = resolvePathWithinDir(
          outputDir,
          `${spec.name}_${statement.name}.sql`,
          'Relationship compile output path'
        );
        fs.writeFileSync(filePath, `${statement.sql};\n`, 'utf-8');
        writtenFiles.push(filePath);
      }
    } else if (!options.json) {
      for (const statement of result.statements) {
        out.text(`-- ${spec.name}: ${statement.name}\n${statement.sql};\n\n`);
      }
    }

    return {
      name: spec.name,
      statement_count: result.statements.length,
      warnings: result.warnings,
      output_dir: outputDir,
      written_files: writtenFiles,
      statements: outputDir
        ? undefined
        : result.statements.map((statement) => ({
            name: statement.name,
            sql: statement.sql,
            table_created: statement.tableCreated,
          })),
    };
  });

  if (options.json) {
    out.json({
      command: 'relate.compile',
      dialect: context.dialect,
      schema: context.targetSchema,
      warnings: context.warnings,
      relationships,
    });
  }
}

async function runHandler(
  relationshipNames: string[],
  options: RelateRunOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  const context = buildRelateContext(globalOptions, options, relationshipNames);
  emitContextWarnings(context, options);
  const compiled = context.specs.map((spec) => ({
    spec,
    result: compileEntityRelationship(spec, context.dialect, {
      targetSchema: context.targetSchema,
      namespace: context.namespace,
    }),
  }));

  if (options.dryRun || !options.runner) {
    const relationships = compiled.map(({ spec, result }) => ({
      name: spec.name,
      executed: false,
      dry_run: true,
      statement_count: result.statements.length,
      statements: result.statements.map((statement) => ({
        name: statement.name,
        sql: statement.sql,
        table_created: statement.tableCreated,
      })),
    }));
    if (options.json) {
      out.json({
        command: 'relate.run',
        dialect: context.dialect,
        schema: context.targetSchema,
        warnings: context.warnings,
        executed: false,
        relationships,
      });
    } else {
      for (const relationship of relationships) {
        out.info(
          `[dry-run] Would execute ${relationship.statement_count} statements for ${relationship.name}`
        );
      }
    }
    return;
  }

  const runner = await loadRunnerModule(options.runner);
  if (runner.run == null) {
    throw new CommandError('runner must implement run(sql) for relationship execution.', 2);
  }

  const statements = compiled.flatMap(({ spec, result }) =>
    result.statements.map((statement) => ({
      modelName: `${spec.name}:${statement.name}`,
      sql: statement.sql,
      ignoreErrorPatterns: statement.ignoreErrorPatterns,
    }))
  );
  const executionResults: ModelExecutionResult[] = await executeSqlStatements(
    statements,
    runner.run,
    {
      onInfo: context.quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
      onError: context.quiet || Boolean(options.json) ? undefined : (msg) => out.error(msg),
      onSuccess: context.quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
    }
  );
  const failed = executionResults.filter((result) => result.status === 'failed');

  if (options.json) {
    out.json({
      command: 'relate.run',
      dialect: context.dialect,
      schema: context.targetSchema,
      warnings: context.warnings,
      executed: true,
      success: failed.length === 0,
      failed_count: failed.length,
      error: failed.length > 0 ? `${failed.length} relationship statement(s) failed.` : undefined,
      statements: executionResults,
    });
    if (failed.length > 0) {
      process.exitCode = 1;
    }
    return;
  }
  if (failed.length > 0) {
    throw new CommandError(`${failed.length} relationship statement(s) failed.`, 1);
  }
}

function reviewQueueQuery(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  schema: string,
  limit?: number
): string {
  const lines = [
    `SELECT *`,
    `FROM ${buildFqName(schema, outputTableName(spec.name, '__relationship_review_queue'), dialect)}`,
    `ORDER BY ${quoteIdentifier('confidence', dialect)} DESC`,
  ];
  if (limit != null) {
    lines.push(`LIMIT ${limit}`);
  }
  return lines.join('\n');
}

async function reviewHandler(
  relationshipNames: string[],
  options: RelateReviewOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  const context = buildRelateContext(globalOptions, options, relationshipNames);
  emitContextWarnings(context, options);
  if (context.specs.length !== 1) {
    throw new CommandError('relate review requires exactly one relationship name.', 2);
  }
  const spec = context.specs[0]!;
  const limit = options.limit ?? 1000;
  const query = reviewQueueQuery(spec, context.dialect, context.targetSchema, limit);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql) for relate review.', 2);
  }
  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'relate.review',
        relationship: spec.name,
        warnings: context.warnings,
        executed: false,
        query,
      });
    } else {
      out.text(`${query}\n`);
    }
    return;
  }
  const rows = await runner.query(query);
  if (options.json) {
    out.json({
      command: 'relate.review',
      relationship: spec.name,
      warnings: context.warnings,
      executed: true,
      rows,
    });
  } else {
    out.yaml({ relationship: spec.name, rows });
  }
}

async function inspectHandler(
  relationshipName: string,
  options: RelateInspectOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  const context = buildRelateContext(globalOptions, options, [relationshipName]);
  emitContextWarnings(context, options);
  const spec = context.specs[0]!;
  const table = buildFqName(
    context.targetSchema,
    outputTableName(spec.name, '__relationship_edges'),
    context.dialect
  );
  const query = [
    `SELECT *`,
    `FROM ${table}`,
    `WHERE ${quoteIdentifier('edge_id', context.dialect)} = ${quoteLiteral(options.edgeId, context.dialect)}`,
  ].join('\n');
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql) for relate inspect.', 2);
  }
  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'relate.inspect',
        relationship: spec.name,
        edge_id: options.edgeId,
        warnings: context.warnings,
        executed: false,
        query,
      });
    } else {
      out.text(`${query}\n`);
    }
    return;
  }
  const rows = await runner.query(query);
  if (options.json) {
    out.json({
      command: 'relate.inspect',
      relationship: spec.name,
      edge_id: options.edgeId,
      warnings: context.warnings,
      executed: true,
      found: rows.length > 0,
      rows,
    });
  } else {
    out.yaml({ relationship: spec.name, edge_id: options.edgeId, rows });
  }
}

export function registerRelateCommand(program: Command): void {
  const relate = program.command('relate').description('Entity relationship plane commands');

  relate
    .command('init')
    .description('Scaffold an entity relationship spec')
    .argument('<name>', 'Relationship name')
    .option('--json', 'Output results as JSON')
    .action((name: string, opts: RelateInitOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      initHandler(name, { ...globalOptions, json: opts.json });
    });

  relate
    .command('validate')
    .description('Validate entity relationship specs')
    .argument('[relationship...]', 'Relationship names to validate (default: all)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((relationshipNames: string[], opts: RelateOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      validateHandler(relationshipNames, opts, globalOptions);
    });

  relate
    .command('compile')
    .description('Compile entity relationship SQL')
    .argument('[relationship...]', 'Relationship names to compile (default: all)')
    .option('-o, --output <dir>', 'Write SQL files to a directory')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((relationshipNames: string[], opts: RelateCompileOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      compileHandler(relationshipNames, opts, globalOptions);
    });

  relate
    .command('run')
    .description('Run entity relationship SQL')
    .argument('[relationship...]', 'Relationship names to run (default: all)')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--dry-run', 'Show the execution plan without executing')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (relationshipNames: string[], opts: RelateRunOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      await runHandler(relationshipNames, opts, globalOptions);
    });

  relate
    .command('review')
    .description('Show relationship review queue rows or SQL')
    .argument('<relationship>', 'Relationship name')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .option('--limit <n>', 'Maximum rows to return (default: 1000)', parsePositiveLimit)
    .addOption(createDialectOption())
    .action(async (relationshipName: string, opts: RelateReviewOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      await reviewHandler([relationshipName], opts, globalOptions);
    });

  relate
    .command('inspect')
    .description('Inspect a relationship edge')
    .argument('<relationship>', 'Relationship name')
    .requiredOption('--edge-id <id>', 'Edge ID')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (relationshipName: string, opts: RelateInspectOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      await inspectHandler(relationshipName, opts, globalOptions);
    });
}
