import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants as osConstants } from 'node:os';

import { CommandError } from '@bobsled-inc/protocol';

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface CommandInvocation {
  args: string[];
  command: string;
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface RunCommandDependencies {
  spawn?: SpawnFunction;
}

export interface ProcessResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export function spawnCommand(
  invocation: CommandInvocation,
  options: SpawnOptions,
  dependencies: RunCommandDependencies = {}
): ChildProcess {
  const run = dependencies.spawn ?? spawn;
  return run(invocation.command, invocation.args, options);
}

function normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') {
    return code;
  }

  if (signal) {
    const signalCode = osConstants.signals[signal];
    if (typeof signalCode === 'number') {
      return 128 + signalCode;
    }
  }

  return 1;
}

export async function waitForProcess(child: ChildProcess, label: string): Promise<ProcessResult> {
  const ac = new AbortController();
  try {
    const closePromise = once(child, 'close', { signal: ac.signal }).then(([code, signal]) => {
      const normalizedSignal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null;
      return {
        exitCode: normalizeExitCode(typeof code === 'number' ? code : null, normalizedSignal),
        signal: normalizedSignal,
      } satisfies ProcessResult;
    });
    const errorPromise = once(child, 'error', { signal: ac.signal }).then(([error]) => {
      throw new CommandError(
        `Failed to start ${label}: ${error instanceof Error ? error.message : String(error)}`,
        1
      );
    });

    return await Promise.race([closePromise, errorPromise]);
  } finally {
    ac.abort();
  }
}
