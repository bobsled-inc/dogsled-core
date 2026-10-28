#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerAssertCommand } from './commands/assert.js';
import { registerCheckCommand } from './commands/check.js';
import { registerQueryCommand } from './commands/query.js';
import { handleRunError, registerRunCommand } from './commands/run.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dogsled load')
    .version('0.0.1')
    .description('Dogsled Loader — convert extractor protocol streams into destination files')
    .showHelpAfterError();

  registerRunCommand(program);
  registerAssertCommand(program);
  registerCheckCommand(program);
  registerQueryCommand(program);

  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const KNOWN_SUBCOMMANDS = new Set(['run', 'assert', 'check', 'query', 'help']);

  const argv = process.argv.slice(2);
  const firstArg = argv[0];
  const shouldInjectRun =
    argv.length === 0 ||
    (firstArg !== undefined &&
      !KNOWN_SUBCOMMANDS.has(firstArg) &&
      firstArg !== '--help' &&
      firstArg !== '-h' &&
      firstArg !== '--version' &&
      firstArg !== '-V');
  const effectiveArgv = shouldInjectRun ? ['run', ...argv] : argv;

  try {
    await buildProgram().parseAsync(['node', 'dogsled load', ...effectiveArgv]);
  } catch (error) {
    handleRunError(error);
  }
}
