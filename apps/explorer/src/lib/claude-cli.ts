import type { ClaudeStreamEvent } from '@/lib/claude-failure';
import { classifyClaudeFailure, runClaudeStreamJson } from '@/lib/claude-process';

export type { ClaudeFailureCode, ClaudeStreamEvent } from '@/lib/claude-failure';
export { isClaudeFailureCode } from '@/lib/claude-failure';
export { classifyClaudeFailure } from '@/lib/claude-process';

export interface StreamClaudeOptions {
  systemPrompt: string;
  /** Fully-built user prompt. Caller is responsible for history/truncation. */
  userPrompt: string;
  onEvent: (event: ClaudeStreamEvent) => void;
  /** Abort the child process (e.g. when the HTTP client disconnects). */
  signal?: AbortSignal;
  /** Max runtime for the spawned claude CLI. Defaults to 120_000 ms. */
  timeoutMs?: number;
}

/**
 * Spawn the `claude` CLI in stream-json mode and forward parsed deltas, done,
 * and error events to `onEvent`. Resolves when the child exits. Route handlers
 * are responsible for wrapping the events in their SSE envelope.
 */
export function streamClaudeResponse(options: StreamClaudeOptions): Promise<void> {
  const { systemPrompt, userPrompt, onEvent, signal, timeoutMs = 120_000 } = options;

  return runClaudeStreamJson({
    systemPrompt,
    userPrompt,
    signal,
    timeoutMs,
    maxTurns: 5,
    onText: (text) => onEvent({ type: 'delta', text }),
  }).then((result) => {
    if (result.error) {
      const failure = classifyClaudeFailure(String(result.error), { timedOut: result.timedOut });
      onEvent({ type: 'error', ...failure });
      onEvent({ type: 'done', code: 1 });
      return;
    }

    if (result.code == null) {
      const failure = classifyClaudeFailure(
        `Claude process terminated by signal ${result.signalName ?? 'unknown'}`,
        { timedOut: result.timedOut }
      );
      onEvent({ type: 'error', ...failure });
      onEvent({ type: 'done', code: 1 });
      return;
    }

    if (result.code !== 0) {
      const failure = classifyClaudeFailure(
        result.stderr || `Claude CLI exited with code ${result.code}`,
        { timedOut: result.timedOut }
      );
      onEvent({ type: 'error', ...failure });
    }

    onEvent({ type: 'done', code: result.code });
  });
}
