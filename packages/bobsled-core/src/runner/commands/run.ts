import { Command } from 'commander';

import { CommandError } from '@bobsled-inc/protocol';

import * as fmt from '../../lib/output/formatter.js';
import { runProjectPipeline } from '../../pipeline/index.js';
import type { GlobalOptions } from '../../types/index.js';
import { resolveCliBobsledProject } from '../config/cli-project-location.js';

interface RunnerOutputFlagOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface RunCommandOptions extends RunnerOutputFlagOptions {
  config?: string;
  projectRoot?: string;
  fullRefresh?: boolean;
  reconcileSchema?: string[];
  resource?: string[];
}

function buildOutputOptions(
  opts: RunnerOutputFlagOptions,
  globalOpts: GlobalOptions
): ReturnType<typeof fmt.toOutputOptions> {
  return fmt.toOutputOptions({
    ...globalOpts,
    json: opts.json ?? globalOpts.json,
    verbose: opts.verbose ?? globalOpts.verbose,
    quiet: opts.quiet ?? globalOpts.quiet,
  });
}

export function registerRunCommand(runner: Command): void {
  runner
    .command('run <pipeline>')
    .description('Run a single pipeline from bobsled.yml')
    .option('--config <path>', 'Path to bobsled.yml')
    .option('--project-root <path>', 'Dogsled Project root (default: current directory)')
    .option('--full-refresh', 'Ignore bookmarks and extract from the beginning')
    .option(
      '--reconcile-schema <stream...>',
      'One-shot Snowflake schema reconciliation (requires --full-refresh)'
    )
    .option('--resource <name...>', 'Specific resources to extract')
    .option('--json', 'Output machine-readable JSON logs')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (pipelineName: string, opts: RunCommandOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const runnerOpts = {
        ...opts,
        json: opts.json ?? globalOpts.json,
        verbose: opts.verbose ?? globalOpts.verbose,
        quiet: opts.quiet ?? globalOpts.quiet,
      };
      const _outputOpts = buildOutputOptions(runnerOpts, globalOpts);
      const configPath = opts.config ?? globalOpts.config;
      const project = resolveCliBobsledProject({
        configPath,
        projectRoot: opts.projectRoot ?? globalOpts.projectRoot,
      });
      if (!project) {
        throw new CommandError(
          'No Dogsled Project found. Pass --project-root <path> to select one.',
          2
        );
      }

      const result = await runProjectPipeline({
        projectRoot: project.projectRoot,
        ...(configPath ? { configPath: project.configPaths[0]! } : {}),
        pipelineName,
        ...(runnerOpts.resource ? { resources: runnerOpts.resource } : {}),
        ...(runnerOpts.fullRefresh ? { fullRefresh: true } : {}),
        ...(runnerOpts.reconcileSchema ? { reconcileSchema: runnerOpts.reconcileSchema } : {}),
        ...(runnerOpts.json ? { logFormat: 'json' } : {}),
        ...(runnerOpts.verbose ? { verbose: true } : {}),
        ...(runnerOpts.quiet ? { quiet: true } : {}),
      });

      process.exitCode = result.exitCode;
    });
}
