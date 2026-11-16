import { Command } from 'commander';
import YAML from 'yaml';

import { CommandError } from '@bobsled-inc/protocol';

import { resolveCliBobsledProject } from '../config/cli-project-location.js';
import { validateCliProjectPipelines } from './validation.js';
import * as fmt from '../../lib/output/formatter.js';

import type { GlobalOptions } from '../../types/index.js';

export function registerRunnerValidateCommand(runner: Command): void {
  runner
    .command('validate')
    .description('Validate bobsled.yml configuration')
    .option('--config <path>', 'Path to bobsled.yml')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option('--yaml', 'Output as YAML')
    .option('--strict', 'Treat warnings as errors')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      async (
        opts: {
          config?: string;
          projectRoot?: string;
          yaml?: boolean;
          strict?: boolean;
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
        const jsonOutput = opts.json ?? globalOpts.json ?? false;
        const outputOpts = fmt.toOutputOptions({
          ...globalOpts,
          json: jsonOutput,
          verbose: opts.verbose ?? globalOpts.verbose,
          quiet: opts.quiet ?? globalOpts.quiet,
        });
        const configPath = opts.config ?? globalOpts.config;
        const project = resolveCliBobsledProject({
          configPath,
          projectRoot: opts.projectRoot ?? globalOpts.projectRoot,
        });
        if (!project) {
          throw new CommandError(
            'No Bobsled Core Project found. Pass --project-root <path> to select one.',
            2
          );
        }

        const result = await validateCliProjectPipelines({
          projectRoot: project.projectRoot,
          index: project.index,
          ...(configPath ? { configPath: project.configPaths[0]! } : {}),
        });
        const strictFailure = opts.strict === true && result.warnings.length > 0;
        const payload = {
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          secrets: result.secrets,
          pipelines: result.pipelines,
          modelPipelines: result.modelPipelines,
          entityGraphPipelines: result.entityGraphPipelines,
        };

        if (opts.yaml) {
          fmt.output(YAML.stringify(payload).trimEnd(), { ...outputOpts, json: false });
        } else if (jsonOutput) {
          fmt.output(payload, outputOpts);
        } else {
          if (result.errors.length > 0) {
            fmt.error('Errors:', outputOpts);
            for (const e of result.errors) {
              fmt.error(`${e.path}: ${e.message}`, outputOpts);
            }
          }
          if (result.warnings.length > 0) {
            fmt.warn('Warnings:', outputOpts);
            for (const w of result.warnings) {
              fmt.warn(w, outputOpts);
            }
          }
          if (result.pipelines.length > 0) {
            fmt.info(`Pipelines (${result.pipelines.length}):`, outputOpts);
            for (const p of result.pipelines) {
              fmt.info(`${p.name}: ${p.schedule} -> ${p.cron}`, outputOpts);
            }
          }
          if (result.modelPipelines.length > 0) {
            fmt.info(`Model pipelines (${result.modelPipelines.length}):`, outputOpts);
            for (const p of result.modelPipelines) {
              const models = p.models === '*' ? '*' : p.models.join(', ');
              fmt.info(
                `${p.name}: ${p.schedule} -> ${p.cron} [connection=${p.connection}; models=${models}]`,
                outputOpts
              );
            }
          }
          if (result.secrets.length > 0) {
            fmt.info(`Required secrets (${result.secrets.length}):`, outputOpts);
            for (const s of result.secrets) {
              fmt.info(`${s.envVar} - ${s.description}`, outputOpts);
            }
          }
          if (result.valid && !strictFailure) {
            fmt.success('Configuration is valid', outputOpts);
          }
        }

        if (!result.valid || strictFailure) {
          process.exitCode = 2;
        }
      }
    );
}
