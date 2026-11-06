import type { AgenticCheckpointCommand, AgenticRunSnapshot } from './state.js';
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

type Work = AgenticRunSnapshot['work'][number];
type WorkState = 'accepted' | 'running' | 'pending' | 'failed';

function workState(snapshot: AgenticRunSnapshot, work: Work): WorkState {
  const windowRevision = snapshot.execution_windows?.at(-1)?.revision ?? -1;
  const last = work.attempts.at(-1);
  return work.accepted
    ? 'accepted'
    : last && !last.outcome && last.start_revision > windowRevision
      ? 'running'
      : last?.outcome?.status === 'failed' &&
          (isAgenticFailureBlocked(snapshot, last) || work.attempts.length >= snapshot.max_attempts)
        ? 'failed'
        : 'pending';
}

/** An estimate for each assignment that has not started: what it still adds to the total. */
function unstartedTokens(work: Work, tokenEstimates?: Map<string, number>): number {
  if (work.accepted || work.attempts.length) return 0;
  const key = `${work.assignment.step_id}\0${work.assignment.shard_id}`;
  let estimate = tokenEstimates?.get(key);
  if (estimate === undefined) {
    estimate = estimateAssignmentTokens(work.assignment);
    tokenEstimates?.set(key, estimate);
  }
  return estimate;
}

function spendOf(snapshot: AgenticRunSnapshot): Pick<AgenticRunProgress, 'spend'> {
  if (snapshot.accounting !== 'spend_cap') return {};
  const caps = agenticSpendCaps(snapshot);
  return {
    spend: {
      tokens: snapshot.charged,
      usd: (snapshot.charged_microusd ?? 0) / 1_000_000,
      tokenCap: caps.tokens,
      usdCap: caps.microusd === null ? null : caps.microusd / 1_000_000,
    },
  };
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
  for (const work of snapshot.work) {
    const state = workState(snapshot, work);
    counts.total++;
    counts[state]++;
    remainingInputTokens += unstartedTokens(work, tokenEstimates);
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
    ...spendOf(snapshot),
  };
}

/**
 * Reports each checkpoint without rereading the run. A start or finish of an attempt moves at most
 * one assignment between counts, because nothing else that decides an assignment's state changes
 * within an execution window. Any other command counts again with createAgenticProgress.
 */
export function createAgenticProgressReporter(stepIds: readonly string[]) {
  // Assignments never change once saved, so each estimate is computed once per run.
  const tokenEstimates = new Map<string, number>();
  let last: { snapshot: AgenticRunSnapshot; progress: AgenticRunProgress } | undefined;
  return (
    snapshot: AgenticRunSnapshot,
    before?: AgenticRunSnapshot,
    command?: AgenticCheckpointCommand
  ): AgenticRunProgress => {
    const known = last?.snapshot === before ? last?.progress : undefined;
    const progress =
      known && (command?.type === 'start_attempt' || command?.type === 'finish_attempt')
        ? moveAssignment(known, before!, snapshot, command.work, tokenEstimates)
        : createAgenticProgress(snapshot, stepIds, tokenEstimates);
    last = { snapshot, progress };
    // The callback gets a separate value, so nothing it does reaches these counts.
    return structuredClone(progress);
  };
}

function moveAssignment(
  progress: AgenticRunProgress,
  before: AgenticRunSnapshot,
  snapshot: AgenticRunSnapshot,
  index: number,
  tokenEstimates: Map<string, number>
): AgenticRunProgress {
  const work = snapshot.work[index]!;
  const from = workState(before, before.work[index]!);
  const to = workState(snapshot, work);
  const counts = { ...progress, [from]: progress[from] - 1 };
  counts[to]++;
  return {
    ...counts,
    revision: snapshot.revision,
    steps: progress.steps.map((step) => {
      if (step.stepId !== work.assignment.step_id) return step;
      const moved = { ...step, [from]: step[from] - 1 };
      moved[to]++;
      return moved;
    }),
    remainingInputTokens:
      progress.remainingInputTokens -
      unstartedTokens(before.work[index]!, tokenEstimates) +
      unstartedTokens(work, tokenEstimates),
    ...spendOf(snapshot),
  };
}
