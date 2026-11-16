/**
 * `bobsled extract verify` command.
 *
 * Offline verification for integrations: schema/quality checks plus
 * optional OpenAPI drift detection when an `openapi_url` is available.
 */

import type { Command } from 'commander';

import { ControlLogger } from '../runtime/control.js';

import {
  CommandError,
  buildCommandContext,
  findAllAvailableIntegrations,
  parseGlobalFlags,
} from './common.js';
import { formatSummary, verifyIntegration } from './verify-runner.js';
import {
  parseSeverity,
  severityAtOrAbove,
  type VerifyIntegrationResult,
  type VerifyOptions,
} from './verify-shared.js';

function summarizeJson(
  results: VerifyIntegrationResult[],
  threshold: ReturnType<typeof parseSeverity>
) {
  const filtered = results.map((result) => ({
    ...result,
    findings: result.findings.filter((finding) => severityAtOrAbove(finding.severity, threshold)),
  }));

  return {
    integrations: filtered,
    summary: {
      integrations: filtered.length,
      errors: filtered
        .flatMap((result) => result.findings)
        .filter((finding) => finding.severity === 'error').length,
      warnings: filtered
        .flatMap((result) => result.findings)
        .filter((finding) => finding.severity === 'warn').length,
    },
  };
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description(
      'Verify integration specs offline, including quality checks and OpenAPI drift when available'
    )
    .argument('[target]', 'Integration name or integration/resource to verify')
    .option('--check-env', 'Warn when referenced env vars are not set')
    .option('--mock', 'Run fixture-backed mock extraction checks for HTTP resources')
    .option('--openapi <url>', 'Override OpenAPI spec URL/path for a single integration')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--severity <level>', 'Minimum severity to report: error, warn, or info', 'warn')
    .action(async (target: string | undefined, opts: VerifyOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);

      try {
        const threshold = parseSeverity(opts.severity ?? 'warn');
        const targetIntegration = target?.split('/')[0];
        const targetResource = target?.includes('/') ? target.split('/')[1] : undefined;
        const integrationNames = targetIntegration
          ? [targetIntegration]
          : findAllAvailableIntegrations(ctx.project, ctx.bundledIntegrationsDir);

        if (integrationNames.length === 0) {
          throw new CommandError('No integrations found to verify.');
        }
        if (opts.openapi && integrationNames.length > 1) {
          throw new CommandError('--openapi can only be used when verifying a single integration.');
        }

        const results: VerifyIntegrationResult[] = [];
        for (const integrationName of integrationNames) {
          results.push(await verifyIntegration(ctx, integrationName, targetResource, opts));
        }

        if (opts.format === 'json') {
          process.stdout.write(`${JSON.stringify(summarizeJson(results, threshold), null, 2)}\n`);
        } else {
          process.stderr.write(formatSummary(results, threshold));
        }

        const hasErrors = results.some((result) =>
          result.findings.some((finding) => finding.severity === 'error')
        );
        if (hasErrors) {
          process.exitCode = 2;
        }
      } finally {
        await logger.close();
      }
    });
}
