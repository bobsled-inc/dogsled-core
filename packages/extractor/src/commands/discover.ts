/**
 * `bobsled extract discover` command.
 */

import type { Command } from 'commander';

import { getErrorMessage, isSourceSpec } from '../framework/core/index.js';

import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { DEFAULT_RECORD_PATH } from '../constants.js';
import { generateResourceSkeleton, inferColumns } from '../runtime/schema-inference.js';
import { isBillableResource, billablePlanUsage } from '../runtime/extract-intents.js';
import { isWarehouseSource } from '../runtime/warehouse-extractor.js';
import { isFileStorageSource } from '../runtime/file-storage-extractor.js';
import { resolveApiTransport } from '../runtime/transport-client-pool.js';

import type { ApiIntegrationSpec, ApiResourceSpec, IntegrationSpec } from '../types/index.js';
import {
  CommandError,
  buildCommandContext,
  describeTransport,
  findIntegrationFile,
  findResourceFiles,
  loadIntegrationSpec,
  loadResourceSpec,
  parseGlobalFlags,
} from './common.js';

interface DiscoverOptions {
  checkApi?: boolean;
  probe?: boolean;
  format?: 'text' | 'json';
}

function isLegacyMcpIntegration(integration: IntegrationSpec): boolean {
  return (
    'transport' in integration &&
    (integration.transport.type === 'mcp_http' || integration.transport.type === 'mcp_stdio')
  );
}

function describeDiscoverTransport(integration: IntegrationSpec): string {
  if (isSourceSpec(integration)) {
    return `transports: ${integration.transports
      .map((transport) => `${transport.id} (${transport.type})`)
      .join(', ')}`;
  }

  if ('transport' in integration) {
    return describeTransport(integration);
  }

  return 'non-API source';
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('List resources for an integration')
    .argument('<integration>', 'Integration name')
    .option('--no-check-api', 'Skip API connectivity check')
    .option('--probe', 'Infer output fields from a sample API response')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (integrationName: string, opts: DiscoverOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);

      try {
        const integrationFile = findIntegrationFile(
          ctx.project,
          integrationName,
          ctx.bundledIntegrationsDir
        );
        const integration = loadIntegrationSpec(integrationFile);

        if (isFileStorageSource(integration)) {
          throw new CommandError(
            'Discover is not supported for file storage sources. Only API integrations are supported.'
          );
        }

        if (isWarehouseSource(integration)) {
          throw new CommandError(
            'Discover is not supported for warehouse/database sources. Only API integrations are supported.'
          );
        }

        if (isLegacyMcpIntegration(integration)) {
          throw new CommandError(
            'MCP discovery is available only through `bobsled extract mcp`. ' +
              'Use `bobsled extract mcp list-tools`, `bobsled extract mcp discover`, or ' +
              '`bobsled extract mcp verify-redaction` for MCP authoring.'
          );
        }

        const resourceFiles = findResourceFiles(ctx, integrationName);
        if (resourceFiles.length === 0) {
          throw new CommandError(
            `No resources found for integration "${integrationName}". Add resource files with type: resource and integration: ${integrationName}.`
          );
        }

        const loadedResources = resourceFiles.map(
          (resourceFile) => loadResourceSpec(resourceFile) as ApiResourceSpec
        );

        const resources = loadedResources.map((resource) => {
          return {
            name: resource.name,
            integration: integrationName,
            method: resource.api?.method ?? (resource.tool ? 'MCP' : 'unknown'),
            endpoint: resource.api?.endpoint ?? resource.tool?.tool_name ?? 'n/a',
            fields: Object.keys(resource.output).length,
            primary_keys: resource.extract.table?.primary_key ?? [],
            sync_mode: resource.extract.incremental ? 'incremental' : 'full',
            cursor_field: resource.extract.incremental?.cursor_field ?? null,
          };
        });

        let apiCheck: { status: 'ok' } | { status: 'error'; message: string } | undefined;
        let probeSkeleton: string | undefined;

        if (opts.checkApi || opts.probe) {
          const firstResource = loadedResources.find((resource) => {
            const resolved = resolveApiTransport(integration, resource);
            return resolved.integration.transport.type === 'http' && Boolean(resource.api);
          });
          if (!firstResource) {
            throw new CommandError(
              'MCP discovery is available only through `bobsled extract mcp`. ' +
                'Use `bobsled extract mcp list-tools`, `bobsled extract mcp discover`, or ' +
                '`bobsled extract mcp verify-redaction` for MCP authoring.'
            );
          }

          const resolved = resolveApiTransport(integration, firstResource);
          const apiIntegration = resolved.integration as ApiIntegrationSpec;

          if (isBillableResource(firstResource)) {
            await logger.warn(
              `Skipping API check: "${integrationName}/${firstResource.name}" is billable. ${billablePlanUsage()}`
            );
          } else if (firstResource.api) {
            const method = firstResource.api.method.toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') {
              throw new CommandError(
                `discover can only probe read-only resources (GET or HEAD), but "${firstResource.name}" uses ${method}. ` +
                  'Use --no-check-api to skip the connectivity check, or configure a GET resource first.'
              );
            }

            const client = new ExtractorClient({ integration: apiIntegration });
            try {
              const response = await client.request({
                operation: { ...firstResource, api: firstResource.api! },
              });

              if (opts.checkApi) {
                apiCheck = { status: 'ok' };
              }

              if (opts.probe) {
                const recordPath = firstResource.extract.record_path ?? DEFAULT_RECORD_PATH;
                const fields = inferColumns(response.data, recordPath);
                if (fields.length > 0) {
                  probeSkeleton = generateResourceSkeleton(
                    fields,
                    integrationName,
                    firstResource.name,
                    firstResource.api.endpoint
                  );
                }
              }
            } catch (error) {
              if (opts.checkApi) {
                apiCheck = { status: 'error', message: getErrorMessage(error) };
              }
              if (opts.probe) {
                await logger.warn(`Probe failed: ${getErrorMessage(error)}`);
              }
            }
          }
        }

        if (opts.format === 'json') {
          const payload: Record<string, unknown> = { resources };
          if (apiCheck) {
            payload['api_check'] = apiCheck;
          }
          if (probeSkeleton) {
            payload['probe'] = probeSkeleton;
          }
          process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
          return;
        }

        await logger.info(
          `Integration: ${integrationName} (${describeDiscoverTransport(integration)})`
        );
        await logger.info('Resources:');
        for (const resource of resources) {
          const syncMode = resource.cursor_field
            ? `incremental (${resource.cursor_field})`
            : 'full';
          await logger.info(
            `${resource.name}: ${resource.method} ${resource.endpoint} [${resource.fields} fields, pk: ${resource.primary_keys.join(',') || 'none'}, ${syncMode}]`
          );
        }

        if (apiCheck) {
          if (apiCheck.status === 'ok') {
            await logger.info('API check successful');
          } else {
            await logger.error(`API check failed: ${apiCheck.message}`);
          }
        }

        if (probeSkeleton) {
          await logger.info('Inferred resource skeleton (review before use):');
          await logger.info(probeSkeleton);
        }
      } finally {
        await logger.close();
      }
    });
}
