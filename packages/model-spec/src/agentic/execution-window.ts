import { AgenticStateError } from './state-errors.js';
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

export interface AgenticSpendCaps {
  tokens: number | null;
  microusd: number | null;
}

/** The latest execution window's caps apply, so a resume can raise them. */
export function agenticSpendCaps(run: AgenticRunSnapshot): AgenticSpendCaps {
  const window = run.execution_windows?.filter((item) => item.token_limit !== undefined).at(-1);
  return window
    ? { tokens: window.token_limit ?? null, microusd: window.cost_limit_microusd ?? null }
    : { tokens: run.token_limit, microusd: run.cost_limit_microusd ?? null };
}

export function agenticSpendCapReached(run: AgenticRunSnapshot): boolean {
  const caps = agenticSpendCaps(run);
  return (
    (caps.tokens !== null && run.charged >= caps.tokens) ||
    (caps.microusd !== null && (run.charged_microusd ?? 0) >= caps.microusd)
  );
}

export function formatMicroUsd(value: number): string {
  return `$${(value / 1_000_000).toFixed(value < 1_000_000 ? 4 : 2)}`;
}

/** Safe summary of spend and progress; names the cap that stopped the run. */
export function agenticSpendCapError(run: AgenticRunSnapshot): AgenticStateError {
  const caps = agenticSpendCaps(run);
  const spent = run.charged_microusd ?? 0;
  const byCost = caps.microusd !== null && spent >= caps.microusd;
  const usage = byCost
    ? `spent ${formatMicroUsd(spent)} of the ${formatMicroUsd(caps.microusd!)} cap (limits.max_cost_usd)`
    : `used ${run.charged.toLocaleString('en-US')} of ${caps.tokens!.toLocaleString('en-US')} tokens (limits.tokens)`;
  const accepted = run.work.filter((work) => work.accepted).length;
  return new AgenticStateError('limit', {
    reason: 'spend_cap_reached',
    message: `Run "${run.key.id}" reached its spend cap: it ${usage}. ${accepted} of ${run.work.length} assignments in the current steps are done, and that work is saved.`,
    hint: `To continue, raise the cap (${byCost ? 'limits.max_cost_usd or --agent-max-cost' : 'limits.tokens'}) and resume with --agent-resume --agent-run-id ${run.key.id}.`,
  });
}
