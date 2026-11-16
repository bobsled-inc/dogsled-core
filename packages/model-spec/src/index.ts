#!/usr/bin/env node

/**
 * Dogsled Modeling CLI entrypoint.
 *
 * Standalone compiler for YAML-defined data models.
 * Emits SQL for the supported warehouse dialects.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerOssieCommand } from './commands/ossie.js';
import { registerCompileCommand } from './commands/compile.js';
import { registerDryRunCommand } from './commands/dry-run.js';
import { registerExpectCommand } from './commands/expect.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerInitCommand } from './commands/init.js';
import { registerLineageCommand } from './commands/lineage.js';
import { registerModelsCommand } from './commands/models.js';
import { registerProfileCommand } from './commands/profile.js';
import { registerRunCommand } from './commands/run.js';
import { registerSeedCommand } from './commands/seed.js';
import { registerTestCommand } from './commands/test.js';
import { registerValidateCommand } from './commands/validate.js';
import * as out from './output.js';
import { CommandError, BobsledRuntimeError } from './errors.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dogsled model')
    .version('0.0.1')
    .description('Dogsled Modeling — compile YAML data models into warehouse SQL')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output');

  registerOssieCommand(program);
  registerCompileCommand(program);
  registerDryRunCommand(program);
  registerGenerateCommand(program);
  registerRunCommand(program);
  registerProfileCommand(program);
  registerTestCommand(program);
  registerLineageCommand(program);
  registerInitCommand(program);
  registerValidateCommand(program);
  registerModelsCommand(program);
  registerSeedCommand(program);
  registerExpectCommand(program);

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await buildProgram().parseAsync();
  } catch (err) {
    if (err instanceof CommandError) {
      out.error(err.message);
      process.exitCode = err.exitCode;
    } else if (err instanceof BobsledRuntimeError && err.cause instanceof CommandError) {
      out.error(err.cause.message);
      process.exitCode = err.cause.exitCode;
    } else if (err instanceof Error) {
      out.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
