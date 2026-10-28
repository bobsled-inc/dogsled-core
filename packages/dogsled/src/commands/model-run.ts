import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { runProject, type RunProjectResult } from '@bobsled-inc/model-spec/project';
import { CommandError } from '@bobsled-inc/protocol';

import * as fmt from '../lib/output/formatter.js';
import type { OutputOptions } from '../types/index.js';
import { publishCrossWarehouse } from '../runtime/cross-warehouse.js';
import { runProjectWithLazySources } from '../runtime/source-materializer/run-project-with-lazy-sources.js';
import { loadApiResourceEntries } from '../runtime/source-materializer/load-specs.js';

interface ParsedModelRunArgs {
  agentExecutor?: string;
  agentAllowBillableSources?: string[];
  agentRunId?: string;
  agentResume?: boolean;
  agentTokensPerAssignment?: number;
  agentConcurrency?: number;
  agentMinDispatchIntervalMs?: number;
  integration?: string;
  fullRefresh?: boolean;
  dryRun?: boolean;
  secrets?: string;
  projectRoot?: string;
  json?: boolean;
  yaml?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  models: string[];
}

function countUniqueModels(statements: RunProjectResult['byIntegration'][number]['statements']) {
  return new Set(statements.map((statement) => statement.modelName)).size;
}

function countPlannedModels(result: RunProjectResult): number {
  return result.byIntegration.reduce(
    (acc, group) => acc + Math.max(countUniqueModels(group.statements), group.models.length),
    0
  );
}

function countStatements(result: RunProjectResult): number {
  return result.byIntegration.reduce((acc, group) => acc + group.statements.length, 0);
}

function buildJsonPayload(result: RunProjectResult) {
  const totalStatements = countStatements(result);
  const totalModels = countPlannedModels(result);
  const executionResults = result.byIntegration.flatMap((group) => group.executionResults ?? []);
  const failedResults = executionResults.filter((entry) => entry.status === 'failed');
  const skippedResults = executionResults.filter((entry) => entry.status === 'skipped');

  return {
    command: 'model.run',
    ok: result.ok,
    dry_run: result.dryRun,
    totals: {
      integrations: result.byIntegration.length,
      statements: totalStatements,
      models: totalModels,
      executed: executionResults.length,
      failed: failedResults.length,
      skipped: skippedResults.length,
    },
    warnings: result.warnings,
    skipped_integrations: result.skipped,
    integrations: result.byIntegration.map((group) => ({
      handle: group.handle,
      dialect: group.dialect,
      target_schema: group.targetSchema,
      target_database: group.targetDatabase,
      statement_count: group.statements.length,
      models: group.models.map((model) => ({
        name: model.name,
        materialization_type: model.materializationType,
        last_run_at: model.lastRunAt ?? null,
      })),
      statements: result.dryRun
        ? group.statements.map((statement) => ({
            model_name: statement.modelName,
            sql: statement.sql,
          }))
        : undefined,
      execution_results: group.executionResults?.map((entry) => ({
        model_name: entry.modelName,
        status: entry.status === 'success' ? 'succeeded' : entry.status,
        error: entry.error,
        rows_affected: entry.rowsAffected,
      })),
      error: group.error,
      deferred_models: group.deferredModels,
    })),
  };
}

function summarizeFailures(result: RunProjectResult): string {
  const failures = result.byIntegration
    .filter((group) => group.error)
    .map((group) => ({ handle: group.handle, message: group.error ?? 'unknown failure' }));
  const summary = failures.map((f) => `  - [${f.handle}] ${f.message}`).join('\n');
  return `Failures across ${failures.length} integration(s):\n${summary}`;
}

function resultExitCode(result: RunProjectResult): number {
  if (result.ok) return 0;
  const executionResults = result.byIntegration.flatMap((group) => group.executionResults ?? []);
  return executionResults.some((entry) => entry.status === 'failed' && entry.exitCode === 3)
    ? 3
    : 1;
}

function writeHumanSummary(result: RunProjectResult, options: OutputOptions): number {
  if (options.quiet) return resultExitCode(result);

  if (result.byIntegration.length === 0) {
    fmt.warn('No integrations produced any models - nothing to run.', options);
    return resultExitCode(result);
  }

  const totalStatements = countStatements(result);
  const totalModels = countPlannedModels(result);
  if (totalStatements === 0 && totalModels === 0) {
    fmt.warn('No statements to execute (all models are ephemeral).', options);
    return resultExitCode(result);
  }

  if (result.dryRun) {
    fmt.info('Dry run - execution plan:', options);
    const multi = result.byIntegration.length > 1;
    for (const group of result.byIntegration) {
      // The SQL plan itself is data, not chrome — write it to stdout directly
      // so consumers can pipe it into a `.sql` file. Diagnostic chrome above
      // and below goes through fmt.info per Dogsled conventions.
      if (multi) process.stdout.write(`-- integration: ${group.handle}\n`);
      const statementModels = new Set(group.statements.map((statement) => statement.modelName));
      for (const statement of group.statements) {
        process.stdout.write(`-- ${statement.modelName}\n${statement.sql}\n\n`);
      }
      for (const model of group.models) {
        if (statementModels.has(model.name)) continue;
        process.stdout.write(
          `-- ${model.name}\n-- cross-warehouse publish evaluated at runtime\n\n`
        );
      }
    }
    fmt.info(`Plan: ${totalStatements} statement(s) for ${totalModels} model(s).`, options);
    return resultExitCode(result);
  }

  const succeededCount = result.byIntegration.reduce(
    (acc, group) =>
      acc + (group.executionResults ?? []).filter((entry) => entry.status === 'success').length,
    0
  );
  const skippedCount = result.byIntegration.reduce(
    (acc, group) =>
      acc + (group.executionResults ?? []).filter((entry) => entry.status === 'skipped').length,
    0
  );
  const skippedSuffix = skippedCount > 0 ? `, ${skippedCount} skipped` : '';
  fmt.success(`Executed ${succeededCount} model operation(s)${skippedSuffix}.`, options);
  return resultExitCode(result);
}

function parseArgs(args: string[]): ParsedModelRunArgs {
  const parsed: ParsedModelRunArgs = { models: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    switch (arg) {
      case '--agent-allow-billable-source':
        (parsed.agentAllowBillableSources ??= []).push(requireValue(args, i++, arg));
        break;
      case '--agent-executor':
        parsed.agentExecutor = requireValue(args, i++, arg);
        break;
      case '--agent-run-id':
        parsed.agentRunId = requireValue(args, i++, arg);
        break;
      case '--agent-resume':
        parsed.agentResume = true;
        break;
      case '--agent-concurrency':
        parsed.agentConcurrency = Number(requireValue(args, i++, arg));
        if (
          !Number.isSafeInteger(parsed.agentConcurrency) ||
          parsed.agentConcurrency < 1 ||
          parsed.agentConcurrency > 64
        ) {
          throw new CommandError('Agent concurrency must be an integer from 1 to 64', 2);
        }
        break;
      case '--agent-min-dispatch-interval-ms':
        parsed.agentMinDispatchIntervalMs = Number(requireValue(args, i++, arg));
        if (
          !Number.isSafeInteger(parsed.agentMinDispatchIntervalMs) ||
          parsed.agentMinDispatchIntervalMs < 0 ||
          parsed.agentMinDispatchIntervalMs > 60000
        ) {
          throw new CommandError(
            'Agent minimum dispatch interval must be an integer from 0 to 60000',
            2
          );
        }
        break;
      case '--agent-tokens-per-assignment':
        parsed.agentTokensPerAssignment = Number(requireValue(args, i++, arg));
        if (
          !Number.isSafeInteger(parsed.agentTokensPerAssignment) ||
          parsed.agentTokensPerAssignment <= 0
        ) {
          throw new CommandError('Agent tokens per assignment must be a positive integer', 2);
        }
        break;
      case '--integration':
      case '-i':
        parsed.integration = requireValue(args, i, arg);
        i += 1;
        break;
      case '--full-refresh':
        parsed.fullRefresh = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--secrets':
        parsed.secrets = requireValue(args, i, arg);
        i += 1;
        break;
      case '--project-root':
        parsed.projectRoot = requireValue(args, i, arg);
        i += 1;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--yaml':
        parsed.yaml = true;
        break;
      case '--quiet':
      case '-q':
        parsed.quiet = true;
        break;
      case '--verbose':
      case '-v':
        parsed.verbose = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new CommandError(`Unknown model run option: ${arg}`, 2);
        }
        parsed.models.push(arg);
        break;
    }
  }
  if (parsed.json && parsed.yaml) {
    throw new CommandError('--json and --yaml cannot be used together', 2);
  }
  if (parsed.agentResume && !parsed.agentRunId) {
    throw new CommandError('--agent-resume requires --agent-run-id', 2);
  }
  if (
    !parsed.agentExecutor &&
    (parsed.agentAllowBillableSources ||
      parsed.agentRunId ||
      parsed.agentResume ||
      parsed.agentTokensPerAssignment ||
      parsed.agentConcurrency !== undefined ||
      parsed.agentMinDispatchIntervalMs !== undefined)
  ) {
    throw new CommandError('Agent run options require --agent-executor', 2);
  }
  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CommandError(`${flag} requires a value`, 2);
  }
  return value;
}

function shouldAutoActivateJson(options: ParsedModelRunArgs): boolean {
  // Mirrors the Dogsled-wide convention: JSON mode auto-activates in CI,
  // when stdout is not a TTY, or when DOGSLED_OUTPUT_FORMAT=json is set.
  // --yaml or explicit --json take precedence and disable auto-activation.
  if (options.json || options.yaml) return false;
  if (process.env['DOGSLED_OUTPUT_FORMAT'] === 'json') return true;
  if (process.env['CI']) return true;
  if (process.stdout && process.stdout.isTTY === false) return true;
  return false;
}

function emitFatalError(
  error: unknown,
  options: { json?: boolean; yaml?: boolean; agentRunId?: string }
): number {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = error instanceof CommandError ? error.exitCode : 1;
  if (options.json || options.yaml) {
    // Mirror the success-path envelope shape for machine consumers so a hard
    // failure is still parseable rather than raw stderr text.
    const payload = {
      command: 'model.run',
      ...(options.agentRunId ? { agent_run_id: options.agentRunId } : {}),
      ok: false,
      error: {
        message,
        exit_code: exitCode,
      },
    };
    const serialized = options.yaml ? YAML.stringify(payload) : `${JSON.stringify(payload)}\n`;
    process.stdout.write(serialized);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return exitCode;
}

export async function runDogsledModelRunCommand(args: string[]): Promise<number> {
  const valueFlags = new Set([
    '--integration',
    '-i',
    '--secrets',
    '--project-root',
    '--agent-allow-billable-source',
    '--agent-executor',
    '--agent-run-id',
    '--agent-tokens-per-assignment',
    '--agent-concurrency',
    '--agent-min-dispatch-interval-ms',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help' || args[index] === '-h' || args[index] === 'help') {
      process.stdout.write(`Usage: dogsled model run [models...] [options]

Run models in dependency order.

  -i, --integration <handle>       Select an integration
  --full-refresh                   Rebuild models
  --dry-run                        Show the plan without execution
  --secrets <path>                  Load secret environment values
  --project-root <path>             Select the Dogsled Project root
  --agent-allow-billable-source <ref>  Allow paid queries for this source (repeatable)
  --agent-executor <path|typesafe>  Local executor module or built-in Jev classification
  --agent-run-id <id>               Run identity (default: new UUID)
  --agent-resume                    Resume the explicit run ID
  --agent-tokens-per-assignment <n>  Legacy token allowance per attempt (default: YAML limits)
  --agent-concurrency <n>           Active assignments, 1–64 (default: 1)
  --agent-min-dispatch-interval-ms <n>  Delay between starts, 0–60000 ms (default: 0)
  --json / --yaml                   Structured result output
  -q, --quiet                       Suppress progress
  -v, --verbose                     Show details
`);
      return 0;
    }
    if (valueFlags.has(args[index]!)) index += 1;
  }
  let options: ParsedModelRunArgs;
  try {
    options = parseArgs(args);
    const autoJson = shouldAutoActivateJson(options);
    if (autoJson) options.json = true;
  } catch (error) {
    // Argument-parse failures happen before `options` is available, so the
    // full `shouldAutoActivateJson` heuristic can't run. Honor explicit
    // --json / --yaml flags from argv first; otherwise mirror the auto-
    // activation inputs (CI, non-TTY stdout, DOGSLED_OUTPUT_FORMAT=json)
    // so machine consumers always get a structured envelope, never opaque
    // stderr.
    const explicitYaml = args.includes('--yaml');
    const explicitJson = args.includes('--json');
    const autoJson =
      process.env['DOGSLED_OUTPUT_FORMAT'] === 'json' ||
      Boolean(process.env['CI']) ||
      (process.stdout && process.stdout.isTTY === false);
    return emitFatalError(error, {
      yaml: explicitYaml,
      json: explicitJson || (!explicitYaml && autoJson),
    });
  }

  const outputOptions: OutputOptions = {
    json: Boolean(options.json),
    quiet: Boolean(options.quiet),
    verbose: Boolean(options.verbose),
    noColor: process.env['NO_COLOR'] !== undefined,
  };
  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  const agentRunId = options.agentExecutor ? (options.agentRunId ?? randomUUID()) : undefined;
  // Report identity before loading or execution so failures can be resumed.
  if (agentRunId) process.stderr.write(`Agentic run ID: ${agentRunId}\n`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (agentRunId) {
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
  }
  try {
    const agentic = options.agentExecutor
      ? {
          run: {
            id: agentRunId!,
            mode: options.agentResume ? ('resume' as const) : ('start' as const),
          },
          host: await (
            await import('../runtime/cli-agentic-host.js')
          ).createCliAgenticHost({
            cwd: projectRoot,
            executorPath: options.agentExecutor,
            dryRun: options.dryRun,
            tokensPerAssignment: options.agentTokensPerAssignment,
            concurrency: options.agentConcurrency ?? 1,
            minDispatchIntervalMs: options.agentMinDispatchIntervalMs ?? 0,
            secrets: options.secrets,
            allowBillableSources: options.agentAllowBillableSources,
          }),
        }
      : undefined;
    const machineOutput = Boolean(options.json || options.yaml);
    const silent = options.quiet || machineOutput;
    const emittedWarnings = new Set<string>();
    // Shared model-build options reused by both the plain and the
    // source-hydrating paths so output behavior stays identical.
    const runProjectOptions = {
      ...(agentRunId ? { signal: controller.signal } : {}),
      ...(agentic ? { agentic } : {}),
      fullRefresh: options.fullRefresh,
      dryRun: options.dryRun,
      secrets: options.secrets,
      verbose: options.verbose,
      // Keep model SQL and cross-warehouse publish on the same managed-token
      // path as loader destinations. runProject turns this command into one
      // refreshable provider shared by all warehouse runners.
      credentialsTokenCommand: process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'],
      crossWarehousePublisher: publishCrossWarehouse,
      // Route runProject's lifecycle callbacks through the formatter so
      // --quiet, --verbose, --json all behave consistently across Dogsled CLI.
      onInfo: silent ? undefined : (msg: string) => fmt.info(msg, outputOptions),
      onSuccess: silent ? undefined : (msg: string) => fmt.success(msg, outputOptions),
      onError: machineOutput ? undefined : (msg: string) => fmt.error(msg, outputOptions),
      onWarn:
        options.quiet || machineOutput
          ? undefined
          : (msg: string) => {
              emittedWarnings.add(msg);
              fmt.warn(msg, outputOptions);
            },
    };

    // Auto-detect live/lazy api_resource sources. When present (and not a dry
    // run, which performs no API fetch), hydrate them into the model
    // integration's DuckDB before building the model DAG. Projects without
    // live/lazy sources take the unchanged plain runProject path, preserving
    // multi-integration fan-out.
    const apiResourceEntries = options.dryRun ? [] : await loadApiResourceEntries(projectRoot);
    const hasLiveLazySources = apiResourceEntries.some((entry) => {
      // A missing mode defaults to `lazy` (matching the orchestrator's
      // `entry.mode ?? 'lazy'`), so only an explicit `extract` opts out of
      // hydration — an unset mode must still route through the orchestrator.
      const mode = entry.mode ?? 'lazy';
      return mode === 'live' || mode === 'lazy';
    });

    let result: RunProjectResult;
    if (hasLiveLazySources) {
      const orchestrated = await runProjectWithLazySources({
        projectRoot,
        ...(options.integration !== undefined ? { integration: options.integration } : {}),
        models: options.models,
        apiResourceEntries,
        runProjectOptions,
        onReceipt: silent ? undefined : (line) => fmt.info(line, outputOptions),
      });
      result = orchestrated.run;
    } else {
      result = await runProject(projectRoot, {
        integration: options.integration,
        models: options.models,
        ...runProjectOptions,
      });
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ...buildJsonPayload(result), ...(agentRunId ? { agent_run_id: agentRunId } : {}) })}\n`
      );
      if (!result.ok) {
        // Failure summary on stderr (machine consumers parse the JSON payload
        // for full detail; stderr is operator chrome only).
        process.stderr.write(`${summarizeFailures(result)}\n`);
        return resultExitCode(result);
      }
      return 0;
    }

    if (options.yaml) {
      process.stdout.write(
        `${YAML.stringify({ ...buildJsonPayload(result), ...(agentRunId ? { agent_run_id: agentRunId } : {}) })}\n`
      );
      if (!result.ok) {
        process.stderr.write(`${summarizeFailures(result)}\n`);
        return resultExitCode(result);
      }
      return 0;
    }

    if (!options.quiet) {
      for (const warning of result.warnings) {
        if (!emittedWarnings.has(warning)) fmt.warn(warning, outputOptions);
      }
      for (const skipped of result.skipped) fmt.info(skipped.message, outputOptions);
    }

    const exitCode = writeHumanSummary(result, outputOptions);
    if (!result.ok) {
      fmt.error(summarizeFailures(result), outputOptions);
      return exitCode;
    }

    return exitCode;
  } catch (error) {
    return emitFatalError(error, { json: options.json, yaml: options.yaml, agentRunId });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export async function runDogsledModelRunCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runDogsledModelRunCommand(argv);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await runDogsledModelRunCli();
}
