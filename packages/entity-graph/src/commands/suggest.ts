import type { Command } from 'commander';

import { createDialectOption } from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';

import { buildTruthsetContext, buildTruthsetTuneResult } from './truthset.js';
import { loadTruthsetLabels } from '../compiler/truthset/parser.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';

interface SuggestThresholdOptions {
  runner?: string;
  includeSemanticTriage?: boolean;
  dialect?: string;
  schema?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

function resolveFormat(options: SuggestThresholdOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

function renderSuggestText(payload: {
  ready: boolean;
  diagnostics: string[];
  required_next_steps: string[];
}): string {
  if (payload.ready) {
    return 'Threshold recommendations generated.\n';
  }
  return (
    [
      'Threshold recommendations are not ready.',
      ...payload.diagnostics.map((diagnostic) => `- ${diagnostic}`),
      'Required next steps:',
      ...payload.required_next_steps.map((step) => `- ${step}`),
    ].join('\n') + '\n'
  );
}

async function suggestThresholdsHandler(
  names: string[],
  options: SuggestThresholdOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const format = resolveFormat(options);
  if (!options.runner) {
    const context = buildTruthsetContext(globalOptions, options, names);
    const specs = context.specs.map((spec) => ({
      name: spec.name,
      entity: spec.entity,
      label_count: loadTruthsetLabels(spec).length,
    }));
    const diagnostics =
      specs.length === 0
        ? ['No truthset specs were found.']
        : specs.map((spec) => `${spec.name}: ${spec.label_count} label(s) available`);
    const payload = {
      command: 'entity-graph.suggest.thresholds',
      ready: false,
      dialect: context.dialect,
      truthsets: specs,
      diagnostics,
      required_next_steps: [
        'Run resolution so pair score tables exist.',
        'Pass --runner <path> so Dogsled can score truthset labels.',
        'Use the emitted recommendations only after precision targets are satisfied.',
      ],
    };
    emitEntityGraphPayload(payload, format, () => renderSuggestText(payload));
    return;
  }

  try {
    const tuneResult = await buildTruthsetTuneResult(names, options, globalOptions);
    const payload = {
      command: 'entity-graph.suggest.thresholds',
      ready: true,
      dialect: tuneResult.dialect,
      results: tuneResult.results,
      diagnostics: [],
      required_next_steps: [],
    };
    emitEntityGraphPayload(payload, format, () => renderSuggestText(payload));
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 2) {
      const payload = {
        command: 'entity-graph.suggest.thresholds',
        ready: false,
        diagnostics: [error.message],
        required_next_steps: [
          'Add truthset labels with pair_id,label rows.',
          'Run resolution so pair score tables exist.',
          'Rerun this command with --runner <path>.',
        ],
      };
      emitEntityGraphPayload(payload, format, () => renderSuggestText(payload));
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

export function registerSuggestCommand(program: Command): void {
  const suggest = program.command('suggest').description('Suggest entity graph tuning changes');

  suggest
    .command('thresholds')
    .description('Suggest resolution thresholds from truthset labels')
    .argument('[name...]', 'Truthset spec names (default: all)')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--include-semantic-triage', 'Recommend semantic triage thresholds')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (names: string[], opts: SuggestThresholdOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await suggestThresholdsHandler(names, opts, globalOptions);
    });
}
