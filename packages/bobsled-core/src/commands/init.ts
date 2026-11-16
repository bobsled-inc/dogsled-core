/**
 * `bobsled init` — scaffold a new Bobsled Core project.
 *
 * Initialization is always local: it creates a self-contained project that
 * boots with no account and no remote configuration. DuckLake is the default
 * destination; `--destination <kind>` selects any other supported backend.
 */

import type { Command } from 'commander';

import { runLocalInit } from './init-local.js';
import type { LocalInitOptions } from './init-local.js';
import type { GlobalOptions } from '../types/index.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new Bobsled Core project')
    .argument(
      '[project-name]',
      'Project directory name (created relative to the current directory)'
    )
    .option('--ducklake', 'Use DuckLake (default backend)')
    .option('--duckdb', 'Use DuckDB-classic instead of DuckLake')
    .option(
      '--destination <kind>',
      'Destination backend (ducklake|duckdb|postgres|snowflake|bigquery)'
    )
    // Retained as an accepted no-op so existing scripts passing --local keep
    // working; local is now the only initialization mode.
    .option('--local', 'Deprecated no-op — initialization is always local')
    .action(async (projectNameArg: string | undefined, localOptions: LocalInitOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      await runLocalInit({ ...localOptions, projectName: projectNameArg }, globalOptions);
    });
}
