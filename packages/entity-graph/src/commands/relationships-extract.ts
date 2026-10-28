import { Command } from 'commander';
import { RelationshipExtractionSpecSchema } from '@bobsled-inc/model-spec';
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
import { extractRelationshipsProject } from '../api/relationship-extract-project.js';

export interface RelationshipsExtractOptions {
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

export async function runRelationshipsExtract(
  entity: string,
  options: RelationshipsExtractOptions = {}
): Promise<ExtractCommandResult> {
  const schema = options.schema ?? 'entity_graph';
  const specDir = resolveExtractionSpecDir(options);
  const specs = discoverTypedSpecs(
    specDir,
    'relationship_extraction',
    RelationshipExtractionSpecSchema
  )
    .filter((spec) => spec.name === entity || spec.name.startsWith(`${entity}_`))
    .map((spec) => ({ name: spec.name, path: spec.filePath }));

  const base: ExtractCommandResult = {
    ok: true,
    command: 'entity-graph.relationships.extract',
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
  return extractRelationshipsProject({
    ...options,
    entity,
    ...(options.runner ? { runner: options.runner } : {}),
    specDir: options.specDir,
    schema,
    fallback: options.fallback,
    concurrency: options.concurrency,
  });
}

export function registerRelationshipsExtractCommand(
  parent: Command,
  options: RelationshipsExtractOptions = {}
): void {
  parent
    .command('extract')
    .description('Extract document-derived relationships into __entity_relationship_evidence')
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
          fallback?: string;
          concurrency?: number;
          dryRun: boolean;
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
          const result = await runRelationshipsExtract(entity, {
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
