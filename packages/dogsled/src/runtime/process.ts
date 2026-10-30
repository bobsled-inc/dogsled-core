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

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Pass stop signals to a delegated child so it can cancel cleanly and save its work.
 * Without this, a signal sent only to the parent (kill, CI cancel, container stop)
 * kills the parent and leaves the child running. Returns a function that stops forwarding.
 */
export function forwardSignals(child: ChildProcess): () => void {
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}
