import * as fs from 'node:fs';
import type { Command } from 'commander';

import { createDialectOption, createIntegrationOption, out } from '@bobsled-inc/model-spec/shared';

import { compileResolveProject, validateResolveProject } from '../api/resolve-project.js';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import {
  resolveEntityGraphScaffoldPaths,
  writeStarterResolutionSpec,
  type WrittenScaffoldFile,
} from './scaffold-utils.js';

interface QuickstartOptions {
  entity?: string;
  integration?: string;
  dialect?: string;
  schema?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

function renderQuickstartText(payload: QuickstartPayload): string {
  const lines = [
    `Entity graph quickstart: ${payload.project.entity_graph_dir}`,
    `Dialect: ${payload.project.dialect}`,
    `Schema: ${payload.project.schema}`,
  ];
  if (payload.project.integration) {
    lines.push(`Integration: ${payload.project.integration}`);
  }
  if (payload.created_files.length > 0) {
    lines.push('', 'Created files:');
    lines.push(...payload.created_files.map((file) => `- ${file.kind}: ${file.path}`));
  }
  lines.push('', 'Next commands:');
  lines.push(...payload.next_commands.map((entry) => `- ${entry.command}`));
  if (payload.warnings.length > 0) {
    lines.push('', 'Warnings:');
    lines.push(...payload.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join('\n')}\n`;
}

interface QuickstartPayload {
  command: 'entity-graph.quickstart';
  project: {
    cwd: string;
    entity_graph_dir: string;
    dialect: string;
    schema: string;
    integration: string | null;
  };
  created_files: WrittenScaffoldFile[];
  resolution_specs: Array<{ entity: string; name: string; file_path: string }>;
  validation: {
    valid: boolean;
    entity_count: number;
    compile_statement_count: number;
  };
  next_commands: Array<{ label: string; command: string }>;
  warnings: string[];
}

function formatFlag(format: EntityGraphOutputFormat): string {
  return format === 'text' ? '' : ` --${format}`;
}

async function quickstartHandler(options: QuickstartOptions): Promise<void> {
  const format = resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
  const paths = resolveEntityGraphScaffoldPaths();
  const createdFiles: WrittenScaffoldFile[] = [];
  fs.mkdirSync(paths.entityGraphDir, { recursive: true });

  if (discoverResolutionSpecs(paths.entityGraphDir).length === 0) {
    const created = writeStarterResolutionSpec(paths, options.entity ?? 'company');
    if (created.created) {
      createdFiles.push(created);
    }
  }

  const context = await loadEntityGraphProjectContext({
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    verbose: options.verbose,
    quiet: options.quiet,
  });
  const validation = await validateResolveProject({
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    quiet: options.quiet ?? !options.verbose,
  });
  const compiled = await compileResolveProject({
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    quiet: options.quiet ?? !options.verbose,
  });
  const commandTarget = context.integration
    ? `--integration ${context.integration.handle}`
    : `--dialect ${context.dialect}`;
  const schemaFlag = context.targetSchema ? ` --schema ${context.targetSchema}` : '';
  const outFlag = formatFlag(format);
  const payload: QuickstartPayload = {
    command: 'entity-graph.quickstart',
    project: {
      cwd: context.cwd,
      entity_graph_dir: paths.entityGraphDirName,
      dialect: context.dialect,
      schema: context.targetSchema,
      integration: context.integration?.handle ?? null,
    },
    created_files: createdFiles,
    resolution_specs: discoverResolutionSpecs(paths.entityGraphDir).map((spec) => ({
      entity: spec.raw.name.replace(/_resolution$/, ''),
      name: spec.name,
      file_path: spec.filePath,
    })),
    validation: {
      valid: true,
      entity_count: validation.entities.length,
      compile_statement_count: compiled.entities.reduce(
        (sum, entity) => sum + entity.statement_count,
        0
      ),
    },
    next_commands: [
      {
        label: 'validate',
        command: `dogsled entity-graph resolve validate ${commandTarget}${schemaFlag}${outFlag}`,
      },
      {
        label: 'preview_sql',
        command: `dogsled entity-graph resolve compile ${commandTarget}${schemaFlag}${outFlag}`,
      },
      {
        label: 'dry_run',
        command: `dogsled entity-graph resolve run --dry-run ${commandTarget}${schemaFlag}${outFlag}`,
      },
    ],
    warnings: context.warnings,
  };
  emitEntityGraphPayload(payload, format, () => renderQuickstartText(payload));
}

export function registerQuickstartCommand(program: Command): void {
  program
    .command('quickstart')
    .description('Inspect and bootstrap a local entity graph project')
    .argument('[entity]', 'Starter entity name when no resolution spec exists')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--verbose', 'Verbose logging')
    .option('--quiet', 'Suppress non-error output')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entity: string | undefined, opts: QuickstartOptions) => {
      await quickstartHandler({ ...opts, entity });
      if (!opts.quiet && !opts.json && !opts.yaml && opts.format == null) {
        out.info('Use --format text for a compact command list.');
      }
    });
}
