import { parseAttemptOutcome } from './assignment.js';
import { agenticDeadlineAt, isAgenticFailureBlocked } from './execution-window.js';
import { jsonEqual } from './json-equal.js';
import { attemptReservation, deadlineTime } from './limits.js';
import { finishDigest } from './state.js';
import type { AgenticRunSnapshot } from './state.js';

// The rules for one work item. The snapshot schema runs them on every item; a proved command runs
// them on the one it changed. A rule added here reaches both.

/** Revisions spent on execution windows opened before the input was sealed. */
export function preparationRevisionOf(run: AgenticRunSnapshot): number {
  return run.execution_windows?.filter((window) => window.status === 'preparing').length ?? 0;
}

/** Check one work item against its run. `work.assignment` must be parsed. */
export function workMatchesRun(
  run: AgenticRunSnapshot,
  work: AgenticRunSnapshot['work'][number]
): boolean {
  const spendCap = run.accounting === 'spend_cap';
  if (
    work.assignment.run_id !== run.key.id ||
    work.assignment.model_name !== run.key.model ||
    work.assignment.limits.deadline_at !== run.deadline_at ||
    work.assignment.limits.started_at !== run.started_at ||
    work.attempts.length > run.max_attempts
  ) {
    return false;
  }
  for (const attempt of work.attempts) {
    if (
      (spendCap ? attempt.reservation !== null : attempt.charge_microusd !== undefined) ||
      (work.assignment.limits.tokens !== null &&
        attempt.reservation !== work.assignment.limits.tokens) ||
      (!attempt.outcome && attempt.charge < (attempt.reservation ?? 0))
    ) {
      return false;
    }
    if (attempt.outcome) {
      const minimum =
        attempt.outcome.usage.status === 'measured'
          ? attempt.outcome.usage.total_tokens
          : (attempt.reservation ?? 0);
      if (
        attempt.charge < minimum ||
        attempt.finish_revision === undefined ||
        attempt.finish_digest !==
          finishDigest(attempt.outcome, attempt.charge, attempt.charge_microusd)
      ) {
        return false;
      }
      try {
        // Refinements run only after every field parsed, so this assignment is parsed.
        parseAttemptOutcome(work.assignment, attempt.id, attempt.outcome);
      } catch {
        return false;
      }
    }
  }
  if (work.accepted) {
    const attempt = work.attempts.at(-1);
    if (
      !attempt ||
      work.accepted.status === 'failed' ||
      !jsonEqual(work.accepted, attempt.outcome)
    ) {
      return false;
    }
  }
  return true;
}

/** What one work item's attempts are checked against, and what they add to it. */
export interface AttemptChecks {
  preparationRevision: number;
  /** Tokens charged before each start revision it lists; other revisions are not checked. */
  chargesBefore: Map<number, number>;
  revisions: Set<number>;
  attemptIds: Set<string>;
  transitions: number;
}

/** Check one work item's attempts against its run and the attempts recorded so far. */
export function attemptsAreConsistent(
  run: AgenticRunSnapshot,
  work: AgenticRunSnapshot['work'][number],
  checks: AttemptChecks
): boolean {
  const spendCap = run.accounting === 'spend_cap';
  const assignment = work.assignment;
  const { preparationRevision, chargesBefore, revisions, attemptIds } = checks;
  const sealRevision =
    run.sealed_steps?.find((sealed) => sealed.id === assignment.step_id)?.revision ?? 0;
  let priorFinish = sealRevision;
  for (const [attemptIndex, attempt] of work.attempts.entries()) {
    const previous = work.attempts[attemptIndex - 1];
    const chargedBefore = chargesBefore.get(attempt.start_revision);
    // Spend-cap attempts hold no reservation; the snapshot schema requires null.
    if (
      !spendCap &&
      chargedBefore !== undefined &&
      attempt.reservation !==
        attemptReservation(assignment.limits.tokens, run.token_limit, chargedBefore)
    ) {
      return false;
    }
    if (isAgenticFailureBlocked(run, previous, attempt.start_revision)) return false;
    if (
      !spendCap &&
      previous &&
      previous.reservation !== null &&
      previous.charge > previous.reservation
    ) {
      return false;
    }
    if (
      attemptIds.has(attempt.id) ||
      attempt.start_revision <= preparationRevision ||
      attempt.start_revision <= priorFinish ||
      revisions.has(attempt.start_revision)
    ) {
      return false;
    }
    attemptIds.add(attempt.id);
    revisions.add(attempt.start_revision);
    checks.transitions++;
    if (attempt.outcome) {
      if (
        attempt.finish_revision === undefined ||
        attempt.finish_revision <= attempt.start_revision ||
        revisions.has(attempt.finish_revision) ||
        !attempt.finished_at
      ) {
        return false;
      }
      const finished = Date.parse(attempt.finished_at);
      if (finished < Date.parse(run.started_at) || finished > Date.now()) return false;
      revisions.add(attempt.finish_revision);
      checks.transitions++;
      priorFinish = attempt.finish_revision;
      const eligible =
        attempt.outcome.status !== 'failed' &&
        (spendCap ||
          ((attempt.reservation === null || attempt.charge <= attempt.reservation) &&
            finished < deadlineTime(agenticDeadlineAt(run, attempt.start_revision))));
      if (eligible && (!work.accepted || work.accepted.attempt_id !== attempt.id)) return false;
      if (!eligible && work.accepted?.attempt_id === attempt.id) return false;
    } else {
      if (
        attempt.finish_revision !== undefined ||
        attempt.finish_digest !== undefined ||
        attempt.finished_at !== undefined ||
        (!spendCap && attempt.charge !== (attempt.reservation ?? 0))
      ) {
        return false;
      }
      priorFinish = attempt.start_revision;
    }
  }
  return true;
}
