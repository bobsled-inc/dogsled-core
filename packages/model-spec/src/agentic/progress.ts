import type { AgenticRunSnapshot } from './state.js';
import { agenticSpendCaps, isAgenticFailureBlocked } from './execution-window.js';
import { estimateAssignmentTokens } from './spend.js';

export interface AgenticAssignmentCounts {
  total: number;
  accepted: number;
  running: number;
  pending: number;
  failed: number;
}

/** Counts describe saved assignments, not output rows or pipeline tasks. */
export interface AgenticRunProgress extends AgenticAssignmentCounts {
  runId: string;
  modelName: string;
  revision: number;
  status: AgenticRunSnapshot['status'];
  publication: AgenticRunSnapshot['publication'];
  /** False until preparation has fixed the work for every step. */
  totalIsFinal: boolean;
  steps: (AgenticAssignmentCounts & { stepId: string; sealed: boolean })[];
  /** Spend so far and the caps in force. Absent for runs saved with reservation accounting. */
  spend?: { tokens: number; usd: number; tokenCap: number | null; usdCap: number | null };
  /** Rough input tokens of assignments not yet started: a lower bound on what remains. */
  remainingInputTokens: number;
}

export function createAgenticProgress(
  snapshot: AgenticRunSnapshot,
  stepIds: readonly string[],
  /** Optional per-run cache of input token estimates, keyed by step and shard. */
  tokenEstimates?: Map<string, number>
): AgenticRunProgress {
  const empty = (): AgenticAssignmentCounts => ({
    total: 0,
    accepted: 0,
    running: 0,
    pending: 0,
    failed: 0,
  });
  const steps = stepIds.map((stepId) => ({
    ...empty(),
    stepId,
    sealed: snapshot.plan_inputs
      ? !!snapshot.sealed_steps?.some((step) => step.id === stepId)
      : snapshot.status !== 'preparing',
  }));
  const counts = empty();
  let remainingInputTokens = 0;
  const windowRevision = snapshot.execution_windows?.at(-1)?.revision ?? -1;
  for (const work of snapshot.work) {
    const last = work.attempts.at(-1);
    const state = work.accepted
      ? 'accepted'
      : last && !last.outcome && last.start_revision > windowRevision
        ? 'running'
        : last?.outcome?.status === 'failed' &&
            (isAgenticFailureBlocked(snapshot, last) ||
              work.attempts.length >= snapshot.max_attempts)
          ? 'failed'
          : 'pending';
    counts.total++;
    counts[state]++;
    if (!work.accepted && work.attempts.length === 0) {
      const key = `${work.assignment.step_id}\0${work.assignment.shard_id}`;
      let estimate = tokenEstimates?.get(key);
      if (estimate === undefined) {
        estimate = estimateAssignmentTokens(work.assignment);
        tokenEstimates?.set(key, estimate);
      }
      remainingInputTokens += estimate;
    }
    const step = steps.find((step) => step.stepId === work.assignment.step_id)!;
    step.total++;
    step[state]++;
  }
  return {
    ...counts,
    runId: snapshot.key.id,
    modelName: snapshot.key.model,
    revision: snapshot.revision,
    status: snapshot.status,
    publication: snapshot.publication,
    totalIsFinal: steps.every((step) => step.sealed),
    steps,
    remainingInputTokens,
    ...(snapshot.accounting === 'spend_cap'
      ? {
          spend: (() => {
            const caps = agenticSpendCaps(snapshot);
            return {
              tokens: snapshot.charged,
              usd: (snapshot.charged_microusd ?? 0) / 1_000_000,
              tokenCap: caps.tokens,
              usdCap: caps.microusd === null ? null : caps.microusd / 1_000_000,
            };
          })(),
        }
      : {}),
  };
}
