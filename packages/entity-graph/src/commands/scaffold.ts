import type { Command } from 'commander';

import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import {
  resolveEntityGraphScaffoldPaths,
  writeStarterMentionExtraction,
  writeStarterOntology,
  writeStarterRelationshipExtraction,
  writeStarterResolutionSpec,
  type WrittenScaffoldFile,
} from './scaffold-utils.js';
import { registerScaffoldDocumentCommand } from './scaffold-document.js';

interface ScaffoldOptions {
  skipResolution?: boolean;
  skipOntology?: boolean;
  skipMentions?: boolean;
  skipRelationships?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

interface ScaffoldPayload {
  command: 'entity-graph.scaffold';
  entity: string;
  entity_graph_dir: string;
  files: WrittenScaffoldFile[];
  next_commands: Array<{ label: string; command: string }>;
}

function resolveFormat(options: ScaffoldOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

function renderScaffoldText(payload: ScaffoldPayload): string {
  const lines = [`Scaffolded entity graph files for ${payload.entity}:`];
  for (const file of payload.files) {
    lines.push(`- ${file.created ? 'created' : 'exists'} ${file.kind}: ${file.path}`);
  }
  lines.push('', 'Next commands:');
  lines.push(...payload.next_commands.map((entry) => `- ${entry.command}`));
  return `${lines.join('\n')}\n`;
}

function scaffoldHandler(entity: string, options: ScaffoldOptions): void {
  const paths = resolveEntityGraphScaffoldPaths();
  const files: WrittenScaffoldFile[] = [];
  const format = resolveFormat(options);
  const formatFlag = format === 'json' ? '--json' : format === 'yaml' ? '--yaml' : '';
  const withFormatFlag = (command: string): string =>
    formatFlag.length > 0 ? `${command} ${formatFlag}` : command;
  if (!options.skipResolution) {
    files.push(writeStarterResolutionSpec(paths, entity));
  }
  if (!options.skipOntology) {
    files.push(writeStarterOntology(paths, entity));
  }
  if (!options.skipMentions) {
    files.push(writeStarterMentionExtraction(paths, entity));
  }
  if (!options.skipRelationships) {
    files.push(writeStarterRelationshipExtraction(paths, entity));
  }

  const payload: ScaffoldPayload = {
    command: 'entity-graph.scaffold',
    entity,
    entity_graph_dir: paths.entityGraphDir,
    files,
    next_commands: [
      {
        label: 'validate_resolution',
        command: withFormatFlag(`bobsled entity-graph resolve validate ${entity}`),
      },
      {
        label: 'preview_resolution_sql',
        command: withFormatFlag(`bobsled entity-graph resolve compile ${entity}`),
      },
      {
        label: 'preview_relationship_contract',
        command: withFormatFlag(`bobsled entity-graph relationships review export`),
      },
    ],
  };
  emitEntityGraphPayload(payload, format, () => renderScaffoldText(payload));
}

export function registerScaffoldCommand(program: Command): void {
  const scaffold = program
    .command('scaffold')
    .description('Create resolution, ontology, mention, and relationship starter specs')
    .argument('<entity>', 'Entity name')
    .option('--skip-resolution', 'Do not create a resolution spec')
    .option('--skip-ontology', 'Do not create a relationship ontology spec')
    .option('--skip-mentions', 'Do not create a mention extraction spec')
    .option('--skip-relationships', 'Do not create a relationship extraction spec')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .action((entity: string, opts: ScaffoldOptions) => scaffoldHandler(entity, opts));
  registerScaffoldDocumentCommand(scaffold);
}
