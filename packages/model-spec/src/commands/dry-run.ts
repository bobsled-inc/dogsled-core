/**
 * `model dry-run` command — thin CLI wrapper over `dryRunProject`.
 *
 * Compiles a set of draft models with their interdependencies inlined as CTEs,
 * wraps each compiled SELECT with a sandbox-safe envelope, and executes against
 * the integration's resolved runner.
 *
 * Exit codes:
 *   0 = every requested model dry-ran successfully
 *   1 = at least one model failed dry-run (compile or warehouse error)
 *   2 = validation error (unknown model name, bad option)
 */

import { InvalidArgumentError, type Command } from 'commander';

import { dryRunProject, type DryRunMode } from '../api/dry-run-project.js';
import { CommandError } from '../errors.js';
import * as out from '../output.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

interface DryRunOptions {
  integration?: string;
  targets?: string[];
  mode?: DryRunMode;
  rowLimit?: string;
  secrets?: string;
  json?: boolean;
  yaml?: boolean;
}

type DryRunResult = Awaited<ReturnType<typeof dryRunProject>>;

const DRY_RUN_MODES: readonly DryRunMode[] = ['parse', 'limit0', 'sample'] as const;

function isDryRunMode(value: string): value is DryRunMode {
  return (DRY_RUN_MODES as readonly string[]).includes(value);
}

function parseModeOption(value: string): DryRunMode {
  if (!isDryRunMode(value)) {
    throw new InvalidArgumentError(`--mode must be one of: ${DRY_RUN_MODES.join(', ')}`);
  }
  return value;
}

function parseRowLimit(value: string): string {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`--row-limit must be a non-negative integer (got "${value}")`);
  }
  return value;
}

function collectTargets(value: string, prev: string[] = []): string[] {
  prev.push(
    ...value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return prev;
}

function buildJsonPayload(result: DryRunResult, mode: DryRunMode) {
  const allResults = result.byIntegration.flatMap((g) => g.results);
  return {
    command: 'model.dry_run',
    ok: result.ok,
    mode,
    totals: {
      integrations: result.byIntegration.length,
      models: allResults.length,
      failed: allResults.filter((r) => r.status === 'failed').length,
    },
    warnings: result.warnings,
    skipped_integrations: result.skipped,
    integrations: result.byIntegration.map((g) => ({
      handle: g.handle,
      dialect: g.dialect,
      error: g.error,
      models: g.results.map((r) => ({
        name: r.modelName,
        status: r.status,
        error: r.error,
        sql: r.sql || undefined,
      })),
    })),
  };
}

async function dryRunHandler(
  drafts: string[],
  localOptions: DryRunOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean; json?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);
  const mode: DryRunMode = localOptions.mode ?? 'limit0';
  const rowLimit =
    localOptions.rowLimit !== undefined ? Number.parseInt(localOptions.rowLimit, 10) : undefined;

  const result = await dryRunProject(process.cwd(), {
    integration: localOptions.integration,
    drafts: drafts.length > 0 ? drafts : undefined,
    targets: localOptions.targets,
    mode,
    rowLimit,
    secrets: localOptions.secrets,
  });

  for (const w of result.warnings) out.warn(w);
  for (const s of result.skipped) out.warn(s.message);

  const wantJson = flags.json || Boolean(localOptions.json);
  const wantYaml = Boolean(localOptions.yaml);

  if (wantJson) {
    out.json(buildJsonPayload(result, mode));
  } else if (wantYaml) {
    out.yaml(buildJsonPayload(result, mode));
  } else {
    if (result.byIntegration.length === 0) {
      if (!flags.quiet) out.info('No integrations produced any models — nothing to dry-run.');
      return;
    }

    for (const group of result.byIntegration) {
      if (!flags.quiet) {
        out.info(`[${group.handle}] dialect=${group.dialect} mode=${mode}`);
      }
      for (const r of group.results) {
        if (r.status === 'ok') {
          if (!flags.quiet) out.success(`[${group.handle}] ${r.modelName}: ok`);
        } else {
          out.error(`[${group.handle}] ${r.modelName}: ${r.error ?? 'failed'}`);
        }
      }
      if (group.error && group.results.length === 0) {
        out.error(`[${group.handle}] ${group.error}`);
      }
    }
  }

  if (!result.ok) {
    const failed = result.byIntegration
      .flatMap((g) => g.results)
      .filter((r) => r.status === 'failed');
    throw new CommandError(
      failed.length > 0
        ? `${failed.length} model(s) failed dry-run.`
        : 'Dry-run failed (see per-integration errors above).',
      1
    );
  }
}

export function registerDryRunCommand(program: Command): void {
  program
    .command('dry-run')
    .description(
      'Execute models against the warehouse without persisting (inlines draft deps as CTEs). ' +
        'Wraps each compiled SELECT in a sandbox-safe envelope and runs it via the integration runner.'
    )
    .argument(
      '[draft...]',
      'Model names to inline as CTEs (defaults to every model in the integration)'
    )
    .option(
      '-t, --targets <names>',
      'Subset to actually execute (comma-separated or repeatable; defaults to the draft set)',
      collectTargets,
      [] as string[]
    )
    .addOption(createIntegrationOption())
    .option<DryRunMode>(
      '--mode <mode>',
      `Envelope mode: ${DRY_RUN_MODES.join(' | ')} (default: limit0)`,
      parseModeOption,
      'limit0'
    )
    .option('--row-limit <n>', 'Row limit for `sample` mode (default: 10)', parseRowLimit)
    .option('--secrets <path>', 'YAML file with secret overrides for integration credentials')
    .option('--json', 'Emit a single JSON payload to stdout')
    .option('--yaml', 'Emit a YAML payload to stdout')
    .action(async (drafts: string[], opts: DryRunOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean; json?: boolean }>();
      const targets = opts.targets && opts.targets.length > 0 ? opts.targets : undefined;
      await dryRunHandler(drafts, { ...opts, targets }, globalOptions);
    });
}
