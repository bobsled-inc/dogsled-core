import type { AgenticRunSnapshot } from './state.js';
import { isAgenticFailureBlocked } from './execution-window.js';

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
}

export function createAgenticProgress(
  snapshot: AgenticRunSnapshot,
  stepIds: readonly string[]
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
  };
}
