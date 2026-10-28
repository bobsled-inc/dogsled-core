import { Command } from 'commander';
import { MentionExtractionSpecSchema } from '@bobsled-inc/model-spec';
import { parsePositiveIntOption } from '@bobsled-inc/model-spec/shared';
import {
  CommandError,
  emitError,
  emitPayload,
  resolveOutputFormat,
  type Writer,
} from '@bobsled-inc/protocol';

import { resolveCommandWriter } from './utils.js';
import {
  discoverTypedSpecs,
  isAiFailure,
  normalizeAiRuntimeFailure,
  renderExtractHuman,
  resolveExtractionSpecDir,
  type AiRuntimeFailure,
  type ExtractCommandResult,
} from './extract-command-utils.js';
import { extractMentionsProject } from '../api/mention-extract-project.js';

export interface MentionsExtractOptions {
  writer?: Writer;
  cwd?: string;
  runner?: string;
  integration?: string;
  specDir?: string;
  schema?: string;
  fallback?: string;
  concurrency?: number;
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  extractor?: () => Promise<ExtractCommandResult | ({ ok: false } & AiRuntimeFailure)>;
}

export async function runMentionsExtract(
  entity: string,
  options: MentionsExtractOptions = {}
): Promise<ExtractCommandResult> {
  const schema = options.schema ?? 'entity_graph';
  const specDir = resolveExtractionSpecDir(options);
  const specs = discoverTypedSpecs(specDir, 'mention_extraction', MentionExtractionSpecSchema)
    .filter((spec) => spec.entity_types.includes(entity) || spec.name === entity)
    .map((spec) => ({ name: spec.name, path: spec.filePath }));

  const base: ExtractCommandResult = {
    ok: true,
    command: 'entity-graph.mentions.extract',
    entity,
    schema,
    dry_run: options.dryRun === true,
    executed: false,
    spec_count: specs.length,
    specs,
    chunks_processed: 0,
    count: 0,
    by_resolution_method: {},
    budget_used: 0,
  };

  if (options.dryRun) return base;
  if (options.extractor) {
    const result = await options.extractor();
    if (isAiFailure(result)) throw normalizeAiRuntimeFailure(result);
    return result;
  }
  return extractMentionsProject({
    ...options,
    entity,
    ...(options.runner ? { runner: options.runner } : {}),
    specDir: options.specDir,
    schema,
    fallback: options.fallback,
    concurrency: options.concurrency,
  });
}

export function registerMentionsExtractCommand(
  parent: Command,
  options: MentionsExtractOptions = {}
): void {
  parent
    .command('extract')
    .description('Extract document mentions into __document_mentions')
    .argument('<entity>', 'Entity name')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--integration <handle>', 'Integration handle for project resolution')
    .option('--spec-dir <path>', 'Legacy entity graph spec directory')
    .option('--schema <name>', 'Schema containing entity graph tables', options.schema)
    .option(
      '--fallback <mode>',
      'Fallback extraction mode when LLM is unavailable (compromise|none)',
      options.fallback
    )
    .option('--concurrency <n>', 'Maximum concurrent LLM calls', parsePositiveIntOption)
    .option('--dry-run', 'Validate specs and print the extraction plan without executing', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .option('--verbose', 'Verbose logging', false)
    .option('--quiet', 'Suppress non-error output', false)
    .action(
      async (
        entity: string,
        opts: {
          runner?: string;
          integration?: string;
          specDir?: string;
          schema?: string;
          dryRun: boolean;
          fallback?: string;
          concurrency?: number;
          json: boolean;
          yaml: boolean;
          verbose: boolean;
          quiet: boolean;
        }
      ) => {
        const format = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        const quiet = opts.quiet || options.quiet === true;
        const commandOptions = {
          ...options,
          verbose: opts.verbose || options.verbose === true,
          quiet,
        };
        const writer = resolveCommandWriter(commandOptions);
        try {
          const result = await runMentionsExtract(entity, {
            ...commandOptions,
            runner: opts.runner ?? options.runner,
            integration: opts.integration ?? options.integration,
            specDir: opts.specDir ?? options.specDir,
            schema: opts.schema ?? options.schema,
            fallback: opts.fallback ?? options.fallback,
            concurrency: opts.concurrency ?? options.concurrency,
            dryRun: opts.dryRun ?? options.dryRun,
          });
          if (!quiet) emitPayload(result, format, writer, () => renderExtractHuman(result));
        } catch (err) {
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, format, writer);
            return;
          }
          throw err;
        }
      }
    );
}
