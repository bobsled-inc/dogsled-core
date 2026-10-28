import type { AgenticRunSnapshot } from './state.js';

/** Assignment templates retain their original timestamps. Live calls use this window. */
export function agenticDeadlineAt(run: AgenticRunSnapshot, revision = Infinity): string | null {
  return (
    run.execution_windows?.filter((window) => window.revision < revision).at(-1)?.deadline_at ??
    run.deadline_at
  );
}

export function executionWindowsAfter(run: AgenticRunSnapshot, revision: number): number {
  return run.execution_windows?.filter((window) => window.revision > revision).length ?? 0;
}

/** A manual restart permits one new attempt after a saved terminal failure. */
export function isAgenticFailureBlocked(
  run: AgenticRunSnapshot,
  attempt: AgenticRunSnapshot['work'][number]['attempts'][number] | undefined,
  revision = run.revision
): boolean {
  if (attempt?.outcome?.status !== 'failed' || attempt.outcome.error.retryable) return false;
  return !run.execution_windows?.some(
    (window) =>
      window.retry_failed === true &&
      window.revision > (attempt.finish_revision ?? Infinity) &&
      window.revision < revision
  );
}
