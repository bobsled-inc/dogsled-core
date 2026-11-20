import type { ChildProcess } from 'node:child_process';

import type { PipelineSummary } from './pipeline-summary.js';
import type { ProcessResult } from '../runtime/process.js';

export type PipelineExecutionStage = 'extract' | 'embed' | 'load' | 'state';

export interface PipelineExecutionControl {
  signal?: AbortSignal;
  onStage?: (stage: PipelineExecutionStage, status: 'started' | 'completed') => void;
  onSummary?: (stage: PipelineExecutionStage, summary: PipelineSummary) => void;
}

export interface StartedPipelineChild {
  name: string;
  child: ChildProcess;
  done: Promise<ProcessResult>;
  summary?: PipelineSummary;
  getLastError?: () => string | undefined;
  replayDone?: Promise<void>;
  stopReplay?: () => void;
}

/**
 * Forward terminal signals and caller cancellation to every child currently
 * registered in the shared array. Abort escalates after a grace period; the
 * caller still owns awaiting each child's close promise.
 */
export function setupPipelineSignalForwarding(
  children: ChildProcess[],
  signal?: AbortSignal
): () => void {
  let escalation: NodeJS.Timeout | undefined;
  const forward = (childSignal: NodeJS.Signals) => {
    for (const child of children) {
      const settled =
        typeof child.exitCode === 'number' ||
        (child.signalCode !== null && child.signalCode !== undefined);
      // `ChildProcess.killed` only means a signal was successfully sent. It
      // does not mean the process has exited, so SIGKILL must still reach a
      // child that ignored the initial SIGTERM.
      if (!settled && (childSignal === 'SIGKILL' || !child.killed)) {
        child.kill(childSignal);
      }
    }
  };
  const forwardWithEscalation = (childSignal: 'SIGINT' | 'SIGTERM') => {
    forward(childSignal);
    if (escalation) clearTimeout(escalation);
    escalation = setTimeout(() => forward('SIGKILL'), 2_000);
    escalation.unref();
  };
  const abort = () => forwardWithEscalation('SIGTERM');
  const forwardSigint = () => forwardWithEscalation('SIGINT');
  const forwardSigterm = () => forwardWithEscalation('SIGTERM');

  process.on('SIGINT', forwardSigint);
  process.on('SIGTERM', forwardSigterm);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) {
    abort();
  }

  return () => {
    if (escalation) {
      clearTimeout(escalation);
    }
    signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', forwardSigint);
    process.removeListener('SIGTERM', forwardSigterm);
  };
}

/**
 * Stop a child the pipeline no longer needs: SIGTERM now, and SIGKILL after a grace period if
 * it has not exited by then. A child that is already gone is left alone.
 */
export function stopPipelineChild(child: ChildProcess, graceMs = 5_000): void {
  const settled = (): boolean =>
    typeof child.exitCode === 'number' ||
    (child.signalCode !== null && child.signalCode !== undefined);
  if (settled()) return;
  if (!child.killed) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!settled()) child.kill('SIGKILL');
  }, graceMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/**
 * The loader has exited, so nothing reads the output of the stages before it. Drop that output, so
 * a write a stage is blocked on can finish and the stage can act on the signal, then stop each stage.
 * The pipe is removed first: a pipe to a stage that has gone would otherwise pause the output
 * again when its input closes, after this call.
 */
export function stopStagesAfterLoaderExit(stages: ChildProcess[]): void {
  for (const stage of stages) {
    stage.stdout?.unpipe();
    stage.stdout?.resume();
    stopPipelineChild(stage);
  }
}

export async function terminateAndSettlePipelineChildren(
  started: StartedPipelineChild[]
): Promise<void> {
  if (started.length === 0) return;
  const controller = new AbortController();
  const removeSignalHandlers = setupPipelineSignalForwarding(
    started.map((entry) => entry.child),
    controller.signal
  );
  for (const entry of started) entry.stopReplay?.();
  controller.abort();
  try {
    await Promise.allSettled(started.map((entry) => entry.done));
    await Promise.allSettled(
      started.flatMap((entry) => (entry.replayDone ? [entry.replayDone] : []))
    );
  } finally {
    removeSignalHandlers();
  }
}

export function throwIfPipelineAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Pipeline execution was aborted.', 'AbortError');
  }
}
