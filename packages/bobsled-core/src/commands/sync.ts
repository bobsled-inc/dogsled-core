import { mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  EnvSecretResolver,
  assertRunnerSupportsBindings,
  interpolateSecrets,
  resolveRunner,
} from '@bobsled-inc/connections';
import { resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import type { Command } from 'commander';
import YAML from 'yaml';

import { resolveActionProjectRoot } from '../lib/action-paths.js';
import * as fmt from '../lib/output/formatter.js';
import {
  loadSyncSpec,
  listSyncSpecs,
  runSync,
  resolveAction,
  validateInputMapping,
} from '../sync/index.js';
import { resolveSyncIntegration } from '../sync/run.js';

import type { GlobalOptions, OutputOptions } from '../types/index.js';
import type { SyncSpec } from '../sync/index.js';
import { localStateDir } from '@bobsled-inc/connections';

interface SyncOutputOptions {
  yaml?: boolean;
  projectRoot?: string;
}

interface SyncRunOptions extends SyncOutputOptions {
  dryRun?: boolean;
  limit?: string;
  stateDir?: string;
}

export function emitSyncResult(
  value: unknown,
  outputOpts: OutputOptions,
  localOpts: SyncOutputOptions = {}
): void {
  // Text mode has no table renderer for these results; YAML keeps them readable
  // instead of printing "[object Object]".
  if (localOpts.yaml || (!outputOpts.json && typeof value !== 'string')) {
    fmt.output(YAML.stringify(value, { lineWidth: 120 }).trimEnd(), { ...outputOpts, json: false });
    return;
  }
  fmt.output(value, outputOpts);
}

function assertStateDir(projectRoot: string, stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const root = realpathSync(projectRoot);
  const dir = realpathSync(stateDir);
  const rel = relative(root, dir);
  if (rel === '' || rel.startsWith('..')) {
    throw new CommandError(
      `--state-dir must be a subdirectory of the project root: ${stateDir}`,
      2
    );
  }
  return dir;
}

function summarizeSync(spec: SyncSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    tags: spec.tags,
    source: {
      connection: spec.source.connection,
      projection_ref: spec.source.projection_ref,
    },
    target: {
      action: spec.target.action,
    },
  };
}

async function validateSync(
  projectRoot: string,
  index: ProjectIndex,
  spec: SyncSpec
): Promise<void> {
  const action = resolveAction(spec, projectRoot, undefined, index);
  validateInputMapping(spec, action);

  const integration = resolveSyncIntegration(spec, index);
  const secretResolver = new EnvSecretResolver();
  const interpolated = await interpolateSecrets(integration, secretResolver);
  const runner = await resolveRunner(interpolated, { secretResolver });
  try {
    assertRunnerSupportsBindings(runner, spec.source.connection);
  } finally {
    await runner.close?.();
  }
}

export function registerSyncCommand(program: Command): void {
  const group = program
    .command('sync')
    .description('Run outbound sync actions from warehouse projections');

  group
    .command('list')
    .description('List sync specs in the current project')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option('--yaml', 'Emit results as YAML')
    .action((opts: SyncOutputOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const outputOpts = fmt.toOutputOptions(globalOptions);
      const projectRoot = resolveActionProjectRoot(
        globalOptions.config,
        opts.projectRoot ?? globalOptions.projectRoot
      );
      emitSyncResult(
        listSyncSpecs(projectRoot, resolveProjectIndex(projectRoot)).map((entry) =>
          summarizeSync(entry.spec)
        ),
        outputOpts,
        opts
      );
    });

  group
    .command('validate [name]')
    .description('Validate one sync spec or all sync specs')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option('--yaml', 'Emit results as YAML')
    .action(async (name: string | undefined, opts: SyncOutputOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const outputOpts = fmt.toOutputOptions(globalOptions);
      const projectRoot = resolveActionProjectRoot(
        globalOptions.config,
        opts.projectRoot ?? globalOptions.projectRoot
      );
      const project = resolveProjectIndex(projectRoot);
      const specs = name
        ? [loadSyncSpec(projectRoot, name, project)]
        : listSyncSpecs(projectRoot, project);
      for (const loaded of specs) {
        await validateSync(projectRoot, project, loaded.spec);
      }
      emitSyncResult(
        {
          valid: true,
          syncs: specs.map((entry) => ({ name: entry.name, file: entry.filePath })),
        },
        outputOpts,
        opts
      );
    });

  group
    .command('run <name>')
    .description('Run a sync end-to-end with durable local state')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option(
      '--dry-run',
      'Validate and dispatch without writing receipts or checkpoint state',
      false
    )
    .option('--limit <n>', 'Maximum records to process')
    .option('--state-dir <path>', 'State directory under the project root')
    .option('--yaml', 'Emit summary as YAML')
    .action(async (name: string, opts: SyncRunOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      const outputOpts = fmt.toOutputOptions(globalOptions);
      const projectRoot = resolveActionProjectRoot(
        globalOptions.config,
        opts.projectRoot ?? globalOptions.projectRoot
      );
      const project = resolveProjectIndex(projectRoot);
      const loaded = loadSyncSpec(projectRoot, name, project);
      const stateDir = assertStateDir(
        projectRoot,
        opts.stateDir
          ? resolve(projectRoot, opts.stateDir)
          : join(localStateDir(projectRoot), 'sync-state')
      );
      const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new CommandError('--limit must be a positive integer.', 2);
      }
      const summary = await runSync({
        spec: loaded.spec,
        projectRoot,
        index: project,
        dryRun: opts.dryRun,
        limit,
        stateDir,
      });
      emitSyncResult(summary, outputOpts, opts);
      if (summary.status === 'failed' || summary.status === 'aborted') {
        process.exitCode = 1;
      }
    });
}
