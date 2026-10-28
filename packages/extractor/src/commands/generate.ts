/**
 * `dogsled extract generate` command.
 *
 * Auto-generate extractor specs from an OpenAPI 3.x document.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import { ControlLogger } from '../runtime/control.js';
import { generateFromOpenApi, type GenerateResult } from '../runtime/openapi-mapper.js';

import { CommandError, SAFE_NAME_RE, parseGlobalFlags } from './common.js';

interface GenerateOpts {
  integration?: string;
  directory: string;
  tags?: string;
  force?: boolean;
  dryRun?: boolean;
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description('Generate extractor specs from an OpenAPI document')
    .argument('<source>', 'Path to OpenAPI spec (JSON/YAML) or HTTPS URL')
    .option('--integration <name>', 'Integration name override (default: inferred from spec)')
    .option('--directory <dir>', 'Output directory', '.')
    .option('--tags <tags>', 'Only endpoints with these tags (comma-separated)')
    .option('--force', 'Overwrite existing files')
    .option('--dry-run', "Print YAML to stdout, don't write files")
    .action(async (source: string, opts: GenerateOpts) => {
      const logger = new ControlLogger(parseGlobalFlags(program.opts()));

      try {
        if (opts.integration && !SAFE_NAME_RE.test(opts.integration)) {
          throw new CommandError(
            `Invalid integration name "${opts.integration}". Must be lowercase snake_case (e.g. my_api).`
          );
        }

        const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()) : undefined;

        await logger.info(`Loading OpenAPI spec from: ${source}`);

        const result = await generateFromOpenApi(source, {
          integrationName: opts.integration,
          tags,
        });

        if (opts.dryRun) {
          // Print all YAML to stdout
          process.stdout.write(`# --- Integration ---\n${result.integration.yaml}\n`);
          for (const res of result.resources) {
            process.stdout.write(`# --- ${res.fileName} ---\n${res.yaml}\n`);
          }
          return;
        }

        // Write files
        const cwd = process.cwd();
        const baseDir = path.isAbsolute(opts.directory)
          ? opts.directory
          : path.resolve(cwd, opts.directory);

        // Write integration spec
        const integrationPath = path.join(baseDir, result.integration.fileName);
        await writeSpec(integrationPath, result.integration.yaml, opts.force ?? false, logger);

        // Write resource specs
        for (const res of result.resources) {
          const resPath = path.join(baseDir, res.fileName);
          await writeSpec(resPath, res.yaml, opts.force ?? false, logger);
        }

        // Print summary
        printSummary(result, baseDir, logger);
      } finally {
        await logger.close();
      }
    });
}

async function writeSpec(
  filePath: string,
  content: string,
  force: boolean,
  logger: ControlLogger
): Promise<void> {
  if (fs.existsSync(filePath) && !force) {
    await logger.warn(`File already exists, skipping: ${filePath} (use --force to overwrite)`);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function printSummary(result: GenerateResult, baseDir: string, _logger: ControlLogger): void {
  const integrationSpec = result.integration.spec as Record<string, unknown>;
  const integrationName = String(integrationSpec['name'] ?? 'unknown');

  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold('Generated extractor specs'));
  lines.push('');
  lines.push(`  ${chalk.cyan('Integration:')} ${result.integration.fileName}`);
  lines.push('');
  lines.push(`  ${chalk.cyan('Resources:')} ${result.resources.length} files`);

  for (const res of result.resources) {
    const resSpec = res.spec as Record<string, unknown>;
    const api = resSpec['api'] as Record<string, unknown> | undefined;
    const endpoint = api?.['endpoint'] ?? '';
    const lookup = resSpec['lookup'] ? chalk.dim('  (linked as lookup)') : '';
    lines.push(`    ${res.fileName.padEnd(50)} ${endpoint}${lookup}`);
  }

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.yellow('Skipped:')} ${result.skipped.length} endpoints`);
    for (const s of result.skipped) {
      lines.push(`    ${s.method} ${s.path}: ${s.reason}`);
    }
  }

  // Count warnings
  const totalWarnings =
    result.integration.warnings.length +
    result.resources.reduce((acc, r) => acc + r.warnings.length, 0);

  if (totalWarnings > 0) {
    lines.push('');
    lines.push(`  ${chalk.yellow('Warnings:')} ${totalWarnings} validation issues`);
    for (const w of result.integration.warnings) {
      lines.push(`    integration: ${w}`);
    }
    for (const res of result.resources) {
      for (const w of res.warnings) {
        lines.push(`    ${res.fileName}: ${w}`);
      }
    }
  }

  lines.push('');
  lines.push(`  ${chalk.cyan('Next steps:')}`);
  const reviewPath = path.join(baseDir, 'resources', integrationName);
  lines.push(`    1. Review: ${chalk.dim(`grep -r "# REVIEW:" ${reviewPath}/`)}`);
  lines.push(`    2. Validate: ${chalk.dim('dogsled extract validate')}`);
  lines.push(
    `    3. Run: ${chalk.dim(`dogsled extract run --integration ${integrationName} <resource>`)}`
  );
  lines.push('');

  // Use process.stderr for summary (stdout is for data)
  process.stderr.write(lines.join('\n') + '\n');
}
