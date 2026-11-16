import {
  assertDeclaredEnvironmentReferences,
  collectEnvironmentReferences,
  getEnvironmentDeclarationError,
} from '@bobsled-inc/protocol';
/**
 * `bobsled extract health-check` command.
 *
 * Quick connectivity and parsing validation for an integration.
 */

import type { Command } from 'commander';

import { getErrorMessage } from '../framework/core/index.js';
import { parseInputFlags } from '../framework/runtime/index.js';

import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { isFileStorageSource } from '../runtime/file-storage-extractor.js';
import { McpExtractorClient } from '../runtime/mcp-client.js';
import { extractRecords, mapOutput } from '../runtime/response-mapper.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  buildTargetedFanOutContext,
  normalizeForEachConfig,
} from '../runtime/for-each.js';
import { resolveApiTransport } from '../runtime/transport-client-pool.js';

import type { ApiResourceSpec } from '../types/index.js';
import { collectOptionalOnlyEnvRefs } from './verify-shared.js';
import { readScopedHealthResource, selectHealthCheckResource } from './health-check-resource.js';
import {
  CommandError,
  buildCommandContext,
  collectInput,
  describeTransport,
  findIntegrationFile,
  findResourceFiles,
  isMcpIntegration,
  loadIntegrationSpec,
  loadResourceSpec,
  parseGlobalFlags,
} from './common.js';

interface HealthCheckOptions {
  resource?: string;
  input?: string[];
}

interface HealthCheckResult {
  status: 'ok' | 'error';
  integration: string;
  resource: string;
  transport: string;
  env_vars: { name: string; present: boolean }[];
  api_call?: { status: 'ok' | 'error'; message?: string; records_parsed?: number };
  error?: string;
}

export function registerHealthCheckCommand(program: Command): void {
  program
    .command('health-check')
    .description('Validate connectivity and response parsing for an integration')
    .argument('<integration>', 'Integration name')
    .option(
      '--resource <name>',
      'Specific resource to check (default: scoped pipeline resource or first health-check candidate)'
    )
    .option('--input <key=value...>', 'Input override values', collectInput, [])
    .action(async (integrationName: string, opts: HealthCheckOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);

      const result: HealthCheckResult = {
        status: 'ok',
        integration: integrationName,
        resource: '',
        transport: '',
        env_vars: [],
      };

      try {
        // Load integration spec
        const integrationFile = findIntegrationFile(
          ctx.project,
          integrationName,
          ctx.bundledIntegrationsDir
        );
        const integrationRaw = loadIntegrationSpec(integrationFile);
        if (isFileStorageSource(integrationRaw)) {
          throw new CommandError(
            'Health-check is not supported for file storage sources. Only API integrations are supported.'
          );
        }
        const integration = integrationRaw;
        result.transport = describeTransport(integration);

        // Find resource
        const resourceFiles = findResourceFiles(ctx, integrationName);
        if (resourceFiles.length === 0) {
          throw new CommandError(`No resources found for integration "${integrationName}".`);
        }

        const resources = resourceFiles.map(
          (filePath) => loadResourceSpec(filePath) as ApiResourceSpec
        );
        let targetResource: ApiResourceSpec | undefined;
        if (opts.resource) {
          targetResource = resources.find((spec) => spec.name === opts.resource);
          if (!targetResource) {
            throw new CommandError(
              `Resource "${opts.resource}" not found for integration "${integrationName}".`
            );
          }
        } else {
          const scopedResourceName = readScopedHealthResource(process.cwd(), integrationName);
          targetResource = selectHealthCheckResource(resources, scopedResourceName);
        }
        result.resource = targetResource.name;

        const resolvedTransport = resolveApiTransport(integration, targetResource);
        const resolvedIntegration = resolvedTransport.integration;
        const isMcp = isMcpIntegration(resolvedIntegration);

        // Check env vars referenced in transport auth
        const references = [resolvedIntegration, targetResource];
        try {
          assertDeclaredEnvironmentReferences(references, resolvedIntegration.auth_env_vars);
        } catch (error) {
          result.env_vars = [...collectEnvironmentReferences(references)].map((name) => ({
            name,
            present: false,
          }));
          throw error;
        }
        const optional = collectOptionalOnlyEnvRefs(resolvedIntegration);
        const envVarsToCheck = [...collectEnvironmentReferences(references)].filter(
          (name) => !optional.has(name)
        );

        for (const envVar of envVarsToCheck) {
          const present = process.env[envVar] != null && process.env[envVar] !== '';
          result.env_vars.push({ name: envVar, present });
          if (!present) {
            result.status = 'error';
            await logger.warn(`Missing environment variable: ${envVar}`);
          }
        }

        // If env vars are missing, skip API call
        if (result.env_vars.some((v) => !v.present)) {
          result.error = 'Missing required environment variables';
          await emitResult(logger, result);
          process.exitCode = 2;
          return;
        }

        // Make test API call
        const cliInputs = parseInputFlags(opts.input ?? []);
        const normalizedForEach = normalizeForEachConfig(targetResource.extract.for_each);
        const fanOutContext = normalizedForEach
          ? buildTargetedFanOutContext(targetResource, normalizedForEach, cliInputs)
          : EMPTY_FAN_OUT_CONTEXT;

        if (isMcp) {
          const client = new McpExtractorClient({ integration: resolvedIntegration, cliInputs });
          try {
            await client.connect();
            if (targetResource.tool) {
              const data = await client.callTool({
                operation: {
                  input: targetResource.input ?? {},
                  tool: { tool_name: targetResource.tool.tool_name },
                },
              });
              const records = extractRecords(data, targetResource);
              if (records.length > 0) {
                mapOutput(records[0]!, targetResource.output, undefined, fanOutContext);
              }
              result.api_call = {
                status: 'ok',
                records_parsed: records.length,
              };
              await logger.info(
                `API call OK: parsed ${records.length} record(s) from ${targetResource.name}`
              );
            }
          } catch (error) {
            result.status = 'error';
            result.api_call = {
              status: 'error',
              message: getErrorMessage(error),
            };
            await logger.error(`API call failed: ${getErrorMessage(error)}`);
          } finally {
            await client.close();
          }
        } else {
          if (!targetResource.api) {
            throw new CommandError(
              `Resource "${targetResource.name}" does not define an "api" block.`
            );
          }

          const method = targetResource.api.method.toUpperCase();
          if (method !== 'GET' && method !== 'HEAD') {
            throw new CommandError(
              `Health check can only probe read-only resources (GET or HEAD), but "${targetResource.name}" uses ${method}.`
            );
          }

          const client = new ExtractorClient({ integration: resolvedIntegration, cliInputs });
          try {
            const response = await client.request({
              operation: { ...targetResource, api: targetResource.api },
              input: cliInputs,
            });

            const records = extractRecords(response.data, targetResource);
            // Validate mapping on first record
            if (records.length > 0) {
              mapOutput(records[0]!, targetResource.output, undefined, fanOutContext);
            }

            result.api_call = {
              status: 'ok',
              records_parsed: records.length,
            };
            await logger.info(
              `API call OK: parsed ${records.length} record(s) from ${targetResource.name}`
            );
          } catch (error) {
            result.status = 'error';
            result.api_call = {
              status: 'error',
              message: getErrorMessage(error),
            };
            await logger.error(`API call failed: ${getErrorMessage(error)}`);
          }
        }

        await emitResult(logger, result);

        if (result.status === 'error') {
          process.exitCode = 1;
        }
      } catch (err) {
        if (err instanceof CommandError && !getEnvironmentDeclarationError(err)) {
          throw err;
        }
        result.status = 'error';
        result.error = getErrorMessage(err);
        await logger.error(result.error);
        await emitResult(logger, result);
        process.exitCode = getEnvironmentDeclarationError(err) ? 2 : 1;
      } finally {
        await logger.close();
      }
    });
}

async function emitResult(logger: ControlLogger, result: HealthCheckResult): Promise<void> {
  await logger.progress('health_check_complete', result.resource, {
    status: result.status,
    integration: result.integration,
    resource: result.resource,
    transport: result.transport,
    env_vars_ok: result.env_vars.every((v) => v.present),
    api_call_ok: result.api_call?.status === 'ok',
  });
}
