/**
 * `bobsled model seed` command group — thin CLI wrappers over the seed API.
 *
 * All seed business logic (parse/validate/codegen/diff) lives in
 * `../api/seed-project.ts`. This file owns only arg parsing, runner loading,
 * and CLI-specific text/JSON output.
 *
 * Exit codes:
 *   0 = success
 *   2 = validation error
 *   3 = drift detected (seed diff only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';

import type { Command } from 'commander';

import { diffSeeds, loadSeeds, validateSeeds, type SeedLoadEntry } from '../api/seed-project.js';
import { type SupportedDialect } from '../compiler/index.js';
import { loadProjectConfig, resolveConfig } from '../config.js';
import { CommandError } from '../errors.js';
import * as out from '../output.js';

import {
  createDialectOption,
  loadRunnerModule,
  parseGlobalFlags,
  resolvePathWithinDir,
  validateScaffoldName,
} from './common.js';

// ---------------------------------------------------------------------------
// Validate handler
// ---------------------------------------------------------------------------

interface ValidateOptions {
  dir?: string;
  json?: boolean;
}

function validateHandler(
  options: ValidateOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const flags = parseGlobalFlags(globalOptions);
  const result = validateSeeds(process.cwd(), { seedsDir: options.dir });

  const errorCount =
    result.seeds.filter((s) => s.status === 'invalid').length +
    result.bareCsvFiles.filter((file) => file.error !== undefined).length;

  if (!options.json) {
    for (const s of result.seeds) {
      if (s.status === 'valid') {
        if (!flags.quiet) {
          process.stderr.write(
            chalk.green(`✓ ${s.name}`) + ` (${s.rowCount} rows, ${s.columnCount} columns)\n`
          );
        }
      } else {
        process.stderr.write(chalk.red(`✗ ${s.name}`) + `: ${s.error}\n`);
      }
    }
    for (const file of result.bareCsvFiles) {
      if (file.error === undefined) {
        if (!flags.quiet) {
          process.stderr.write(
            chalk.green(`✓ ${file.path}`) +
              ` (${file.rowCount ?? 0} rows, ${file.headers?.length ?? 0} columns; no seed spec)\n`
          );
        }
      } else {
        process.stderr.write(chalk.red(`✗ ${file.path}`) + `: ${file.error}\n`);
      }
    }
    process.stderr.write(
      `\nValidated ${result.seeds.length} named seed(s) and ${result.bareCsvFiles.length} bare CSV file(s)${errorCount > 0 ? ` with ${errorCount} error(s)` : ''}.\n`
    );
  } else {
    out.json({
      command: 'seed.validate',
      seed_count: result.seeds.length,
      error_count: errorCount,
      seeds: result.seeds.map((s) => ({
        name: s.name,
        status: s.status,
        csv_path: s.csvPath,
        row_count: s.rowCount,
        column_count: s.columnCount,
        issues: s.status === 'valid' ? [] : undefined,
        error: s.error,
      })),
      bare_csv_count: result.bareCsvFiles.length,
      bare_csv_files: result.bareCsvFiles,
    });
  }

  if (!result.ok) {
    throw new CommandError(
      `Seed validation failed with ${errorCount} error(s).`,
      result.exitCode || 2
    );
  }
}

// ---------------------------------------------------------------------------
// Init handler (unchanged — pure scaffolding, no library counterpart needed)
// ---------------------------------------------------------------------------

function initHandler(name: string, globalOptions: { verbose?: boolean; quiet?: boolean }): void {
  const safeName = validateScaffoldName(name, 'Seed name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const seedsDir = path.join(cwd, resolved.seedsDir);
  const dataDir = path.join(seedsDir, 'data');
  const specPath = resolvePathWithinDir(seedsDir, `${safeName}.yml`, 'Seed spec path');
  const csvPath = resolvePathWithinDir(dataDir, `${safeName}.csv`, 'Seed CSV path');

  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(specPath) || fs.existsSync(csvPath)) {
    throw new CommandError(`Seed scaffold already exists for ${safeName}.`, 2);
  }

  fs.writeFileSync(
    specPath,
    [
      `spec_version: '0.2'`,
      `name: ${safeName}`,
      `type: seed`,
      `description: Seed data for ${safeName}.`,
      ``,
      `payload:`,
      `  format: csv`,
      `  path: data/${safeName}.csv`,
      ``,
      `schema:`,
      `  columns:`,
      `    - name: id`,
      `      type: STRING`,
      `      primary_key: true`,
      `    - name: value`,
      `      type: STRING`,
      ``,
      `validation:`,
      `  required_columns: [id, value]`,
      `  unique_columns: [id]`,
      ``,
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(csvPath, 'id,value\n', 'utf-8');

  if (!globalOptions.quiet) {
    out.success(`Created seed scaffold ${name}`);
    out.info(specPath);
    out.info(csvPath);
  }
}

// ---------------------------------------------------------------------------
// Load handler
// ---------------------------------------------------------------------------

interface LoadOptions {
  dialect?: string;
  dir?: string;
  schema?: string;
  runner?: string;
  json?: boolean;
}

async function loadHandler(
  options: LoadOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);
  const runner = options.runner ? (await loadRunnerModule(options.runner)).run : undefined;

  const result = await loadSeeds(process.cwd(), {
    dialect: options.dialect as SupportedDialect | undefined,
    seedsDir: options.dir,
    schema: options.schema,
    runner,
  });

  if (!options.json) {
    for (const s of result.seeds) {
      if (s.error) {
        out.error(`Seed load failed for ${s.name}: ${s.error}`);
        continue;
      }
      if (s.executed) {
        if (!flags.quiet) out.info(`Executing seed ${s.name}...`);
        out.success(`Loaded seed ${s.name}: ${s.rowsLoaded} rows`);
      } else if (s.sql) {
        out.text(`-- seed: ${s.name}\n${s.sql}\n\n`);
        out.success(`Compiled seed ${s.name}: ${s.rowsLoaded} rows`);
      }
    }
  } else {
    out.json({
      command: 'seed.load',
      dialect: result.dialect,
      schema: result.schema,
      seeds: result.seeds.map((s: SeedLoadEntry) => ({
        name: s.name,
        schema: s.schema,
        executed: s.executed,
        rows_loaded: s.rowsLoaded,
        rows_affected: s.rowsAffected,
        sql: s.sql,
        issues: s.error ? undefined : [],
        error: s.error,
      })),
    });
  }

  if (!result.ok) {
    throw new CommandError('Seed load failed.', result.exitCode || 1);
  }
}

// ---------------------------------------------------------------------------
// Diff handler
// ---------------------------------------------------------------------------

interface DiffOptions {
  dir?: string;
  json?: boolean;
  runner?: string;
  schema?: string;
  dialect?: string;
}

async function diffHandler(
  options: DiffOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  if (!options.runner) {
    if (options.json) {
      out.json({
        command: 'seed.diff',
        implemented: false,
        requires_runner: true,
      });
      process.exitCode = 2;
      return;
    }
    throw new CommandError('--runner is required for seed diff.', 2);
  }

  const flags = parseGlobalFlags(globalOptions);
  const runnerModule = await loadRunnerModule(options.runner);
  if (runnerModule.query == null) {
    throw new CommandError('Seed diff requires a runner module with query(sql).', 2);
  }

  const result = await diffSeeds(process.cwd(), {
    dialect: options.dialect as SupportedDialect | undefined,
    seedsDir: options.dir,
    schema: options.schema,
    query: runnerModule.query,
  });

  if (options.json) {
    out.json({
      command: 'seed.diff',
      dialect: result.dialect,
      schema: result.schema,
      seeds: result.seeds.map((s) => ({
        name: s.name,
        schema: s.schema,
        unique_columns: s.uniqueColumns,
        add_count: s.addCount,
        update_count: s.updateCount,
        delete_count: s.deleteCount,
        adds: s.adds,
        updates: s.updates,
        deletes: s.deletes,
      })),
    });
  } else {
    for (const s of result.seeds) {
      const total = s.addCount + s.updateCount + s.deleteCount;
      if (!flags.quiet) {
        out.info(
          `${s.name}: ${s.addCount} add(s), ${s.updateCount} update(s), ${s.deleteCount} delete(s)` +
            (total === 0 ? ' (in sync)' : '')
        );
      }
    }
  }

  if (result.hasDrift) {
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSeedCommand(program: Command): void {
  const seed = program.command('seed').description('Manage reference data (seeds)');

  seed
    .command('init')
    .description('Scaffold a new seed spec and CSV')
    .argument('<name>', 'Seed name')
    .action((name: string) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initHandler(name, globalOptions);
    });

  seed
    .command('validate')
    .description('Validate seed specs and CSV files')
    .option('--dir <path>', 'Override the seed folder relative to the Project root')
    .option('--json', 'Output results as JSON to stdout')
    .action((opts: ValidateOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      validateHandler(opts, globalOptions);
    });

  seed
    .command('load')
    .description('Compile seed SQL or execute it with a runner')
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--dir <path>', 'Override the seed folder relative to the Project root')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: LoadOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await loadHandler(opts, globalOptions);
    });

  seed
    .command('diff')
    .description('Compare warehouse table with local CSV')
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--dir <path>', 'Override the seed folder relative to the Project root')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: DiffOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await diffHandler(opts, globalOptions);
    });
}
