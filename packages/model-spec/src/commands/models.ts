import type { Command } from 'commander';

import * as out from '../output.js';
import { CommandError } from './common.js';

interface ModelsOptions {
  json?: boolean;
}

interface InstallOptions extends ModelsOptions {
  schema?: string;
  sourcesDir?: string;
  modelsDir?: string;
  metricsDir?: string;
  relationshipsDir?: string;
  overwrite?: boolean;
}

type ModelsModule = typeof import('@bobsled-inc/models');
type ModelPackage = ReturnType<ModelsModule['getModelPackage']>;

async function loadModelsModule(): Promise<ModelsModule> {
  return import('@bobsled-inc/models');
}

function renderPackageInfo(modelPackage: ModelPackage): void {
  out.info(`${modelPackage.displayName} (${modelPackage.name})`);
  out.info(modelPackage.description);
  out.info(
    `Resources: ${modelPackage.sourceSpecs.length}, staging models: ${modelPackage.stagingSpecs.length}, marts: ${modelPackage.martSpecs.length}, metrics: ${modelPackage.metricSpecs.length}, relationships: ${modelPackage.relationshipSpecs.length}`
  );
  out.info(`Tags: ${modelPackage.tags.join(', ')}`);
  out.info(`Marts: ${modelPackage.martSpecs.map((mart) => mart.name).join(', ')}`);
  out.info(`Metrics: ${modelPackage.metricSpecs.map((metric) => metric.name).join(', ')}`);
  out.info(
    `Relationships: ${modelPackage.relationshipSpecs.map((relationship) => relationship.name).join(', ')}`
  );
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command('models')
    .description('Browse and install prebuilt Bobsled Core model packages')
    .option('--json', 'Output results as JSON to stdout');

  models
    .command('list')
    .description('List available prebuilt model packages')
    .action(async () => {
      try {
        const { listModelPackages } = await loadModelsModule();
        const packages = listModelPackages();
        const opts = models.opts<ModelsOptions>();

        if (opts.json) {
          process.stdout.write(JSON.stringify(packages, null, 2) + '\n');
          return;
        }

        for (const modelPackage of packages) {
          out.info(
            `${modelPackage.name}: ${modelPackage.resourceCount} resources, ${modelPackage.stagingCount} staging, ${modelPackage.martCount} marts, ${modelPackage.metricCount} metrics, ${modelPackage.relationshipCount} relationships`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandError(message);
      }
    });

  models
    .command('info')
    .description('Show detail for a prebuilt model package')
    .argument('<package>', 'Model package name')
    .action(async (name: string) => {
      try {
        const opts = models.opts<ModelsOptions>();
        const { getModelPackage } = await loadModelsModule();
        const modelPackage = getModelPackage(name);

        if (opts.json) {
          process.stdout.write(JSON.stringify(modelPackage, null, 2) + '\n');
          return;
        }

        renderPackageInfo(modelPackage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandError(message);
      }
    });

  models
    .command('install')
    .description('Install a prebuilt model package into the current Model Spec project')
    .argument('<package>', 'Model package name')
    .option('--schema <name>', 'Raw source schema name to use in installed source specs', 'raw')
    .option('--sources-dir <dir>', 'Directory for source specs', 'sources')
    .option('--models-dir <dir>', 'Directory for model specs', 'models')
    .option('--metrics-dir <dir>', 'Directory for metric specs', 'metrics')
    .option('--relationships-dir <dir>', 'Directory for relationship specs', 'relationships')
    .option('--overwrite', 'Overwrite existing files if they already exist')
    .action(async (name: string, options: InstallOptions) => {
      try {
        const { installModelPackage } = await loadModelsModule();
        const result = installModelPackage(name, {
          cwd: process.cwd(),
          rawSchema: options.schema,
          sourceDir: options.sourcesDir,
          modelDir: options.modelsDir,
          metricDir: options.metricsDir,
          relationshipDir: options.relationshipsDir,
          overwrite: options.overwrite ?? false,
        });

        const opts = models.opts<ModelsOptions>();

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }

        out.success(
          `Installed ${result.packageName}: ${result.sourceCount} sources, ${result.stagingCount} staging models, ${result.martCount} marts, ${result.metricCount} metrics, ${result.relationshipCount} relationships`
        );
        for (const filePath of result.writtenFiles) {
          out.info(filePath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandError(message);
      }
    });
}
