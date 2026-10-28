import * as path from 'node:path';

import { parseInputFlags } from '../framework/runtime/index.js';
import type { Command } from 'commander';

import { ControlLogger } from '../runtime/control.js';
import { billablePlanUsage, isBillableResource } from '../runtime/extract-intents.js';
import { Emitter } from '../runtime/emitter.js';
import { lookupResource } from '../runtime/lookup.js';
import { isWarehouseSource, isWarehouseResource } from '../runtime/warehouse-extractor.js';
import { isFileStorageSource } from '../runtime/file-storage-extractor.js';

import {
  CommandError,
  buildCommandContext,
  collectInput,
  findIntegrationFile,
  loadNamedResource,
  loadIntegrationSpec,
  parseGlobalFlags,
  validateOutputMode,
} from './common.js';

interface LookupOptions {
  integration: string;
  resource: string;
  input?: string[];
  output?: string;
}

export function registerLookupCommand(program: Command): void {
  program
    .command('lookup')
    .description('Look up records using a resource lookup operation')
    .requiredOption('--integration <name>', 'Integration to use')
    .requiredOption('--resource <name>', 'Resource to look up')
    .option('--input <key=value...>', 'Lookup input values', collectInput, [])
    .option('--output <mode>', 'Output mode: stdout or file')
    .action(async (opts: LookupOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);
      const outputMode = validateOutputMode(opts.output ?? ctx.config.default_output);
      const integration = loadIntegrationSpec(
        findIntegrationFile(ctx.project, opts.integration, ctx.bundledIntegrationsDir)
      );

      if (isFileStorageSource(integration)) {
        throw new CommandError(
          'Lookup is not supported for file storage sources. Only API integrations are supported.'
        );
      }

      if (isWarehouseSource(integration)) {
        throw new CommandError(
          'Lookup is not supported for warehouse/database sources. Only API integrations are supported.'
        );
      }
      const resource = loadNamedResource(ctx, opts.integration, opts.resource);
      if (isWarehouseResource(resource)) {
        throw new CommandError(
          'Lookup is not supported for warehouse/database resources. Only API resources are supported.'
        );
      }
      if (isBillableResource(resource)) {
        throw new CommandError(
          `Lookup is disabled for billable resource "${opts.integration}/${resource.name}". ${billablePlanUsage()}`
        );
      }
      const input = parseInputFlags(opts.input ?? []);
      const emitter = new Emitter(outputMode, path.join(ctx.cwd, ctx.config.output_dir));

      try {
        await logger.info(`Starting lookup: ${opts.integration}/${resource.name}`);
        const startedAt = Date.now();

        const records = await lookupResource({
          integration,
          resource,
          input,
        });

        await emitter.emitSchema(resource);
        const timeExtracted = new Date().toISOString();
        for (const record of records) {
          await emitter.emitRecord(resource.name, record, timeExtracted);
        }

        await logger.metric(resource.name, {
          records_emitted: records.length,
          api_calls: 1,
          duration_ms: Date.now() - startedAt,
        });
        await logger.info(`Lookup complete: ${records.length} record(s)`);
      } finally {
        await emitter.close();
        await logger.close();
      }
    });
}
