import * as fs from 'node:fs';

import { spawnCommand, waitForProcess } from '../runtime/process.js';
import { resolveCliInvocation } from '../runtime/workspace.js';
import { setupPipelineSignalForwarding, throwIfPipelineAborted } from './pipeline-control.js';
import { stagedStatePath } from './pipeline-extract-args.js';
import { getRuntimeCwd } from './pipeline-run-helpers.js';
import {
  buildLogMessage,
  createChunkProcessor,
  createPipelineSummary,
  formatPipelineLogLine,
  writeLogLine,
} from './pipeline-summary.js';

import type { PipelineDependencies, PipelineOptions } from './pipeline.js';

export async function buildExtractEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  try {
    const { getIntegrationsDir } = await import('@bobsled-inc/integrations');
    return {
      ...baseEnv,
      DOGSLED_BUNDLED_INTEGRATIONS_DIR: getIntegrationsDir(),
    };
  } catch {
    return baseEnv;
  }
}

/** Let the extractor save state it did not save while it ran. `source` says where that is. */
export async function commitState(
  source: string[],
  options: PipelineOptions,
  dependencies: PipelineDependencies,
  logStream: fs.WriteStream | undefined,
  redact: (value: string) => string,
  childEnv: NodeJS.ProcessEnv
): Promise<number> {
  const metaUrl = dependencies.metaUrl ?? import.meta.url;
  const invocation = resolveCliInvocation('extract', metaUrl, [
    'commit-state',
    '--integration',
    options.integration,
    ...source,
    '--log-format',
    'json',
    ...(options.verbose ? ['--verbose'] : []),
    ...(options.quiet ? ['--quiet'] : []),
    ...(options.stateBackend ? ['--state-backend', options.stateBackend] : []),
  ]);
  const child = spawnCommand(
    invocation,
    {
      cwd: getRuntimeCwd(dependencies),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: await buildExtractEnv(childEnv),
    },
    dependencies
  );
  const removeSignalHandlers = setupPipelineSignalForwarding([child], dependencies.signal);

  try {
    if (child.stderr) {
      const processChunk = createChunkProcessor(
        createPipelineSummary(),
        '',
        (line) => {
          writeLogLine(formatPipelineLogLine(line, options.logFormat), logStream);
        },
        redact
      );
      const flushChunk = () => processChunk.flush();
      child.stderr.on('data', processChunk.handle);
      child.stderr.on('end', flushChunk);
      child.stderr.on('close', flushChunk);
    }

    const result = await waitForProcess(child, 'extract commit-state CLI');
    return result.exitCode;
  } finally {
    removeSignalHandlers();
  }
}

/**
 * Save the state that a file source kept back for a run with an embed stage. Call it only when
 * every stage has ended well: a bookmark saved earlier would pass files whose rows or vectors
 * never reached the destination.
 */
export async function commitStagedState(
  embedTmpDir: string | undefined,
  options: PipelineOptions,
  dependencies: PipelineDependencies,
  logStream: fs.WriteStream | undefined,
  redact: (value: string) => string,
  childEnv: NodeJS.ProcessEnv
): Promise<number> {
  const stagedPath = embedTmpDir && stagedStatePath(embedTmpDir);
  if (!stagedPath || !fs.existsSync(stagedPath)) return 0;

  throwIfPipelineAborted(dependencies.signal);
  dependencies.onStage?.('state', 'started');
  const exitCode = await commitState(
    ['--staged-state', stagedPath],
    options,
    dependencies,
    logStream,
    redact,
    childEnv
  );
  dependencies.onStage?.('state', 'completed');
  if (exitCode !== 0) {
    const message =
      'Failed to save extractor state after the load. The next run reads the files again.';
    writeLogLine(JSON.stringify(buildLogMessage('error', message)), logStream);
  }
  return exitCode;
}
