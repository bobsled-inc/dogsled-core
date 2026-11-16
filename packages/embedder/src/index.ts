#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { EXIT_VALIDATION } from '@bobsled-inc/protocol';

import { handleRunError, inferEmbedderLogOptions, registerRunCommand } from './commands/run.js';

declare const __CLI_VERSION__: string | undefined;

const cliVersion = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev';

export {
  createEmbedConfigSchema,
  EmbedderConfigSchema,
  EmbedFieldConfigSchema,
  EmbedStreamsSchema,
} from './config.js';
export { buildEmbedderConfigInput, parseEmbedderConfig } from './commands/run.js';
export { outputColumnName } from './output-column.js';
export type { EmbedFieldConfig, EmbedderConfig } from './config.js';
export type { RunEmbedCommandDependencies } from './commands/run.js';
export { rewriteBatch } from './runtime/batch-rewriter.js';
export {
  buildWarnLogMessage,
  enrichSchema,
  runEmbedder,
  writeStructuredLog,
} from './runtime/processor.js';
export { countTokens, MAX_EMBEDDING_TOKENS, truncateToTokens } from './runtime/tokenizer.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('bobsled embed')
    .version(cliVersion, '-V, --version', 'Display the CLI version')
    .description('Bobsled Core Embedder — enrich protocol streams with vector embeddings')
    .showHelpAfterError()
    .exitOverride();

  registerRunCommand(program);

  return program;
}

const KNOWN_SUBCOMMANDS = new Set(['run', 'help']);

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const requestedLogOptions = inferEmbedderLogOptions(argv);

  try {
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
    await buildProgram().parseAsync(['node', 'bobsled embed', ...effectiveArgv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? 0 : EXIT_VALIDATION;
      return;
    }

    handleRunError(error, process.stderr, requestedLogOptions);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await runCli();
}
