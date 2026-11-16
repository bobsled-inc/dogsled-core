/**
 * `bobsled extract check` command.
 *
 * Diff integration + resource YAML specs against an OpenAPI document
 * to detect drift: missing endpoints, type mismatches, pagination
 * changes, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';

import { ControlLogger } from '../runtime/control.js';
import { parseOpenApiSpec } from '../runtime/openapi-mapper.js';

import type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  IntegrationSpec,
  ResourceSpec,
} from '../types/index.js';
import {
  CommandError,
  buildCommandContext,
  findIntegrationFile,
  findResourceFiles,
  loadIntegrationSpec,
  loadResourceSpec,
  parseGlobalFlags,
  resolveOpenApiSource,
} from './common.js';
import { diffIntegration, diffQueryBindings } from './check-diff.js';

type Severity = 'error' | 'warn' | 'info';

interface CheckOptions {
  openapi?: string;
  format?: 'text' | 'json';
  severity?: Severity;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

const SEVERITY_COLORS: Record<Severity, (text: string) => string> = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.blue,
};

function severityAtOrAbove(finding: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[finding] <= SEVERITY_ORDER[threshold];
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check integration specs against an OpenAPI document for drift')
    .argument('<integration>', 'Integration name')
    .argument('[resource]', 'Optional resource name to check (default: all)')
    .option('--openapi <url>', 'Path or URL to OpenAPI spec (JSON/YAML)')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--severity <level>', 'Minimum severity to report: error, warn, or info', 'info')
    .action(
      async (integrationName: string, resourceName: string | undefined, opts: CheckOptions) => {
        const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
        const logger = new ControlLogger(ctx);

        try {
          // Load integration spec
          const integrationFile = findIntegrationFile(
            ctx.project,
            integrationName,
            ctx.bundledIntegrationsDir
          );
          const integrationSpec: IntegrationSpec = loadIntegrationSpec(integrationFile);

          // Load resource specs
          const resourceFiles = findResourceFiles(ctx, integrationName);

          if (resourceFiles.length === 0) {
            throw new CommandError(`No resources found for integration "${integrationName}"`);
          }

          const resources: ResourceSpec[] = [];
          for (const resourceFile of resourceFiles) {
            const spec = loadResourceSpec(resourceFile);
            if (resourceName) {
              const name = path.basename(resourceFile, path.extname(resourceFile));
              if (name !== resourceName && spec.name !== resourceName) continue;
            }
            resources.push(spec);
          }

          if (resources.length === 0 && resourceName) {
            throw new CommandError(
              `Resource "${resourceName}" not found for integration "${integrationName}"`
            );
          }

          // Resolve OpenAPI spec source: --openapi flag > meta.yml openapi_url > error
          let openApiSource = opts.openapi;
          if (!openApiSource) {
            // Try meta.yml in the same directory as the integration file
            const metaPath = path.join(path.dirname(integrationFile), 'meta.yml');
            try {
              const metaContent = fs.readFileSync(metaPath, 'utf-8');
              const meta = parseYaml(metaContent) as Record<string, unknown> | null;
              if (meta && typeof meta['openapi_url'] === 'string') {
                openApiSource = resolveOpenApiSource(meta['openapi_url'], path.dirname(metaPath));
                await logger.info(`Using OpenAPI URL from meta.yml: ${openApiSource}`);
              }
            } catch {
              // meta.yml not found or unparseable — fall through to error
            }
          }
          if (!openApiSource) {
            throw new CommandError(
              'No OpenAPI spec provided. Use --openapi <url-or-path>, or add openapi_url to meta.yml.'
            );
          }

          openApiSource = resolveOpenApiSource(openApiSource, path.dirname(integrationFile));

          await logger.info(`Loading OpenAPI spec from: ${openApiSource}`);
          const openApiDoc = await parseOpenApiSpec(openApiSource);

          // Run diff
          const allFindings = diffIntegration(
            integrationSpec as ApiIntegrationSpec,
            resources as ApiResourceSpec[],
            openApiDoc
          );
          const queryFindings = diffQueryBindings(
            integrationSpec as ApiIntegrationSpec,
            resources as ApiResourceSpec[],
            openApiDoc
          );
          const combinedFindings = [...allFindings, ...queryFindings];

          // Filter by severity
          const threshold: Severity = opts.severity ?? 'info';
          const findings = combinedFindings.filter((f) => severityAtOrAbove(f.severity, threshold));

          // `check` is the drift-detection command — any error-level finding
          // (OpenAPI diff or query binding) represents drift, which has its
          // own exit code distinct from runtime/validation failures.
          // Exit codes: 0 success, 1 runtime, 2 validation, 3 drift.
          const DRIFT_EXIT_CODE = 3;

          // Output
          if (opts.format === 'json') {
            const errorCount = findings.filter((f) => f.severity === 'error').length;
            const warnCount = findings.filter((f) => f.severity === 'warn').length;
            const infoCount = findings.filter((f) => f.severity === 'info').length;

            process.stdout.write(
              JSON.stringify(
                {
                  integration: integrationName,
                  resources_checked: resources.length,
                  findings,
                  summary: { errors: errorCount, warnings: warnCount, info: infoCount },
                },
                null,
                2
              ) + '\n'
            );

            if (errorCount > 0) {
              process.exitCode = DRIFT_EXIT_CODE;
            }
            return;
          }

          // Text output
          if (findings.length === 0) {
            await logger.info(
              `Checked ${resources.length} resource(s) against OpenAPI spec — no issues found`
            );
            return;
          }

          const lines: string[] = [''];
          lines.push(
            chalk.bold(`Check results for ${integrationName} (${resources.length} resource(s))`)
          );
          lines.push('');

          for (const finding of findings) {
            const color = SEVERITY_COLORS[finding.severity];
            const label = color(finding.severity.toUpperCase().padEnd(5));
            const fieldSuffix = finding.field ? `.${finding.field}` : '';
            lines.push(`  ${label}  ${chalk.dim(finding.code)}  ${finding.resource}${fieldSuffix}`);
            lines.push(`         ${finding.message}`);
          }

          lines.push('');

          const errorCount = findings.filter((f) => f.severity === 'error').length;
          const warnCount = findings.filter((f) => f.severity === 'warn').length;
          const infoCount = findings.filter((f) => f.severity === 'info').length;
          const parts: string[] = [];
          if (errorCount > 0) parts.push(chalk.red(`${errorCount} error(s)`));
          if (warnCount > 0) parts.push(chalk.yellow(`${warnCount} warning(s)`));
          if (infoCount > 0) parts.push(chalk.blue(`${infoCount} info`));
          lines.push(`  ${parts.join(', ')}`);
          lines.push('');

          process.stderr.write(lines.join('\n') + '\n');

          if (errorCount > 0) {
            process.exitCode = DRIFT_EXIT_CODE;
          }
        } finally {
          await logger.close();
        }
      }
    );
}
