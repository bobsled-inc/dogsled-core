import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { Command } from 'commander';

import { createDialectOption, createIntegrationOption } from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';

import { compileResolveProject } from '../api/resolve-project.js';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import { resolveEntityGraphScaffoldPaths } from './scaffold-utils.js';

interface DiffOptions {
  base?: string;
  integration?: string;
  dialect?: string;
  schema?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface ChangedSpec {
  status: string;
  path: string;
  sourcePath?: string;
}

function parseChangedSpecs(raw: string): ChangedSpec[] {
  const fields = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : raw.split('\0');
  const changed: ChangedSpec[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const sourcePath = fields[index++] ?? '';
      const destinationPath = fields[index++] ?? '';
      changed.push({ status, path: destinationPath, sourcePath });
      continue;
    }
    const filePath = fields[index++] ?? '';
    changed.push({ status, path: filePath });
  }
  return changed;
}

function resolveFormat(options: DiffOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

function renderDiffText(payload: {
  base_ref: string;
  changed_specs: ChangedSpec[];
  current_statement_count: number;
}): string {
  const lines = [
    `Entity graph diff against ${payload.base_ref}`,
    `Current compiled statements: ${payload.current_statement_count}`,
  ];
  if (payload.changed_specs.length === 0) {
    lines.push('No spec file changes detected.');
  } else {
    lines.push('Changed spec files:');
    lines.push(...payload.changed_specs.map((spec) => `- ${spec.status} ${spec.path}`));
  }
  return `${lines.join('\n')}\n`;
}

async function diffHandler(entityNames: string[], options: DiffOptions): Promise<void> {
  const baseRef = options.base ?? 'origin/main';
  const paths = resolveEntityGraphScaffoldPaths();
  const mdmRelative = path.relative(paths.cwd, paths.entityGraphDir) || paths.entityGraphDirName;
  let rawDiff: string;
  try {
    rawDiff = execFileSync(
      'git',
      ['diff', '--name-status', '-z', '--end-of-options', baseRef, '--', mdmRelative],
      {
        cwd: paths.cwd,
        encoding: 'utf-8',
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Failed to diff '${mdmRelative}' against '${baseRef}': ${message}`, 2);
  }
  const compiled = await compileResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    quiet: options.quiet ?? !options.verbose,
  });
  const currentSpecs = discoverResolutionSpecs(paths.entityGraphDir).map((spec) => ({
    name: spec.name,
    path: path.relative(paths.cwd, spec.filePath),
  }));
  const payload = {
    command: 'entity-graph.diff',
    base_ref: baseRef,
    dialect: compiled.context.dialect,
    schema: compiled.context.targetSchema,
    changed_specs: parseChangedSpecs(rawDiff),
    current_specs: currentSpecs,
    current_statement_count: compiled.entities.reduce(
      (sum, entity) => sum + entity.statement_count,
      0
    ),
    output_tables: compiled.entities.flatMap((entity) =>
      entity.result.statements.flatMap((statement) =>
        statement.tableCreated ? [{ entity: entity.entity, table: statement.tableCreated }] : []
      )
    ),
  };
  emitEntityGraphPayload(payload, resolveFormat(options), () => renderDiffText(payload));
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description('Show entity graph spec and compiled-output drift against a git ref')
    .argument('[entity...]', 'Entity names to diff (default: all)')
    .option('--base <ref>', 'Git ref to compare against', 'origin/main')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-essential output')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: DiffOptions) => {
      await diffHandler(entityNames, opts);
    });
}
