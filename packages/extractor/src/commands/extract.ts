import * as path from 'node:path';

import { parseInputFlags } from '../framework/runtime/index.js';
import { isFileStorageResource, isLookupOnlyApiResource } from '../framework/extractor/index.js';
import { type Command, Option } from 'commander';
import { declaredHostEnvironmentNames } from '@bobsled-inc/protocol';

import {
  resolveEmbedConfigFromOptions,
  type EmbedConfigFile,
} from '../model-spec/embed-config-file.js';
import { runExtractIntentPlan } from './extract-plan.js';
import { ControlLogger } from '../runtime/control.js';
import { Emitter } from '../runtime/emitter.js';
import { billablePlanUsage, isBillableResource } from '../runtime/extract-intents.js';
import { isFileStorageSource } from '../runtime/file-storage-extractor.js';
import { hasExplicitForEachInputs, normalizeForEachConfig } from '../runtime/for-each.js';
import { orderResourcesForExtraction } from '../runtime/resource-order.js';
import { resolveStateStore } from '../runtime/state-backend.js';
import { openStagedState } from '../runtime/staged-state.js';
import type { StateStore } from '../runtime/state.js';
import { isSnowflakeWarehouseSource, isWarehouseResource } from '../runtime/warehouse-extractor.js';
import { ResourceCircuitBreaker } from '../runtime/errors.js';
import { buildRunSummary, type ResourceResult } from '../runtime/run-summary.js';
import { TransportClientPool } from '../runtime/transport-client-pool.js';

import type { ApiResourceSpec, ExtractorState } from '../types/index.js';
import {
  CommandError,
  buildCommandContext,
  collectInput,
  findAllIntegrations,
  findIntegrationFile,
  findResourceFiles,
  integrationSpecWarningMessages,
  loadIntegrationSpecWithWarnings,
  loadResourceSpecWithWarnings,
  shippedSourceCredentialNames,
  parseGlobalFlags,
  parsePositiveInt,
  validateOutputMode,
} from './common.js';
import { applyDefaultViaOverride, validateResourceViaOverride } from './default-via.js';
import {
  mergeResourceInputs,
  parseResourceInputMatricesJson,
  parseResourceInputMatrixConcurrencyJson,
  parseResourceInputsJson,
  validateResourceInputMatricesOverride,
  validateResourceInputMatrixConcurrencyOverride,
  validateResourceInputsOverride,
} from './resource-inputs.js';
import {
  collectResourceVia,
  parseBatchFormat,
  type ExtractCommandOptions,
  type ExtractOptions,
} from './extract-command-options.js';
import { assertApiResourceSemanticsForExtraction } from './validate.js';
import { extractResourcesWithMatrices, type ForEachRecord } from './extract-matrix.js';

/** Filter CLI inputs to only include keys defined in the resource's input schema. */
export function filterInputsForResource(
  inputs: Record<string, string>,
  inputSchema: ApiResourceSpec['input'] | undefined
): Record<string, string> {
  if (!inputSchema) {
    return {};
  }
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (Object.hasOwn(inputSchema, key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export type { ExtractOptions } from './extract-command-options.js';

// extractResource + ExtractResourceParams + ExtractResourceResult moved to
// ./extract-resource.ts to keep this file under the per-file size limit. They
// remain part of the package's public surface via the re-export below and the
// barrel in runtime/index.ts.
export {
  extractResource,
  shouldAdvanceDurableState,
  type ExtractResourceParams,
  type ExtractResourceResult,
} from './extract-resource.js';
import { extractResource } from './extract-resource.js';

export function registerExtractCommand(program: Command): void {
  program
    .command('run')
    .description('Run extraction pipeline')
    .argument('[resources...]', 'Resource names to extract (default: all)')
    .option('--integration <name>', 'Integration to extract from')
    .addOption(new Option('--host-env-names-json <json>').hideHelp())
    .option('--full-refresh', 'Ignore bookmarks and extract from the beginning')
    .option('--input <key=value...>', 'Input override values', collectInput, [])
    .option('--default-via <id>', "Override source integration's default_transport for this run")
    .option(
      '--resource-via <name:id...>',
      'Force a specific transport for one resource (repeatable). Wins over --default-via.',
      collectResourceVia,
      {} as Record<string, string>
    )
    .option(
      '--resource-inputs-json <json>',
      'JSON object of per-resource input overrides: {"<resource>":{"<input>":"value"}}. ' +
        'Merged over --input for that resource only; array values are JSON-encoded.',
      parseResourceInputsJson
    )
    .option(
      '--resource-input-matrices-json <json>',
      'JSON object of static per-resource input matrices. Each tuple is extracted into the same stream.',
      parseResourceInputMatricesJson
    )
    .option(
      '--resource-input-matrix-concurrency-json <json>',
      'JSON object of per-resource matrix concurrency values between 1 and 64.',
      parseResourceInputMatrixConcurrencyJson
    )
    .option('--output <mode>', 'Output mode: stdout or file')
    .option('--limit <count>', 'Cap number of records (for testing)', parsePositiveInt)
    .option('--lint', 'Validate responses and detect schema drift')
    .option('--batch', 'Enable batch output')
    .option('--batch-format <format>', 'Batch file format: jsonl or parquet', parseBatchFormat)
    .option('--batch-size <count>', 'Records per batch file', parsePositiveInt)
    .option('--emit-model-spec-source', 'Generate Model Spec source YAML alongside extraction')
    .option(
      '--embed-config-file <path>',
      'Path to a JSON file with the resolved pipeline embed config (used to pre-fill embedding columns in --emit-model-spec-source scaffolds)'
    )
    .option('--advance-state', 'Persist state after a successful run')
    .option('--no-state-write', 'Do not persist state during extraction')
    .option('--plan <name>', 'Execute only the steps in a named extract-intents plan')
    .option('--output-dir <path>', 'Directory for run_summary.json output')
    .option('--timeout <ms>', 'Overall extraction timeout in milliseconds', '14400000')
    .option('--max-consecutive-failures <n>', 'Circuit breaker threshold', '5')
    .option(
      '--state-backend <url>',
      'State backend URL (file://<path> or https://...). Default: local file at config state_dir.'
    )
    .option(
      '--state-auth-env <var>',
      'Name of env var holding the Bearer token for the HTTP state backend.'
    )
    .addOption(new Option('--staged-state <path>').hideHelp())
    .option('--warehouse <selector>', 'Pipeline-scoped Snowflake warehouse selector')
    .option('--query-tag <tag>', 'Snowflake query tag for this execution')
    .action(async (resourceNames: string[], rawOpts: ExtractCommandOptions) => {
      const ctx = buildCommandContext(parseGlobalFlags(program.opts()));
      const logger = new ControlLogger(ctx);
      const cliInputs = parseInputFlags(rawOpts.input ?? []);
      const outputMode = validateOutputMode(rawOpts.output ?? ctx.config.default_output);
      const opts: ExtractOptions = {
        ...rawOpts,
        resourceInputs: rawOpts.resourceInputsJson ?? rawOpts.resourceInputs,
        resourceInputMatrices: rawOpts.resourceInputMatricesJson ?? rawOpts.resourceInputMatrices,
        resourceInputMatrixConcurrency:
          rawOpts.resourceInputMatrixConcurrencyJson ?? rawOpts.resourceInputMatrixConcurrency,
        batchFormat: rawOpts.batchFormat ?? ctx.config.default_batch_format,
      };
      const embedConfigFromFile: EmbedConfigFile | undefined = resolveEmbedConfigFromOptions(
        opts.emitModelSpecSource,
        opts.embedConfigFile
      );
      let stateStore: StateStore;
      let state: ExtractorState;
      try {
        stateStore = resolveStateStore({
          defaultStateDir: path.join(ctx.cwd, ctx.config.state_dir),
          stateBackend: opts.stateBackend,
          stateAuthEnv: opts.stateAuthEnv,
          projectRoot: ctx.cwd,
        });
        state = await stateStore.load();
      } catch (err) {
        // State-backend construction or first-load failure — close the logger before bubbling.
        await logger.close();
        throw err;
      }
      const emitter = new Emitter(outputMode, path.join(ctx.cwd, ctx.config.output_dir), {
        defaultSchemaBehavior: ctx.config.default_load?.defaults?.schema_behavior,
      });

      if (opts.plan) {
        if (opts.integration || resourceNames.length > 0 || Object.keys(cliInputs).length > 0) {
          await emitter.close();
          await logger.close();
          throw new CommandError(
            'Cannot combine --plan with --integration, positional resources, or --input overrides.'
          );
        }

        try {
          await runExtractIntentPlan({
            ctx,
            logger,
            emitter,
            state,
            stateStore,
            opts,
            extractResource,
          });
        } finally {
          await emitter.close();
          await logger.close();
        }
        return;
      }

      const integrationNames = opts.integration
        ? [opts.integration]
        : findAllIntegrations(ctx.project);
      if (integrationNames.length === 0) {
        throw new CommandError(
          'No integrations specified. Use --integration <name> or define integration specs.'
        );
      }
      // `--resource-via` keys are resource spec names — they don't carry an
      // integration prefix. When the run sweeps multiple integrations the
      // same name could match different specs in each, and the override
      // would be applied (or fail validation) ambiguously. Require an
      // explicit `--integration` to scope the override.
      if (
        opts.resourceVia &&
        Object.keys(opts.resourceVia).length > 0 &&
        !opts.integration &&
        integrationNames.length > 1
      ) {
        throw new CommandError(
          'Pass --integration <name> when using --resource-via. Per-resource transport ' +
            'overrides are scoped to one integration; multi-integration runs cannot ' +
            'safely route them.'
        );
      }
      // Same ambiguity as --resource-via: keys are bare resource spec names, so
      // a multi-integration sweep could match different specs per integration.
      if (
        opts.resourceInputs &&
        Object.keys(opts.resourceInputs).length > 0 &&
        !opts.integration &&
        integrationNames.length > 1
      ) {
        throw new CommandError(
          'Pass --integration <name> when using --resource-inputs-json. Per-resource input ' +
            'overrides are scoped to one integration; multi-integration runs cannot ' +
            'safely route them.'
        );
      }
      if (
        opts.resourceInputMatrices &&
        Object.keys(opts.resourceInputMatrices).length > 0 &&
        !opts.integration &&
        integrationNames.length > 1
      ) {
        throw new CommandError(
          'Pass --integration <name> when using --resource-input-matrices-json. Matrix overrides are scoped to one integration.'
        );
      }

      const timeoutMs = parseInt(opts.timeout ?? '14400000', 10);
      const maxConsecutiveFailures = parseInt(opts.maxConsecutiveFailures ?? '5', 10);
      const runStartedAt = new Date();
      let timeoutReached = false;
      const timeoutHandle =
        isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              timeoutReached = true;
            }, timeoutMs)
          : undefined;

      let totalRecords = 0;
      let totalFailedResources = 0;
      const resourceResults: ResourceResult[] = [];

      try {
        await logger.progress('run_start', undefined, {
          integrations: integrationNames.length,
          configured_limit: opts.limit ?? null,
          timeout_ms: timeoutMs,
          max_consecutive_failures: maxConsecutiveFailures,
          full_refresh: opts.fullRefresh === true,
          batch: opts.batch === true,
          batch_format: opts.batchFormat ?? null,
        });

        for (const integrationName of integrationNames) {
          const integrationFile = findIntegrationFile(
            ctx.project,
            integrationName,
            ctx.bundledIntegrationsDir
          );
          const integrationResult = loadIntegrationSpecWithWarnings(integrationFile);
          for (const warning of integrationSpecWarningMessages(
            integrationName,
            integrationResult.warnings
          )) {
            await logger.warn(warning);
          }
          const integration = applyDefaultViaOverride(integrationResult.spec, opts.defaultVia);
          // Other sources keep their own order: a CDC slot moves with the saved state.
          const runStateStore =
            opts.stagedState !== undefined && isFileStorageSource(integration)
              ? openStagedState(ctx.cwd, stateStore, state, opts)
              : stateStore;
          let hostEnvNames: string[] | undefined;
          if (opts.hostEnvNamesJson !== undefined) {
            let names: unknown;
            try {
              names = JSON.parse(opts.hostEnvNamesJson);
            } catch {
              throw new CommandError('Invalid host environment declaration payload.', 2);
            }
            hostEnvNames = declaredHostEnvironmentNames(names as string[], process.env);
            integration.auth_env_vars = [...(integration.auth_env_vars ?? []), ...hostEnvNames];
          }
          if (opts.warehouse !== undefined && !isSnowflakeWarehouseSource(integration)) {
            throw new CommandError(
              '--warehouse is only supported when extracting from a Snowflake source.',
              2
            );
          }
          // Validate at the extractor boundary too — Dogsled-side cross-validation
          // is the authority for pipeline-authored configs, but `--resource-via`
          // is also reachable when the extractor is invoked standalone.
          validateResourceViaOverride(integration, opts.resourceVia);
          const resourceViaMap = opts.resourceVia;
          const resourceInputsMap = opts.resourceInputs;
          const allResourceEntries = findResourceFiles(ctx, integrationName).map((filePath) => {
            const result = loadResourceSpecWithWarnings(filePath);
            // Per-resource `--resource-via` override wins over the bundled
            // resource's own `via:` AND over the integration's
            // default_transport (already mutated by applyDefaultViaOverride).
            const viaShadow = resourceViaMap?.[result.spec.name];
            const spec = viaShadow ? { ...result.spec, via: viaShadow } : result.spec;
            return { spec, warnings: result.warnings, filePath };
          });
          const resources = allResourceEntries.filter(
            ({ spec }) => resourceNames.length === 0 || resourceNames.includes(spec.name)
          );
          // The pool is shared by every resource on this integration, so it is
          // seeded with the pipeline-wide `--input` values ONLY. Per-resource
          // overrides travel with each request instead (`inputOverrides` →
          // `client.request({ input })` / `callTool({ input })`), which both
          // clients merge ON TOP of these pooled values. Seeding the pool with
          // resource-specific values would leak them to siblings sharing the
          // same transport.
          const clientPool =
            'transport' in integration || 'transports' in integration
              ? new TransportClientPool({
                  integration,
                  cliInputs,
                  stateDir: path.join(ctx.cwd, ctx.config.state_dir),
                  // A host run trusts exactly what the host supplied. Only a
                  // run with no host may use a shipped source's own names.
                  trustedCredentialNames:
                    hostEnvNames ??
                    shippedSourceCredentialNames(
                      integrationFile,
                      integration,
                      resources.map(({ filePath }) => filePath)
                    ),
                })
              : undefined;
          const circuitBreaker = new ResourceCircuitBreaker(maxConsecutiveFailures);
          try {
            for (const { spec } of resources) {
              if (isLookupOnlyApiResource(spec)) {
                throw new CommandError(
                  `Resource "${integrationName}/${spec.name}" only supports lookup. Use "dogsled extract lookup" instead of "dogsled extract run".`
                );
              }
            }

            // Boundary validation for `--resource-inputs-json`: reject input
            // names the selected resources cannot accept before any request is
            // made, instead of failing mid-run with a bare `Unknown input`.
            validateResourceInputsOverride(
              resourceInputsMap,
              resources.map(({ spec }) => ({
                name: spec.name,
                ...('input' in spec ? { input: spec.input } : {}),
              }))
            );
            validateResourceInputMatricesOverride(
              opts.resourceInputMatrices,
              resources.map(({ spec }) => ({
                name: spec.name,
                ...('input' in spec ? { input: spec.input } : {}),
                ...('extract' in spec ? { extract: spec.extract } : {}),
              }))
            );
            validateResourceInputMatrixConcurrencyOverride(
              opts.resourceInputMatrixConcurrency,
              opts.resourceInputMatrices,
              resources.map(({ spec }) => ({ name: spec.name }))
            );

            // When explicit resource names are provided, respect their order
            if (resourceNames.length > 0) {
              const orderMap = new Map(resourceNames.map((name, i) => [name, i]));
              resources.sort(
                (a, b) => (orderMap.get(a.spec.name) ?? 0) - (orderMap.get(b.spec.name) ?? 0)
              );
            }

            if (resources.length === 0) {
              await logger.warn(`No resources found for integration "${integrationName}"`);
              continue;
            }

            const allApiResources = allResourceEntries
              .map(({ spec }) => spec)
              .filter(
                (spec): spec is ApiResourceSpec =>
                  !isWarehouseResource(spec) &&
                  !isFileStorageResource(spec) &&
                  !isLookupOnlyApiResource(spec)
              );
            const selectedApiResources = resources
              .map(({ spec }) => spec)
              .filter(
                (spec): spec is ApiResourceSpec =>
                  !isWarehouseResource(spec) &&
                  !isFileStorageResource(spec) &&
                  !isLookupOnlyApiResource(spec)
              );
            assertApiResourceSemanticsForExtraction(selectedApiResources, allApiResources);

            const billableResources = resources
              .map(({ spec }) => spec)
              .filter(
                (spec): spec is ApiResourceSpec =>
                  !isWarehouseResource(spec) &&
                  !isFileStorageResource(spec) &&
                  isBillableResource(spec)
              )
              .map((spec) => `${integrationName}/${spec.name}`);
            if (billableResources.length > 0) {
              throw new CommandError(
                `Billable resources require an explicit extract plan: ${billableResources.join(', ')}. ${billablePlanUsage()}`
              );
            }

            // Collect for_each parent records during extraction so children can
            // inherit parent output values as well as the parent inputs used to fetch them.
            const forEachCache = new Map<string, ForEachRecord[]>();

            // Determine which resources are for_each parents so we know what to cache.
            const parentResources = new Set<string>();
            for (const { spec } of resources) {
              const forEach = normalizeForEachConfig(
                spec.extract && 'for_each' in spec.extract ? spec.extract.for_each : undefined
              );
              const explicitInputs = mergeResourceInputs(
                filterInputsForResource(cliInputs, 'input' in spec ? spec.input : undefined),
                resourceInputsMap,
                spec.name
              );
              const shouldFanOut =
                forEach !== undefined && !hasExplicitForEachInputs(forEach, explicitInputs);
              if (forEach && shouldFanOut) {
                parentResources.add(forEach.resource);
              }
            }

            // Resources actually selected for THIS extraction process. A for_each
            // child can only read its parent's in-memory forEachCache when the parent
            // ran here too; if the parent isn't in this set the child can never fan
            // out, so an empty cache for it is a fatal orchestration error rather than
            // a benign "parent had no rows" skip (handled in the for_each loop below).
            const presentResources = new Set(resources.map(({ spec }) => spec.name));

            // Keep the caller's order for unrelated resources while ensuring
            // for_each parents always run before their children.
            const resourceOrderWarnings: string[] = [];
            const sortedResources = orderResourcesForExtraction(resources, {
              onWarning: (message) => resourceOrderWarnings.push(message),
            });
            for (const warning of resourceOrderWarnings) {
              await logger.warn(warning);
            }

            const { totalRecords: integrationRecords, failedResources } =
              await extractResourcesWithMatrices({
                sortedResources,
                integrationName,
                integration,
                clientPool,
                circuitBreaker,
                opts,
                emitter,
                logger,
                state,
                stateStore: runStateStore,
                batchDir: path.join(ctx.cwd, ctx.config.batch_dir),
                cliInputs,
                resourceInputsMap,
                forEachCache,
                parentResources,
                presentResources,
                runStartedAt,
                isTimedOut: () => timeoutReached,
                defaultSchemaBehavior: ctx.config.default_load?.defaults?.schema_behavior,
                embedConfigFromFile,
                resourceResults,
              });
            totalRecords += integrationRecords;

            totalFailedResources += failedResources;
            if (failedResources > 0) {
              await logger.warn(`${failedResources} resource(s) failed during extraction`);
            }
          } finally {
            await clientPool?.closeAll();
          }
        }

        const summary = buildRunSummary(integrationNames.join(','), runStartedAt, resourceResults);
        await logger.progress('run_complete', undefined, {
          status: summary.status,
          resources_succeeded: summary.totals.resources_succeeded,
          resources_failed: summary.totals.resources_failed,
          total_records: summary.totals.records_emitted,
          elapsed_ms: summary.elapsed_ms,
        });

        // Write summary to output dir if specified
        if (opts.outputDir) {
          const summaryPath = path.join(opts.outputDir, 'run_summary.json');
          const { writeFile } = await import('node:fs/promises');
          await writeFile(summaryPath, JSON.stringify(summary, null, 2));
        }

        await logger.info(`Extraction complete: ${totalRecords} total records`);
        if (totalFailedResources > 0) {
          process.exitCode = 1;
        }
      } finally {
        clearTimeout(timeoutHandle);
        await emitter.close();
        await logger.close();
      }
    });
}
