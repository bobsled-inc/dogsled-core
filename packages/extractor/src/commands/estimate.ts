import type { Command } from 'commander';

import { ControlLogger } from '../runtime/control.js';
import { resolveExtractIntentPlan } from '../runtime/extract-intents.js';

import { buildCommandContext, parseGlobalFlags } from './common.js';

interface EstimateOptions {
  plan: string;
  format?: 'text' | 'json';
}

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Estimate billable extract spend for a named plan')
    .requiredOption('--plan <name>', 'Plan name from extract-intents.yml')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (opts: EstimateOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);

      try {
        const resolved = await resolveExtractIntentPlan(ctx, opts.plan);
        for (const warning of resolved.warnings) {
          await logger.warn(`extract-intents manifest: normalized key: ${warning}`);
        }

        for (const step of resolved.steps) {
          await logger.metric(step.step.id, {
            estimated_requests: step.estimated_requests,
            estimated_credits: step.estimated_credits,
            estimate_confidence: step.estimate_confidence,
            seed_rows_total: step.seed_rows_total,
            seed_rows_executed: step.seed_rows_executed,
          });
        }

        if (opts.format === 'json') {
          process.stdout.write(
            JSON.stringify(
              {
                plan: resolved.planName,
                description: resolved.plan.description,
                budget: resolved.plan.budget,
                totals: {
                  estimated_requests: resolved.total_estimated_requests,
                  estimated_credits: resolved.total_estimated_credits,
                  estimate_confidence: resolved.estimate_confidence,
                },
                steps: resolved.steps.map((step) => ({
                  id: step.step.id,
                  integration: step.step.integration,
                  resource: step.step.resource,
                  seed: step.step.seed,
                  estimated_requests: step.estimated_requests,
                  estimated_credits: step.estimated_credits,
                  estimate_confidence: step.estimate_confidence,
                  seed_rows_total: step.seed_rows_total,
                  seed_rows_executed: step.seed_rows_executed,
                })),
              },
              null,
              2
            ) + '\n'
          );
          return;
        }

        await logger.info(
          `Estimate for ${resolved.planName}: ${resolved.total_estimated_credits} credit(s), ${resolved.total_estimated_requests} request(s), confidence=${resolved.estimate_confidence}`
        );
        for (const step of resolved.steps) {
          await logger.info(
            `  ${step.step.id}: ${step.estimated_credits} credit(s), ${step.estimated_requests} request(s), confidence=${step.estimate_confidence}`
          );
        }
      } finally {
        await logger.close();
      }
    });
}
