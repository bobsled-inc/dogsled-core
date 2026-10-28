/**
 * `dogsled extract scaffold-test` command.
 *
 * Tests auth, config, and one record per resource for an integration.
 * Standalone resources run first, then their results feed into
 * parameterized resources automatically — e.g. fetching campaigns first,
 * then using a campaign ID to test campaign_leads without manual input.
 */

import type { Command } from 'commander';

import type { InputFieldDefinition } from '../framework/core/index.js';
import { getErrorMessage } from '../framework/core/index.js';

import { ExtractorClient } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { DEFAULT_RECORD_PATH } from '../constants.js';
import { billablePlanUsage, isBillableResource } from '../runtime/extract-intents.js';
import { extractRecords } from '../runtime/response-mapper.js';
import { resolveApiTransport } from '../runtime/transport-client-pool.js';

import {
  CommandError,
  buildCommandContext,
  isMcpIntegration,
  findIntegrationFile,
  findResourceFiles,
  loadIntegrationSpec,
  loadResourceSpec,
  parseGlobalFlags,
} from './common.js';

import type { ApiResourceSpec } from '../types/index.js';
import { isWarehouseSource, isWarehouseResource } from '../runtime/warehouse-extractor.js';
import { isFileStorageSource } from '../runtime/file-storage-extractor.js';

interface ScaffoldTestOptions {
  resource?: string;
  allowBillableTest?: boolean;
}

/**
 * Determine which input fields are required and have no default value,
 * meaning the caller must supply them.
 */
function getRequiredInputs(resource: ApiResourceSpec): string[] {
  const required: string[] = [];
  for (const [key, field] of Object.entries(resource.input)) {
    if (field.required && field.default === undefined) {
      required.push(key);
    }
  }
  return required;
}

/**
 * Check whether an input field looks like a time/date field based on
 * its name and description.
 */
function isTimeField(key: string, field: InputFieldDefinition): boolean {
  const nameLower = key.toLowerCase();
  const descLower = (field.description ?? '').toLowerCase();
  return (
    nameLower.includes('time') ||
    nameLower.includes('date') ||
    descLower.includes('rfc3339') ||
    descLower.includes('iso 8601') ||
    descLower.includes('timestamp')
  );
}

/**
 * Try to auto-fill required inputs for a resource using:
 * 1. The ID pool (records from previously fetched resources)
 * 2. Sensible defaults for time/date fields
 *
 * Returns null if any required input cannot be resolved.
 */
function resolveInputs(
  resource: ApiResourceSpec,
  idPool: Map<string, unknown[]>
): Record<string, unknown> | null {
  const inputs: Record<string, unknown> = {};
  const required = getRequiredInputs(resource);

  for (const key of required) {
    const field = resource.input[key]!;

    // 1. Time/date fields — use last 30 days
    if (isTimeField(key, field)) {
      const now = new Date();
      if (key.includes('start') || key.includes('from') || key.includes('after')) {
        inputs[key] = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      } else {
        inputs[key] = now.toISOString();
      }
      continue;
    }

    // 2. ID fields — look up from the pool
    // Match `campaign_id` → pool key `campaigns`, `account_id` → `accounts`, etc.
    const idMatch = key.match(/^(.+?)_?id$/);
    if (idMatch?.[1]) {
      const stem = idMatch[1].replace(/_/g, '');
      // Try plural forms: campaign → campaigns, account → accounts
      const candidates = [`${stem}s`, stem, `${stem}es`];

      let found = false;
      for (const candidate of candidates) {
        const records = idPool.get(candidate);
        if (records && records.length > 0) {
          const first = records[0] as Record<string, unknown>;
          inputs[key] = first['id'] ?? first[key];
          if (inputs[key] !== undefined) {
            found = true;
            break;
          }
        }
      }

      if (!found) return null;
      continue;
    }

    // 3. Cannot resolve this input
    return null;
  }

  return inputs;
}

async function runScaffoldTest(
  integrationName: string,
  opts: ScaffoldTestOptions,
  program: Command
): Promise<void> {
  const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
  const logger = new ControlLogger(ctx);

  try {
    const integrationFile = findIntegrationFile(
      ctx.project,
      integrationName,
      ctx.bundledIntegrationsDir
    );
    const integration = loadIntegrationSpec(integrationFile);

    // scaffold-test only supports API integrations
    if (isFileStorageSource(integration)) {
      throw new CommandError(
        `Integration "${integrationName}" is a file storage source. scaffold-test only supports API integrations.`
      );
    }

    if (isWarehouseSource(integration)) {
      throw new CommandError(
        `Integration "${integrationName}" is a warehouse/database source. scaffold-test only supports API integrations.`
      );
    }

    const resourceFiles = findResourceFiles(ctx, integrationName);
    if (resourceFiles.length === 0) {
      throw new CommandError(
        `No resources found for integration "${integrationName}". Add resource files with type: resource and integration: ${integrationName}.`
      );
    }

    const allResources = resourceFiles.map((file) => loadResourceSpec(file));

    // Guard: fail fast if warehouse resources are found (they should not be passed to scaffold-test)
    const warehouseResources = allResources.filter(isWarehouseResource);
    if (warehouseResources.length > 0) {
      const names = warehouseResources.map((r) => r.name).join(', ');
      throw new CommandError(
        `Found warehouse resource(s) [${names}] in integration "${integrationName}". scaffold-test only supports API resources.`
      );
    }

    // After warehouse guard, all remaining resources are API resources
    const apiResources = allResources as ApiResourceSpec[];
    const resources = apiResources.filter(
      (resource) => !opts.resource || resource.name === opts.resource
    );

    if (resources.length === 0 && opts.resource) {
      throw new CommandError(
        `Resource "${opts.resource}" not found for integration "${integrationName}".`
      );
    }

    if (!opts.allowBillableTest) {
      const billableResources = resources.filter((resource) => isBillableResource(resource));
      if (billableResources.length > 0) {
        throw new CommandError(
          `scaffold-test refuses billable resources by default: ${billableResources
            .map((resource) => `${integrationName}/${resource.name}`)
            .join(
              ', '
            )}. Use --allow-billable-test only for explicit paid verification. ${billablePlanUsage()}`
        );
      }
    }

    if (isMcpIntegration(integration)) {
      throw new CommandError(
        `scaffold-test does not yet support MCP integrations. Integration "${integrationName}" uses an MCP transport.`
      );
    }

    await logger.info(`Testing ${integrationName}`);

    // Partition into standalone (no required inputs) and parameterized
    const standalone: ApiResourceSpec[] = [];
    const parameterized: ApiResourceSpec[] = [];

    for (const resource of resources) {
      const required = getRequiredInputs(resource);
      if (required.length === 0) {
        standalone.push(resource);
      } else {
        parameterized.push(resource);
      }
    }

    if (parameterized.length > 0) {
      await logger.info(`  ${standalone.length} standalone, ${parameterized.length} chained`);
    }

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Pool of fetched records keyed by resource name
    const idPool = new Map<string, unknown[]>();

    // Phase 1: standalone resources
    for (const resource of standalone) {
      if (!resource.api) {
        await logger.warn(`  ${resource.name}  skipped (MCP resource)`);
        skipped += 1;
        continue;
      }
      const method = resource.api.method.toUpperCase();
      if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
        await logger.warn(`  ${resource.name}  skipped (${method} method)`);
        skipped += 1;
        continue;
      }

      try {
        const resolved = resolveApiTransport(integration, resource);
        const client = new ExtractorClient({ integration: resolved.integration });
        const response = await client.request({ operation: { ...resource, api: resource.api! } });
        const recordPath = resource.extract.record_path ?? DEFAULT_RECORD_PATH;
        const records = extractRecords(response.data, recordPath);
        const list = Array.isArray(records) ? records : [];

        // Store in pool for chained lookups
        idPool.set(resource.name, list);

        await logger.info(`  ✓ ${resource.name}   ${response.status} (${list.length} records)`);
        passed += 1;
      } catch (error) {
        const message = getErrorMessage(error);
        await logger.error(`  ✗ ${resource.name}   ${message}`);
        failed += 1;
      }
    }

    // Phase 2: parameterized resources — auto-resolve inputs from pool
    for (const resource of parameterized) {
      if (!resource.api) {
        await logger.warn(`  ${resource.name}  skipped (MCP resource)`);
        skipped += 1;
        continue;
      }
      const method = resource.api.method.toUpperCase();
      if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
        await logger.warn(`  - ${resource.name}  skipped (${method} method)`);
        skipped += 1;
        continue;
      }

      const inputs = resolveInputs(resource, idPool);
      if (!inputs) {
        const required = getRequiredInputs(resource);
        await logger.warn(
          `  - ${resource.name}  skipped (no data to resolve: ${required.join(', ')})`
        );
        skipped += 1;
        continue;
      }

      const inputDesc = Object.entries(inputs)
        .map(([k, v]) => {
          const display = typeof v === 'string' && v.length > 20 ? v.slice(0, 20) + '…' : v;
          return `${k}=${display}`;
        })
        .join(', ');

      try {
        const resolved = resolveApiTransport(integration, resource);
        const client = new ExtractorClient({ integration: resolved.integration });
        const response = await client.request({
          operation: { ...resource, api: resource.api! },
          input: inputs,
        });

        const recordPath = resource.extract.record_path ?? DEFAULT_RECORD_PATH;
        const records = extractRecords(response.data, recordPath);
        const list = Array.isArray(records) ? records : [];

        idPool.set(resource.name, list);

        await logger.info(
          `  ✓ ${resource.name}   ${response.status} (${list.length} records) ← ${inputDesc}`
        );
        passed += 1;
      } catch (error) {
        const message = getErrorMessage(error);
        await logger.error(`  ✗ ${resource.name}   ${message} ← ${inputDesc}`);
        failed += 1;
      }
    }

    const total = passed + failed + skipped;
    const parts = [`${passed} passed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    const summary = `${parts.join(', ')} of ${total} resources`;

    if (failed > 0) {
      await logger.error(`\n  Result: ${summary}`);
      throw new CommandError(`Scaffold test failed for ${failed} resource(s)`, 1);
    }

    await logger.info(`\n  Result: ${summary}`);
  } finally {
    await logger.close();
  }
}

export function registerScaffoldTestCommand(program: Command): void {
  const action = async (integrationName: string, opts: ScaffoldTestOptions) =>
    runScaffoldTest(integrationName, opts, program);

  // Primary command
  program
    .command('scaffold-test')
    .description('Test auth, config, and one record per resource')
    .argument('<integration>', 'Integration name')
    .option('--resource <name>', 'Test a single resource instead of all')
    .option('--allow-billable-test', 'Allow scaffold-testing billable resources')
    .action(action);

  // Backward-compat aliases
  program
    .command('smoke-test', { hidden: true })
    .argument('<integration>')
    .option('--resource <name>')
    .option('--allow-billable-test')
    .action(action);

  program
    .command('test-auth', { hidden: true })
    .argument('<integration>')
    .option('--resource <name>')
    .option('--allow-billable-test')
    .action(action);
}
