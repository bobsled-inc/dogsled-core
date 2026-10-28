/**
 * `model run` command — thin CLI wrapper over `runProject`.
 *
 * Execution, fan-out, state migration, and runner lifecycle live in
 * `../api/run-project.ts`. This file owns only arg parsing and stdout / stderr
 * formatting.
 *
 * Exit codes:
 *   0 = all models executed successfully
 *   1 = runtime error (runner dispatch or execution failure)
 *   2 = validation error
 */

import type { Command } from 'commander';

import { runProject } from '../api/run-project.js';
import { CommandError } from '../errors.js';
import * as out from '../output.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

interface RunOptions {
  integration?: string;
  fullRefresh?: boolean;
  dryRun?: boolean;
  secrets?: string;
  warehouse?: string;
  json?: boolean;
  yaml?: boolean;
}

type RunProjectResult = Awaited<ReturnType<typeof runProject>>;

function countUniqueModels(statements: RunProjectResult['byIntegration'][number]['statements']) {
  return new Set(statements.map((statement) => statement.modelName)).size;
}

function buildJsonPayload(result: RunProjectResult) {
  const totalStatements = result.byIntegration.reduce(
    (acc, group) => acc + group.statements.length,
    0
  );
  const totalModels = result.byIntegration.reduce(
    (acc, group) => acc + countUniqueModels(group.statements),
    0
  );
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
        // Normalize the internal `'success'` status to the kickoff/Host-application
        // contract value `'succeeded'`. Keeps the public JSON shape aligned
        // with `{name, status: 'succeeded' | 'failed' | 'skipped', error,
        // rows_affected}` while leaving model-spec internals untouched.
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

async function runHandler(
  modelNames: string[],
  localOptions: RunOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);
  if (localOptions.json && localOptions.yaml) {
    throw new CommandError('--json and --yaml cannot be used together', 2);
  }

  const machineOutput = Boolean(localOptions.json || localOptions.yaml);
  const silent = flags.quiet || machineOutput;
  const emittedWarnings = new Set<string>();
  const result = await runProject(process.cwd(), {
    integration: localOptions.integration,
    models: modelNames,
    fullRefresh: localOptions.fullRefresh,
    dryRun: localOptions.dryRun,
    secrets: localOptions.secrets,
    warehouse: localOptions.warehouse,
    verbose: flags.verbose,
    onInfo: silent ? undefined : (msg) => out.info(msg),
    onSuccess: silent ? undefined : (msg) => out.success(msg),
    onError: machineOutput ? undefined : (msg) => out.error(msg),
    onWarn:
      flags.quiet || machineOutput
        ? undefined
        : (msg) => {
            emittedWarnings.add(msg);
            out.warn(msg);
          },
  });

  if (localOptions.json) {
    out.jsonLine(buildJsonPayload(result));
    if (!result.ok) {
      throw new CommandError(summarizeFailures(result), resultExitCode(result));
    }
    return;
  }

  if (localOptions.yaml) {
    out.yaml(buildJsonPayload(result));
    if (!result.ok) {
      throw new CommandError(summarizeFailures(result), resultExitCode(result));
    }
    return;
  }

  if (!flags.quiet) {
    for (const w of result.warnings) {
      if (!emittedWarnings.has(w)) out.warn(w);
    }
    for (const s of result.skipped) out.warn(s.message);
  }

  if (result.byIntegration.length === 0) {
    if (!flags.quiet) out.info('No integrations produced any models — nothing to run.');
    if (!result.ok) throw new CommandError(summarizeFailures(result), resultExitCode(result));
    return;
  }

  const totalStatements = result.byIntegration.reduce((acc, g) => acc + g.statements.length, 0);

  if (totalStatements === 0) {
    if (!flags.quiet) out.info('No statements to execute (all models are ephemeral).');
    if (!result.ok) throw new CommandError(summarizeFailures(result), resultExitCode(result));
    return;
  }

  const multi = result.byIntegration.length > 1;

  if (result.dryRun) {
    if (!flags.quiet) out.info('Dry run — execution plan:');
    for (const group of result.byIntegration) {
      if (multi) process.stdout.write(`-- integration: ${group.handle}\n`);
      for (const stmt of group.statements) {
        process.stdout.write(`-- ${stmt.modelName}\n${stmt.sql}\n\n`);
      }
    }
    if (!flags.quiet) {
      const totalModels = result.byIntegration.reduce(
        (acc, g) => acc + new Set(g.statements.map((s) => s.modelName)).size,
        0
      );
      out.success(`Plan: ${totalStatements} statement(s) for ${totalModels} model(s).`);
    }
    if (!result.ok) throw new CommandError(summarizeFailures(result), resultExitCode(result));
    return;
  }

  let executedCount = 0;
  const failures: { handle: string; message: string }[] = [];
  for (const group of result.byIntegration) {
    if (multi && !flags.quiet && group.statements.length > 0) {
      out.info(`[${group.handle}] Executing ${group.statements.length} statement(s)...`);
    }
    if (group.error) {
      failures.push({ handle: group.handle, message: group.error });
    } else if (group.executionResults) {
      executedCount += group.executionResults.filter((r) => r.status !== 'failed').length;
    }
  }

  if (!flags.quiet) out.success(`Executed ${executedCount} statement(s).`);

  if (!result.ok || failures.length > 0) {
    throw new CommandError(summarizeFailures(result), resultExitCode(result));
  }
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Compile and execute models in DAG order via the integration runner')
    .argument(
      '[model...]',
      'dbt-style selection: a bare name runs EXACTLY that model; use +X for upstream, X+ for downstream, +X+ for both, tag:foo for tags (default: all)'
    )
    .addOption(createIntegrationOption())
    .option('--full-refresh', 'Force full refresh (CREATE TABLE) for the selected models')
    .option('--dry-run', 'Show execution plan without running')
    .option(
      '--secrets <path>',
      'Optional YAML file overlaying env-var values on top of process.env'
    )
    .option(
      '--warehouse <name>',
      'Snowflake session warehouse override for this run (ignored by other dialects)'
    )
    .option('--json', 'Output a single JSONL-compatible run summary')
    .option('--yaml', 'Output a YAML run summary')
    .action(async (modelNames: string[], opts: RunOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await runHandler(modelNames, opts, globalOptions);
    });
}
