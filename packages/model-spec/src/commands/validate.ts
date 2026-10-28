/**
 * `model validate` command — thin CLI wrapper over `validateProject`.
 *
 * Structural + metadata validation live in `../api/validate-project.ts`. This
 * file owns only arg parsing and chalked stderr formatting.
 */

import chalk from 'chalk';

import type { Command } from 'commander';

import { validateProject } from '../api/validate-project.js';
import { CommandError } from '../errors.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

interface ValidateOptions {
  strict?: boolean;
  integration?: string;
  semanticCheck?: boolean | string;
}

function parseSemanticCheck(value: boolean | string | undefined): 'warn' | 'strict' | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return 'warn';
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'warn' || normalized === 'true') return 'warn';
  if (normalized === 'strict') return 'strict';
  throw new CommandError(
    '--semantic-check must be used as --semantic-check or --semantic-check=strict'
  );
}

async function validateHandler(
  modelNames: string[],
  localOptions: ValidateOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);

  const result = await validateProject(process.cwd(), {
    integration: localOptions.integration,
    models: modelNames,
    strict: localOptions.strict ?? true,
    semanticCheck: parseSemanticCheck(localOptions.semanticCheck),
  });

  if (!flags.quiet) {
    const { metrics, relationships, entityRelationships, vqs } = result.metadata;
    if (metrics.size || relationships.size || entityRelationships.size || vqs.size) {
      process.stderr.write(
        chalk.green(
          `✓ metadata: ${metrics.size} metric(s), ${relationships.size} relationship(s), ${entityRelationships.size} entity relationship(s), ${vqs.size} VQ(s)`
        ) + '\n'
      );
    }
  }

  let totalResults = 0;
  let errorCount = 0;
  let warningCount = 0;
  let passCount = 0;

  const multi = result.byIntegration.length > 1;

  for (const group of result.byIntegration) {
    if (!flags.quiet && multi) {
      process.stderr.write(chalk.bold(`\n── integration: ${group.handle} ──`) + '\n');
    }

    for (const r of group.results) {
      if (r.errors.length > 0) {
        errorCount++;
        process.stderr.write(chalk.red(`✗ ${r.name}`) + '\n');
        for (const err of r.errors) {
          process.stderr.write(`  ${chalk.red('ERROR')}: ${err}\n`);
        }
        for (const warn of r.warnings) {
          process.stderr.write(`  ${chalk.yellow('WARNING')}: ${warn}\n`);
        }
      } else if (r.warnings.length > 0) {
        warningCount++;
        process.stderr.write(
          chalk.yellow(`⚠ ${r.name}`) +
            ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})\n`
        );
        for (const warn of r.warnings) {
          process.stderr.write(`  ${chalk.yellow('WARNING')}: ${warn}\n`);
        }
      } else {
        passCount++;
        if (!flags.quiet) {
          process.stderr.write(chalk.green(`✓ ${r.name}`) + ` (${r.columnCount} columns)\n`);
        }
      }
    }
    totalResults += group.results.length;
  }

  const parts: string[] = [];
  if (passCount > 0) parts.push(`${passCount} passed`);
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);

  process.stderr.write(`\nValidated ${totalResults} model(s): ${parts.join(', ')}\n`);

  if (errorCount > 0) {
    throw new CommandError(`Validation failed with ${errorCount} error(s).`);
  }
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate model specs for correctness without generating SQL')
    .argument('[model...]', 'Model names to validate (default: all)')
    .option('--no-strict', 'Allow implicit raw_sql fallbacks')
    .option(
      '--semantic-check [mode]',
      'Warn on missing or divergent semantic metadata; use --semantic-check=strict to fail validation'
    )
    .addOption(createIntegrationOption())
    .action(async (modelNames: string[], opts: ValidateOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await validateHandler(modelNames, opts, globalOptions);
    });
}
