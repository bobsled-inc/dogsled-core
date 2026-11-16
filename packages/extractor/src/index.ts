#!/usr/bin/env node

/**
 * Bobsled Core Extractor CLI — extract data from APIs via YAML-defined specs.
 *
 * Agent-native data ingestion: integration files define the API,
 * resource files define what to extract.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { ControlLogger } from './runtime/control.js';
import { CommandError, parseLogFormat, parseProcessGlobalFlags } from './commands/common.js';
import { getErrorMessage } from './framework/core/shared.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerInitCommand } from './commands/init.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerEstimateCommand } from './commands/estimate.js';
import { registerLookupCommand } from './commands/lookup.js';
import { registerTopupCommand } from './commands/topup.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerCheckCommand } from './commands/check.js';
import { registerScaffoldTestCommand } from './commands/scaffold-test.js';
import { registerHealthCheckCommand } from './commands/health-check.js';
import { registerCommitStateCommand } from './commands/commit-state.js';
import { registerActivateCommand } from './commands/activate.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerMcpCommand } from './commands/mcp/index.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('bobsled extract')
    .version('0.0.1')
    .description('Bobsled Core Extractor — extract data from APIs into structured streams')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-format <format>', 'Control log format: json or pretty', parseLogFormat, 'json');

  registerExtractCommand(program);
  registerEstimateCommand(program);
  registerDiscoverCommand(program);
  registerValidateCommand(program);
  registerInitCommand(program);
  registerLookupCommand(program);
  registerTopupCommand(program);
  registerGenerateCommand(program);
  registerCheckCommand(program);
  registerHealthCheckCommand(program);
  registerCommitStateCommand(program);
  registerActivateCommand(program);
  registerVerifyCommand(program);
  registerScaffoldTestCommand(program);
  registerMcpCommand(program);

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await buildProgram().parseAsync();
  } catch (err) {
    const logger = new ControlLogger(parseProcessGlobalFlags(process.argv.slice(2)));

    if (err instanceof CommandError) {
      await logger.error(getErrorMessage(err));
      await logger.close();
      process.exitCode = err.exitCode;
    } else if (err instanceof Error) {
      await logger.error(getErrorMessage(err));
      await logger.close();
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
