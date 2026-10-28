import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadProjectConfig,
  out,
  resolveConfig,
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { generateObjectTypesSql } from '../compiler/object/codegen.js';
import { discoverObjectSpecs, resolveObjectSpec } from '../compiler/object/parser.js';
import {
  discoverEntityRelationshipSpecs,
  resolveEntityRelationshipSpec,
} from '../compiler/relationship/parser.js';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import type { ParsedObjectSpec, ResolvedObjectSpec } from '../compiler/object/types.js';
import type { ParsedEntityRelationshipSpec } from '../compiler/relationship/types.js';

interface ObjectOptions {
  dialect?: string;
  schema?: string;
  json?: boolean;
}

interface GlobalOptions {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface ObjectInitOptions {
  json?: boolean;
}

interface ObjectCompileOptions extends ObjectOptions {
  output?: string;
}

interface ObjectContext {
  warnings: string[];
  objects: ResolvedObjectSpec[];
  parsedObjects: ParsedObjectSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
  quiet: boolean;
}

function buildObjectContext(
  globalOptions: GlobalOptions,
  localOptions: { dialect?: string; schema?: string },
  objectNames: string[]
): ObjectContext {
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
    throw new CommandError(`No ${resolved.entityGraphDir}/ directory found.`, 2);
  }

  let relationships: ParsedEntityRelationshipSpec[];
  let objects: ParsedObjectSpec[];
  try {
    relationships = discoverEntityRelationshipSpecs(entityGraphDir);
    objects = discoverObjectSpecs(entityGraphDir);
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), 2);
  }
  if (objects.length === 0) {
    throw new CommandError(`No object specs found in ${resolved.entityGraphDir}/.`, 2);
  }
  if (objectNames.length > 0) {
    const knownNames = new Set(objects.map((spec) => spec.name));
    const unknown = objectNames.filter((name) => !knownNames.has(name));
    if (unknown.length > 0) {
      throw new CommandError(`Unknown object spec(s): ${unknown.join(', ')}`, 2);
    }
    objects = objects.filter((spec) => objectNames.includes(spec.name));
  }

  const resolvedRelationships = relationships.map((spec) =>
    resolveEntityRelationshipSpec(spec, resolved.schema)
  );
  const relationshipFilePaths = new Map(relationships.map((spec) => [spec.name, spec.filePath]));

  let resolutionSpecs: ReturnType<typeof discoverResolutionSpecs>;
  try {
    resolutionSpecs = discoverResolutionSpecs(entityGraphDir);
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), 2);
  }
  const resolutionNames = new Set(resolutionSpecs.map((spec) => spec.raw.name));
  const resolutionPaths = new Set(resolutionSpecs.map((spec) => path.resolve(spec.filePath)));
  for (const obj of objects) {
    const ref = obj.raw.identity.resolution_ref;
    const resolvedRefPath = path.resolve(path.dirname(obj.filePath), ref);
    const refBase = path.basename(ref).replace(/_resolution\.ya?ml$/, '');
    if (!resolutionNames.has(refBase) && !resolutionPaths.has(resolvedRefPath)) {
      throw new CommandError(
        `Object "${obj.raw.name}": identity.resolution_ref "${ref}" does not match any discovered resolution spec.`,
        2
      );
    }
  }

  let resolvedObjects: ResolvedObjectSpec[];
  try {
    resolvedObjects = objects.map((spec) =>
      resolveObjectSpec(spec, resolvedRelationships, relationshipFilePaths)
    );
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), 2);
  }

  return {
    warnings: [],
    objects: resolvedObjects,
    parsedObjects: objects,
    dialect: resolved.dialect,
    targetSchema: resolved.schema,
    quiet: Boolean(globalOptions.quiet),
  };
}

function initHandler(name: string, globalOptions: GlobalOptions): void {
  const safeName = validateScaffoldName(name, 'Object name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  const objectsDir = resolvePathWithinDir(entityGraphDir, 'objects', 'Object directory');
  const filePath = resolvePathWithinDir(objectsDir, `${safeName}.object.yml`, 'Object path');
  fs.mkdirSync(objectsDir, { recursive: true });

  if (fs.existsSync(filePath)) {
    throw new CommandError(`Object scaffold already exists for ${safeName}.`, 2);
  }

  fs.writeFileSync(
    filePath,
    [
      `spec_version: '1'`,
      `type: object`,
      `name: ${safeName}`,
      `identity:`,
      `  resolution_ref: ../${safeName}_resolution.yml`,
      `links: []`,
      ``,
    ].join('\n'),
    'utf-8'
  );

  if (globalOptions.json) {
    out.json({
      command: 'object.init',
      object: safeName,
      file_path: filePath,
      created: true,
    });
  } else if (!globalOptions.quiet) {
    out.success(`Created object scaffold ${filePath}`);
  }
}

function validateHandler(
  objectNames: string[],
  options: ObjectOptions,
  globalOptions: GlobalOptions
): void {
  const context = buildObjectContext(globalOptions, options, objectNames);
  if (options.json) {
    out.json({
      command: 'object.validate',
      dialect: context.dialect,
      schema: context.targetSchema,
      warnings: context.warnings,
      objects: context.objects.map((spec) => ({
        name: spec.name,
        identity_resolution_ref: spec.identityResolutionRef,
        link_count: spec.links.length,
      })),
    });
    return;
  }

  if (!context.quiet) {
    for (const warning of context.warnings) out.warn(warning);
    for (const spec of context.objects) {
      out.success(`${spec.name} (${spec.links.length} link(s))`);
    }
  }
  if (!context.quiet) {
    out.success(`Validated ${context.objects.length} object spec(s).`);
  }
}

function compileHandler(
  objectNames: string[],
  options: ObjectCompileOptions,
  globalOptions: GlobalOptions
): void {
  const context = buildObjectContext(globalOptions, options, objectNames);
  const statement = generateObjectTypesSql(context.objects, context.dialect, {
    contractSchema: context.targetSchema,
  });
  const outputDir = options.output ? path.resolve(options.output) : undefined;
  const writtenFiles: string[] = [];

  if (!options.json && !context.quiet) {
    for (const warning of context.warnings) out.warn(warning);
  }

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = resolvePathWithinDir(
      outputDir,
      'entity_graph_object_types.sql',
      'Object output path'
    );
    fs.writeFileSync(filePath, `${statement.sql};\n`, 'utf-8');
    writtenFiles.push(filePath);
  } else if (!options.json) {
    out.text(`${statement.sql};\n`);
  }

  if (options.json) {
    out.json({
      command: 'object.compile',
      dialect: context.dialect,
      schema: context.targetSchema,
      warnings: context.warnings,
      output_dir: outputDir,
      written_files: writtenFiles,
      statement: outputDir
        ? undefined
        : {
            name: statement.name,
            sql: statement.sql,
            table_created: statement.tableCreated,
          },
    });
  }
}

export function registerObjectCommand(program: Command): void {
  const object = program.command('object').description('Entity object registry commands');

  object
    .command('init')
    .description('Scaffold an object spec')
    .argument('<name>', 'Object name')
    .option('--json', 'Output results as JSON')
    .action((name: string, opts: ObjectInitOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      initHandler(name, { ...globalOptions, json: opts.json });
    });

  object
    .command('validate')
    .description('Validate object specs')
    .argument('[object...]', 'Object names to validate (default: all)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((objectNames: string[], opts: ObjectOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      validateHandler(objectNames, opts, globalOptions);
    });

  object
    .command('compile')
    .description('Compile object registry SQL')
    .argument('[object...]', 'Object names to compile (default: all)')
    .option('-o, --output <dir>', 'Write SQL files to a directory')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((objectNames: string[], opts: ObjectCompileOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      compileHandler(objectNames, opts, globalOptions);
    });
}
