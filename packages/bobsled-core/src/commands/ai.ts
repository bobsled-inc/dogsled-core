import { z } from 'zod';
import YAML from 'yaml';
import { Command } from 'commander';
import { resolve } from 'node:path';

import {
  embedMany,
  generateStructured,
  resolveModelConnection,
  resolveProviderModels,
} from '@bobsled-inc/ai';
import { CommandError, EXIT_ERROR } from '@bobsled-inc/protocol';

import * as fmt from '../lib/output/formatter.js';
import { resolveCliBobsledProject } from '../runner/config/cli-project-location.js';
import { loadProjectPipelineConfig } from '../runner/config/project-resolver.js';
import type { GlobalOptions } from '../types/index.js';

interface AiOutputOptions extends ReturnType<typeof fmt.toOutputOptions> {
  yaml?: boolean;
}

interface AiTestOptions {
  connection: string;
  config?: string;
  projectRoot?: string;
  json?: boolean;
  yaml?: boolean;
}

function writeOutput(payload: unknown, options: AiOutputOptions): void {
  if (options.quiet) {
    return;
  }
  if (options.yaml) {
    fmt.output(YAML.stringify(payload).trimEnd(), { ...options, json: false });
    return;
  }
  if (options.json) {
    fmt.output(payload, options);
    return;
  }
  fmt.output(JSON.stringify(payload, null, 2), options);
}

export function createAiGroup(program: Command): Command {
  const command = new Command('ai').description('Test Dogsled model-role connections');

  command
    .command('test')
    .requiredOption('--connection <role>', 'platform.models role to test')
    .option('--config <path>', 'Path to dogsled.yml')
    .option('--project-root <path>', 'Dogsled Project root (default: current directory)')
    .option('--json', 'Emit JSON')
    .option('--yaml', 'Emit YAML')
    .description('Run a small embedding and structured-generation probe')
    .action(async (options: AiTestOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const baseOutputOptions = fmt.toOutputOptions(globalOptions);
      const outputOptions: AiOutputOptions = {
        ...baseOutputOptions,
        json: options.yaml ? false : (options.json ?? baseOutputOptions.json),
        yaml: options.yaml,
      };
      const configPath = options.config ?? globalOptions.config;
      const project = resolveCliBobsledProject({
        configPath,
        projectRoot: options.projectRoot ?? globalOptions.projectRoot,
      });
      if (!project) {
        throw new CommandError(
          'Could not find a Dogsled Project. Pass --project-root <path> or --config <path>.',
          EXIT_ERROR
        );
      }
      const projectKey = resolve(project.projectRoot);
      const config = loadProjectPipelineConfig({
        projectRoot: project.projectRoot,
        index: project.index,
        ...(configPath ? { configPath: project.configPaths[0]! } : {}),
      }).config;
      const connection = resolveModelConnection(options.connection, config);
      const stubbed = process.env['BOBSLED_CORE_AI_TEST_STUB'] === '1';
      const providerModels = stubbed ? {} : await resolveProviderModels(connection);

      const embedResults = [];
      if (stubbed || providerModels.embeddingModel) {
        if (stubbed) {
          embedResults.push({
            ok: true,
            id: 'sample',
            vector: Array.from({ length: connection.dimension ?? 3 }, () => 0),
            tokenUsage: 0,
            costUsd: 0,
          });
        } else {
          for await (const result of embedMany(
            connection,
            [{ id: 'sample', text: 'Dogsled model connection health check' }],
            { platform: config.platform, projectKey, modelOverride: providerModels.embeddingModel }
          )) {
            embedResults.push(result);
          }
        }
      } else {
        embedResults.push({
          ok: true,
          skipped: true,
          message: `Provider "${connection.provider}" does not expose an embedding model factory`,
        });
      }

      const schema = z.object({ ok: z.boolean() });
      const generateResult =
        stubbed || providerModels.languageModel
          ? stubbed
            ? { ok: true, value: { ok: true }, tokenUsage: 0, costUsd: 0 }
            : await generateStructured(
                connection,
                {
                  schema,
                  prompt: 'Return JSON with ok=true.',
                },
                {
                  platform: config.platform,
                  projectKey,
                  modelOverride: providerModels.languageModel,
                }
              )
          : {
              ok: true,
              skipped: true,
              message: `Provider "${connection.provider}" does not expose a language model factory`,
            };

      const embeddingFailed = embedResults.some((result) => result.ok === false);
      const generationFailed = generateResult.ok === false;
      process.exitCode = embeddingFailed || generationFailed ? EXIT_ERROR : 0;

      writeOutput(
        {
          connection: options.connection,
          provider: connection.provider,
          model: connection.model,
          embedding: embedResults[0] ?? null,
          structured_generation: generateResult,
        },
        outputOptions
      );
    });

  return command;
}
