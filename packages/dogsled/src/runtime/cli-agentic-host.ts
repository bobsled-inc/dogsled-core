import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTokenCommandProvider } from '@bobsled-inc/connections';
import type { AgenticHost, ExecuteAgent } from '@bobsled-inc/model-spec/agentic';
import { loadProject, buildSecretResolver } from '@bobsled-inc/model-spec/project';
import { CommandError } from '@bobsled-inc/protocol';
import { findDogsledProject } from '../runner/config/loader.js';
import { loadProjectPipelineConfig } from '../runner/config/project-resolver.js';
import { createJevExecutor } from './jev-executor.js';
import { createAgenticHost } from './agentic-host.js';

/** A local module is trusted host code, just like a local SQL runner. */
export async function loadAgentExecutor(modulePath: string): Promise<ExecuteAgent> {
  const resolved = path.resolve(modulePath);
  const label = path.isAbsolute(modulePath) ? path.basename(modulePath) : modulePath;
  if (!existsSync(resolved)) throw new CommandError(`Agent executor module not found: ${label}`, 2);
  try {
    const namespace: unknown = await import(pathToFileURL(realpathSync(resolved)).href);
    if (
      namespace &&
      typeof namespace === 'object' &&
      'executeAgent' in namespace &&
      typeof namespace.executeAgent === 'function'
    ) {
      return namespace.executeAgent as ExecuteAgent;
    }
  } catch {
    // Module errors can contain environment values. Do not echo them.
    throw new CommandError(`Failed to load agent executor: ${label}`, 1);
  }
  throw new CommandError(`Agent executor ${label} must export an executeAgent function`, 2);
}

export async function createCliAgenticHost(options: {
  cwd: string;
  executorPath: string;
  tokensPerAssignment?: number;
  concurrency?: number;
  minDispatchIntervalMs?: number;
  secrets?: string;
  allowBillableSources?: string[];
  dryRun?: boolean;
}): Promise<AgenticHost> {
  const secretResolver = await buildSecretResolver(options.cwd, options.secrets);
  const executeAgent: ExecuteAgent = options.dryRun
    ? async () => {
        throw new CommandError('Dry runs cannot execute agent assignments', 2);
      }
    : options.executorPath === 'typesafe'
      ? createJevExecutor({ secretResolver })
      : await loadAgentExecutor(path.resolve(options.cwd, options.executorPath));
  const project = await loadProject(options.cwd, { skipEntities: true });
  const projectLocation = findDogsledProject(options.cwd);
  const platform = projectLocation
    ? loadProjectPipelineConfig({
        projectRoot: projectLocation.projectRoot,
        index: projectLocation.index,
      }).config.platform
    : undefined;
  const tokenCommand = process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
  return createAgenticHost({
    project,
    executeAgent,
    secretResolver,
    platform: { models: platform?.models },
    tokensPerAssignment: options.tokensPerAssignment,
    concurrency: options.concurrency,
    minDispatchIntervalMs: options.minDispatchIntervalMs,
    allowBillableSources: options.allowBillableSources,
    runnerOptions: {
      tokenProvider: tokenCommand ? createTokenCommandProvider(tokenCommand) : undefined,
    },
  });
}
