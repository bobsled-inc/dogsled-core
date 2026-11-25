import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { type Command, Option } from 'commander';

import { resolveStateStore } from '../runtime/state-backend.js';
import { commitStagedState, resolveStagedStatePath } from '../runtime/staged-state.js';
import { mergeDurableBookmark } from '../runtime/state.js';
import { createWarehouseClient } from '../runtime/warehouse-client.js';
import {
  isWarehouseResource,
  isWarehouseSource,
  resolveConnectionConfig,
} from '../runtime/warehouse-extractor.js';
import {
  buildCommandContext,
  type CommandContext,
  findIntegrationFile,
  findResourceFiles,
  loadIntegrationSpecWithWarnings,
  loadResourceSpecWithWarnings,
  parseGlobalFlags,
} from './common.js';
import { CommandError } from '@bobsled-inc/protocol';
import { isLookupOnlyApiResource } from '../framework/extractor/index.js';

import type { StateMessage } from '@bobsled-inc/protocol';
import type { StateStore, StreamBookmark } from '../runtime/state.js';
import type { IntegrationSpec, ResourceSpec } from '../types/index.js';
import type { WarehouseResourceSpec } from '../framework/extractor/index.js';
import type { WarehouseClient } from '../runtime/warehouse-client.js';

interface CommitOptions {
  integration: string;
  json?: boolean;
  logFormat?: string;
  quiet?: boolean;
  stateBackend?: string;
  verbose?: boolean;
}

export interface CommitStateOptions extends CommitOptions {
  captureFile: string;
}

interface CommitCommandOptions extends CommitOptions {
  captureFile?: string;
  /** State that the extractor kept for the pipeline, instead of captured STATE messages. */
  stagedState?: string;
}

interface PendingSlotAdvance {
  cursorValue: string;
  slotName: string;
}

function isIncrementalResource(resource: ResourceSpec): boolean {
  if (isWarehouseResource(resource)) {
    return resource.replication.method !== 'full_refresh';
  }

  if (isLookupOnlyApiResource(resource)) {
    return false;
  }

  return Boolean(resource.extract.incremental);
}

function isPostgresChangeTrackingResource(
  integration: IntegrationSpec,
  resource: WarehouseResourceSpec
): resource is WarehouseResourceSpec & {
  replication: WarehouseResourceSpec['replication'] & {
    change_tracking: {
      plugin?: 'pgoutput';
      publication_name: string;
      slot_name: string;
    };
  };
} {
  return (
    integration.source_type === 'postgres' && resource.replication.method === 'change_tracking'
  );
}

async function readStateMessages(captureFile: string): Promise<Map<string, StateMessage['value']>> {
  const captured = new Map<string, StateMessage['value']>();
  const rl = readline.createInterface({
    input: fs.createReadStream(captureFile),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith('{') || !line.includes('"STATE"')) {
      continue;
    }

    let parsed: StateMessage | null = null;
    try {
      const candidate = JSON.parse(line) as Partial<StateMessage>;
      if (candidate.type === 'STATE' && candidate.stream && candidate.value) {
        parsed = candidate as StateMessage;
      }
    } catch {
      continue;
    }

    if (parsed) {
      captured.set(parsed.stream, parsed.value);
    }
  }

  return captured;
}

function isWithinPath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildCommitContext(options: CommitOptions): CommandContext {
  return buildCommandContext(
    parseGlobalFlags({
      logFormat: options.json ? 'json' : options.logFormat,
      quiet: options.quiet,
      verbose: options.verbose,
    })
  );
}

function openStateStore(ctx: CommandContext, options: CommitOptions): StateStore {
  return resolveStateStore({
    defaultStateDir: path.join(ctx.cwd, ctx.config.state_dir),
    projectRoot: ctx.cwd,
    ...(options.stateBackend ? { stateBackend: options.stateBackend } : {}),
  });
}

async function commitState({
  captureFile,
  stagedState,
  ...options
}: CommitCommandOptions): Promise<number> {
  if (stagedState !== undefined) {
    const ctx = buildCommitContext(options);
    const stagedPath = resolveStagedStatePath(ctx.cwd, stagedState);
    await commitStagedState(openStateStore(ctx, options), stagedPath);
    return 0;
  }
  if (captureFile === undefined) throw new CommandError('Missing --capture-file <path>.', 2);
  return commitCapturedState({ ...options, captureFile });
}

export async function commitCapturedState(options: CommitStateOptions): Promise<number> {
  const ctx = buildCommitContext(options);
  const capturePath = path.resolve(ctx.cwd, options.captureFile);
  let realCapturePath: string;
  try {
    realCapturePath = fs.realpathSync(capturePath);
  } catch {
    throw new CommandError(`Capture file not found: ${options.captureFile}`, 2);
  }
  const allowedRoots = [os.tmpdir(), ctx.cwd].map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
  if (!allowedRoots.some((root) => isWithinPath(realCapturePath, root))) {
    throw new CommandError('Capture file must be within temp directory or project root', 2);
  }
  const stateStore = openStateStore(ctx, options);
  const state = await stateStore.load();
  const captured = await readStateMessages(realCapturePath);

  if (captured.size === 0) {
    return 0;
  }

  const integration = loadIntegrationSpecWithWarnings(
    findIntegrationFile(ctx.project, options.integration, ctx.bundledIntegrationsDir)
  ).spec;
  const resources = findResourceFiles(ctx, options.integration)
    .map((filePath) => loadResourceSpecWithWarnings(filePath).spec)
    .filter((resource) => captured.has(resource.name));

  let warehouseClient: WarehouseClient | undefined;
  const pendingSlotAdvances: PendingSlotAdvance[] = [];

  try {
    for (const resource of resources) {
      if (!isIncrementalResource(resource)) {
        continue;
      }

      const bookmark = captured.get(resource.name);
      if (!bookmark) {
        continue;
      }

      const streamKey = `${options.integration}/${resource.name}`;
      const runAt = bookmark.last_run_at ?? state.streams[streamKey]?.last_run_at;
      if (!runAt) {
        throw new CommandError(`Captured STATE for "${resource.name}" is missing last_run_at.`, 2);
      }

      const candidateBookmark: StreamBookmark = {
        ...bookmark,
        last_run_at: runAt,
      };
      const durableBookmark = mergeDurableBookmark(
        state.streams[streamKey],
        candidateBookmark,
        candidateBookmark.cursor_type,
        runAt
      );

      if (!durableBookmark) {
        continue;
      }

      state.streams[streamKey] = durableBookmark;

      if (
        isWarehouseSource(integration) &&
        isWarehouseResource(resource) &&
        isPostgresChangeTrackingResource(integration, resource) &&
        durableBookmark.cursor_value
      ) {
        pendingSlotAdvances.push({
          cursorValue: durableBookmark.cursor_value,
          slotName: resource.replication.change_tracking.slot_name,
        });
      }
    }

    await stateStore.save(state);

    if (pendingSlotAdvances.length > 0) {
      warehouseClient ??= await createWarehouseClient(
        'postgres',
        resolveConnectionConfig(integration)
      );

      if (!warehouseClient.advanceReplicationSlot) {
        throw new CommandError(
          `Warehouse client for integration "${options.integration}" cannot advance replication slots.`
        );
      }

      for (const advance of pendingSlotAdvances) {
        await warehouseClient.advanceReplicationSlot(advance.slotName, advance.cursorValue);
      }
    }

    return 0;
  } finally {
    await warehouseClient?.close();
  }
}

export function registerCommitStateCommand(program: Command): void {
  program
    .command('commit-state')
    .description('Commit captured extractor STATE messages to durable state')
    .requiredOption('--integration <name>', 'Integration to commit state for')
    .option('--capture-file <path>', 'Captured extractor stdout JSONL file')
    .addOption(new Option('--staged-state <path>').hideHelp())
    .option('--json', 'Output machine-readable JSON')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-format <format>', 'Log format: json or pretty')
    .option('--state-backend <url>', 'State backend override used by the captured extraction')
    .action(async (opts: CommitCommandOptions) => {
      process.exitCode = await commitState(opts);
    });
}
