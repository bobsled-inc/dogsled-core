import { createEmbedGroup, EMBED_SUBCOMMANDS } from '../groups/embed.js';
import { createEntityGraphGroup, ENTITY_GRAPH_SUBCOMMANDS } from '../groups/entity-graph.js';
import { createExtractGroup, EXTRACT_SUBCOMMANDS } from '../groups/extract.js';
import { createLoadGroup, LOAD_SUBCOMMANDS } from '../groups/load.js';
import { MCP_SUBCOMMANDS } from '../groups/mcp.js';
import { createModelGroup, MODEL_SUBCOMMANDS } from '../groups/model.js';
import { spawnCommand, waitForProcess } from './process.js';
import { resolveCliInvocation, resolveDogsledModelRunInvocation } from './workspace.js';

import type { Command } from 'commander';
import type { CliTarget } from './workspace.js';
import type { CommandInvocation, RunCommandDependencies } from './process.js';

const GROUP_BUILDERS = {
  embed: createEmbedGroup,
  extract: createExtractGroup,
  load: createLoadGroup,
  model: createModelGroup,
  'entity-graph': createEntityGraphGroup,
} satisfies Record<CliTarget, () => Command>;

const GROUP_SUBCOMMANDS = {
  embed: EMBED_SUBCOMMANDS,
  extract: EXTRACT_SUBCOMMANDS,
  load: LOAD_SUBCOMMANDS,
  model: MODEL_SUBCOMMANDS,
  'entity-graph': ENTITY_GRAPH_SUBCOMMANDS,
} satisfies Record<CliTarget, readonly string[]>;

export interface DelegationDependencies extends RunCommandDependencies {
  metaUrl?: string;
  env?: NodeJS.ProcessEnv;
  resolveDogsledModelRunInvocation?: (metaUrl: string, cliArgs: string[]) => CommandInvocation;
}

export async function runDelegatedCli(
  target: CliTarget,
  cliArgs: string[],
  dependencies: DelegationDependencies = {}
): Promise<number> {
  const invocation = resolveCliInvocation(target, dependencies.metaUrl ?? import.meta.url, cliArgs);

  const spawnOptions: import('node:child_process').SpawnOptions = {
    stdio: 'inherit',
    env: dependencies.env ?? process.env,
  };

  // Pass bundled integrations directory to the extractor subprocess
  if (target === 'extract') {
    try {
      const { getIntegrationsDir } = await import('@bobsled-inc/integrations');
      spawnOptions.env = {
        ...spawnOptions.env,
        DOGSLED_BUNDLED_INTEGRATIONS_DIR: getIntegrationsDir(),
      };
    } catch {
      // @bobsled-inc/integrations not available — local-only mode
    }
  }

  const child = spawnCommand(invocation, spawnOptions, dependencies);
  const result = await waitForProcess(child, `${target} CLI`);
  return result.exitCode;
}

export function createGroup(target: CliTarget): Command {
  return GROUP_BUILDERS[target]();
}

export async function maybeRunDelegatedCommand(
  argv: string[],
  dependencies: DelegationDependencies = {}
): Promise<{ exitCode?: number; handled: boolean }> {
  const group = argv[0];
  if (
    group !== 'extract' &&
    group !== 'mcp' &&
    group !== 'load' &&
    group !== 'model' &&
    group !== 'entity-graph' &&
    group !== 'embed' &&
    group !== 'activate' &&
    group !== 'query'
  ) {
    return { handled: false };
  }

  // `query` delegates to the loader subprocess (preserves the subprocess boundary for DuckDB)
  if (group === 'query') {
    const nextArg = argv[1];
    if (!nextArg || nextArg === '--help' || nextArg === '-h' || nextArg === 'help') {
      return { handled: false };
    }
    return {
      handled: true,
      exitCode: await runDelegatedCli('load', argv, dependencies),
    };
  }

  // `activate` delegates directly to entity-graph with the full argv preserved
  // (sync_name is a positional arg, not a subcommand name, so we skip the subcommand check)
  if (group === 'activate') {
    const nextArg = argv[1];
    if (
      !nextArg ||
      (argv.length === 2 && (nextArg === 'help' || nextArg === '--help' || nextArg === '-h'))
    ) {
      return { handled: false };
    }
    return {
      handled: true,
      exitCode: await runDelegatedCli('entity-graph', argv, dependencies),
    };
  }

  const cliTarget: CliTarget = group === 'mcp' ? 'extract' : group;
  const subcommands: readonly string[] =
    group === 'mcp' ? MCP_SUBCOMMANDS : GROUP_SUBCOMMANDS[cliTarget];
  const nextArg = argv[1];

  if (!nextArg || nextArg === 'help' || nextArg === '--help' || nextArg === '-h') {
    return { handled: false };
  }

  // The loader and embedder both accept bare flags without a subcommand name
  // (for example `dogsled load --format csv` or `dogsled embed --config-json ...`),
  // so those invocations are delegated immediately rather than falling through to Commander.
  if ((cliTarget === 'load' || cliTarget === 'embed') && nextArg.startsWith('-')) {
    return {
      handled: true,
      exitCode: await runDelegatedCli(cliTarget, argv.slice(1), dependencies),
    };
  }

  if (!subcommands.includes(nextArg)) {
    return { handled: false };
  }

  // `model run` uses a Dogsled-owned child entrypoint so the unified CLI process
  // preserves the same native-dependency subprocess boundary as the other ELT
  // commands while still injecting the cross-warehouse publisher.
  if (group === 'model' && nextArg === 'run') {
    const resolveInvocation =
      dependencies.resolveDogsledModelRunInvocation ?? resolveDogsledModelRunInvocation;
    const invocation = resolveInvocation(dependencies.metaUrl ?? import.meta.url, argv.slice(2));
    const child = spawnCommand(
      invocation,
      {
        stdio: 'inherit',
        env: dependencies.env ?? process.env,
      },
      dependencies
    );
    return {
      handled: true,
      exitCode: (await waitForProcess(child, 'model run CLI')).exitCode,
    };
  }

  const delegatedArgs = group === 'mcp' ? ['mcp', ...argv.slice(1)] : argv.slice(1);

  return {
    handled: true,
    exitCode: await runDelegatedCli(cliTarget, delegatedArgs, dependencies),
  };
}
