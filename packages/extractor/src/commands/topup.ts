import * as path from 'node:path';

import { parseInputFlags } from '../framework/runtime/index.js';
import type { Command } from 'commander';

import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { compareCursors, resolveCursorKind } from '../runtime/cursor.js';
import { Emitter } from '../runtime/emitter.js';
import { McpExtractorClient } from '../runtime/mcp-client.js';
import { isWarehouseSource } from '../runtime/warehouse-extractor.js';
import { FileStateStore } from '../runtime/state.js';
import { parseCursorValue } from '../runtime/time.js';
import { logSchemaBehaviorDefaultWarning } from '../runtime/schema-diagnostics.js';

import type { ApiIntegrationSpec, ApiResourceSpec } from '../types/index.js';
import { extractResource } from './extract.js';
import {
  CommandError,
  buildCommandContext,
  collectInput,
  findIntegrationFile,
  isMcpIntegration,
  loadNamedResource,
  integrationSpecWarningMessages,
  loadIntegrationSpecWithWarnings,
  parseGlobalFlags,
  parsePositiveInt,
  validateOutputMode,
} from './common.js';

import type { CursorKind } from '../runtime/cursor.js';

function normalizeCursorInput(value: string, kind: CursorKind): string {
  switch (kind) {
    case 'timestamp':
      return parseCursorValue(value);
    case 'number':
      if (!Number.isFinite(Number(value))) {
        throw new CommandError(
          `Invalid number cursor value: "${value}". Must be a numeric literal.`
        );
      }
      return value;
    case 'integer':
      if (!/^-?\d+$/.test(value)) {
        throw new CommandError(
          `Invalid integer cursor value: "${value}". Must be an integer literal.`
        );
      }
      return value;
    case 'lsn':
      throw new CommandError(
        'Top-up does not support PostgreSQL LSN cursors. Use warehouse change_tracking extraction instead.'
      );
    case 'string':
      return value;
  }
}

interface TopupOptions {
  integration: string;
  resource: string;
  since?: string;
  until?: string;
  advanceState?: boolean;
  input?: string[];
  output?: string;
  limit?: number;
}

export function registerTopupCommand(program: Command): void {
  program
    .command('topup')
    .description('Extract records within a cursor range (incremental top-up)')
    .requiredOption('--integration <name>', 'Integration to use')
    .requiredOption('--resource <name>', 'Resource to extract')
    .option('--since <value>', 'Start cursor: ISO timestamp or relative duration (e.g. 2h, 1d)')
    .option('--until <value>', 'End cursor: ISO timestamp or relative duration')
    .option('--advance-state', 'Persist state after extraction', false)
    .option('--input <key=value...>', 'Input override values', collectInput, [])
    .option('--output <mode>', 'Output mode: stdout or file')
    .option('--limit <count>', 'Cap number of records', parsePositiveInt)
    .action(async (opts: TopupOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);
      const cliInputs = parseInputFlags(opts.input ?? []);
      const outputMode = validateOutputMode(opts.output ?? ctx.config.default_output);
      const stateStore = new FileStateStore(path.join(ctx.cwd, ctx.config.state_dir));
      const state = await stateStore.load();

      const integrationResult = loadIntegrationSpecWithWarnings(
        findIntegrationFile(ctx.project, opts.integration, ctx.bundledIntegrationsDir)
      );
      for (const warning of integrationSpecWarningMessages(
        opts.integration,
        integrationResult.warnings
      )) {
        await logger.warn(warning);
      }
      const integration = integrationResult.spec;

      if (isWarehouseSource(integration)) {
        throw new CommandError(
          'Top-up is not supported for warehouse/database sources. Use --full-refresh or incremental extraction instead.'
        );
      }

      // After the warehouse guard, integration is an API integration
      const apiIntegration = integration as ApiIntegrationSpec;
      const resource = loadNamedResource(
        { ...ctx, bundledIntegrationsDir: null },
        opts.integration,
        opts.resource
      ) as ApiResourceSpec;

      if (!resource.extract.incremental) {
        throw new CommandError(
          `Resource "${opts.resource}" does not have incremental config. Top-up requires extract.incremental.cursor_field and a supported incremental strategy.`
        );
      }

      const cursorKind: CursorKind =
        resolveCursorKind({
          specCursorType: resource.extract.incremental.cursor_type,
          hintValue: opts.since ?? opts.until,
        }) ?? 'string';

      if (cursorKind === 'lsn') {
        throw new CommandError(
          'Top-up does not support PostgreSQL LSN cursors. Use warehouse change_tracking extraction instead.'
        );
      }

      const sinceValue = opts.since ? normalizeCursorInput(opts.since, cursorKind) : undefined;
      const untilValue = opts.until ? normalizeCursorInput(opts.until, cursorKind) : undefined;

      if (sinceValue && untilValue && compareCursors(sinceValue, untilValue, cursorKind) > 0) {
        throw new CommandError(
          `--since value "${opts.since}" is after --until value "${opts.until}".`
        );
      }

      await logSchemaBehaviorDefaultWarning(
        logger,
        resource,
        ctx.config.default_load?.defaults?.schema_behavior
      );

      const client = isMcpIntegration(apiIntegration)
        ? new McpExtractorClient({ integration: apiIntegration, cliInputs })
        : new ExtractorClient({
            integration: apiIntegration,
            cliInputs,
            stateDir: path.join(ctx.cwd, ctx.config.state_dir),
          });
      const emitter = new Emitter(outputMode, path.join(ctx.cwd, ctx.config.output_dir), {
        defaultSchemaBehavior: ctx.config.default_load?.defaults?.schema_behavior,
      });

      try {
        await client.connect();
        await logger.info(`Starting top-up: ${opts.integration}/${resource.name}`);
        const startedAt = Date.now();

        const result = await extractResource({
          integration: apiIntegration,
          integrationName: opts.integration,
          resource,
          client,
          emitter,
          logger,
          state,
          stateStore,
          batchDir: path.join(ctx.cwd, ctx.config.batch_dir),
          opts: {
            input: opts.input,
            output: opts.output,
            limit: opts.limit,
            sinceOverride: sinceValue,
            untilValue,
            cursorKind,
            advanceState: opts.advanceState ?? false,
          },
        });

        await logger.metric(resource.name, {
          records_emitted: result.recordCount,
          api_calls: result.apiCalls,
          duration_ms: Date.now() - startedAt,
        });
        await logger.info(
          `Completed top-up: ${opts.integration}/${resource.name} (${result.recordCount} records)`
        );
      } finally {
        await Promise.allSettled([client.close(), emitter.close(), logger.close()]);
      }
    });
}
