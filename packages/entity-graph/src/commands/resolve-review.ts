/**
 * `dogsled entity-graph resolve review` — the agent review phase CLI.
 *
 * Thin wrapper over `reviewResolveProject` (see `src/api/review-project.ts`),
 * split out of `resolve.ts` to respect the source-file budget.
 */

import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  out,
  createIntegrationOption,
  createDialectOption,
  parsePositiveIntOption,
} from '@bobsled-inc/model-spec/shared';

import { describeWorkflowFailure } from '../api/resolve-project.js';
import { reviewResolveProject, type ReviewResolveProjectResult } from '../api/review-project.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';

export interface ReviewCommandOptions {
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  secrets?: string;
  dryRun?: boolean;
  maxPairs?: number;
  yes?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
}

function outputFormat(options: ReviewCommandOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'text',
  });
}

/**
 * Run the agent review phase over the unreviewed gray-zone pairs for each
 * requested entity — a thin wrapper over `reviewResolveProject`.
 *
 * Judge failures are fail-soft (warnings + `failure` in the payload, exit 0);
 * decision-write (SQL) failures exit 1 like the other resolve phases.
 *
 * Exported for unit tests; CLI entry is {@link registerResolveReviewCommand}.
 */
export async function reviewHandler(
  entityNames: string[],
  options: ReviewCommandOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const structured = outputFormat(options) !== 'text';
  const context = await loadEntityGraphProjectContext({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet,
  });

  if (!options.dryRun && !options.yes) {
    const guarded = context.specs.filter((spec) => spec.agentPolicy?.confirmBeforeWrite);
    if (guarded.length > 0) {
      throw new CommandError(
        `agent_policy.confirm_before_write is set for ${guarded
          .map((spec) => spec.entity)
          .join(', ')}. Re-run with --yes to confirm the write, or use --dry-run.`,
        2
      );
    }
  }

  const results = await reviewResolveProject({
    entityNames,
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
    runner: options.runner,
    secrets: options.secrets,
    dryRun: options.dryRun,
    ...(options.maxPairs !== undefined ? { maxPairsPerRun: options.maxPairs } : {}),
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet || structured,
  });

  for (const warning of context.warnings) out.warn(warning);

  if (!structured) {
    for (const entity of results) {
      if (entity.skipped_reason) {
        out.info(`Skipped ${entity.entity}: ${entity.skipped_reason}`);
      } else if (options.dryRun) {
        out.info(
          `[dry-run] Reviewed ${entity.pairs_fetched} pair(s) for ${entity.entity}: ` +
            `${entity.applied_count} would apply, ${entity.proposed_count} proposed, ${entity.deferred_count} deferred`
        );
      } else if (!entity.failure) {
        out.success(
          `Reviewed ${entity.pairs_fetched} pair(s) for ${entity.entity}: ` +
            `${entity.applied_count} applied, ${entity.proposed_count} proposed, ${entity.deferred_count} deferred`
        );
      }
      for (const warning of entity.warnings) out.warn(warning);
      if (entity.failure) {
        out.warn(
          `${entity.entity}: review step failed: ${describeWorkflowFailure(entity.failure)}`
        );
      }
    }
  }

  const payload = {
    command: 'resolve.review',
    dialect: context.dialect,
    schema: context.targetSchema,
    entities: results satisfies ReviewResolveProjectResult[],
  };
  const format = outputFormat(options);
  if (format !== 'text') {
    emitEntityGraphPayload(payload, format, () => '');
  }

  // Judge-infra failures are fail-soft by design (undecided pairs stay in the
  // queue); only a failed decision WRITE exits non-zero, mirroring cluster.
  const writeFailure = results.find(
    (entity) =>
      entity.failure &&
      !entity.failure.failedStatements?.every((statement) =>
        statement.name.startsWith('agent_review:')
      )
  );
  if (writeFailure?.failure) {
    throw new CommandError(describeWorkflowFailure(writeFailure.failure), 1);
  }
}

/** Register `resolve review` on the resolve command group. */
export function registerResolveReviewCommand(resolve: Command, program: Command): void {
  resolve
    .command('review')
    .description('Run the agent review step over unreviewed review-queue pairs')
    .argument('[entity...]', 'Entity names to review (default: all)')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--secrets <path>', 'Path to secrets file for integration-backed execution')
    .option('--dry-run', 'Run the judge but return the decision bundle without applying')
    .option(
      '--max-pairs <count>',
      'Cap the number of pairs reviewed (overrides agent_policy.max_pairs_per_run)',
      parsePositiveIntOption
    )
    .option('--yes', 'Confirm the write when agent_policy.confirm_before_write is set')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--schema <name>', 'Target schema name')
    .addOption(createIntegrationOption())
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ReviewCommandOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await reviewHandler(entityNames, opts, globalOptions);
    });
}
