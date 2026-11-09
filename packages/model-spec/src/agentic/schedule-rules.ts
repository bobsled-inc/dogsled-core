/**
 * The scheduler's rules for one command, judged on a given state: what a finish or a start saves,
 * whether a work item may start again, whether there is room under the caps, and why a saved finish
 * stops the run. Saving one command at a time and saving groups use the same rules.
 */
import { randomUUID } from 'node:crypto';
import { agenticSpendCapReached, isAgenticFailureBlocked } from './execution-window.js';
import { AgenticAssignmentError } from './errors.js';
import type { invokeAgenticAssignment } from './invoke.js';
import type { ExperimentalAgenticProbe } from './probe.js';
import { chargedUsage, estimateAssignmentTokens, priceMicrousd } from './spend.js';
import { AgenticStateError } from './state.js';
import type { AgenticCheckpointCommand, AgenticRunSnapshot } from './state.js';

export type Work = AgenticRunSnapshot['work'][number];
/** A call that returned, as the executor boundary reports it. */
export interface ReturnedCall {
  index: number;
  attemptId: string;
  result: Awaited<ReturnType<typeof invokeAgenticAssignment>>;
}

export function assignmentFailed(
  snapshot: AgenticRunSnapshot,
  work: Work,
  detail?: string
): AgenticAssignmentError {
  const outcome = work.attempts.at(-1)?.outcome;
  const error = outcome?.status === 'failed' ? outcome.error : undefined;
  return new AgenticAssignmentError({
    step_id: work.assignment.step_id,
    shard_id: work.assignment.shard_id,
    attempts: work.attempts.length,
    max_attempts: snapshot.max_attempts,
    ...(error ? { kind: error.kind, code: error.code, retryable: error.retryable } : {}),
    ...(detail ? { detail } : {}),
  });
}

export function legacyBudgetExhausted(snapshot: AgenticRunSnapshot): AgenticStateError {
  return new AgenticStateError('limit', {
    reason: 'token_budget_exhausted',
    message: `The run token budget (limits.tokens: ${snapshot.token_limit}) is used up or reserved; ${snapshot.charged} tokens are charged.`,
  });
}

export function createScheduleRules(
  host: Pick<ExperimentalAgenticProbe, 'priceUsage'>,
  spendCap: boolean
) {
  const estimates = new Map<string, { tokens: number; microusd: number }>();
  /** The input estimate a start charges, computed once per assignment. */
  const estimate = (work: Work) => {
    let value = estimates.get(work.assignment.shard_id);
    if (!value) {
      const tokens = estimateAssignmentTokens(work.assignment);
      value = {
        tokens,
        microusd: priceMicrousd(host.priceUsage, work.assignment.profile, {
          input_tokens: tokens,
          output_tokens: 0,
        }),
      };
      estimates.set(work.assignment.shard_id, value);
    }
    return value;
  };

  /** The finish of a returned call, made against `state`, and the charge it saves. */
  function finishCommand(state: AgenticRunSnapshot, returned: ReturnedCall) {
    const { outcome } = returned.result;
    const work = state.work[returned.index]!;
    // Unreported usage keeps the start estimate rather than charging nothing.
    const charge = spendCap
      ? Math.max(
          returned.result.charge,
          outcome.usage.status === 'measured' ? 0 : estimate(work).tokens
        )
      : returned.result.charge;
    const microusd = spendCap
      ? priceMicrousd(host.priceUsage, work.assignment.profile, chargedUsage(outcome.usage, charge))
      : 0;
    // Implausible usage reports would overflow the saved totals; stop with a clear reason.
    if (
      charge > Number.MAX_SAFE_INTEGER - state.charged ||
      microusd > Number.MAX_SAFE_INTEGER - (state.charged_microusd ?? 0)
    ) {
      throw new AgenticStateError('limit', {
        reason: 'usage_overflow',
        message: `The executor reported implausibly large usage for assignment ${work.assignment.shard_id} of step "${work.assignment.step_id}".`,
        hint: 'Check the executor usage report, then resume.',
      });
    }
    const command: AgenticCheckpointCommand = {
      type: 'finish_attempt',
      operation_id: `finish_attempt:${returned.attemptId}`,
      expected_revision: state.revision,
      work: returned.index,
      attempt_id: returned.attemptId,
      outcome,
      charge,
      ...(spendCap ? { charge_microusd: microusd } : {}),
    };
    return { command, charge };
  }

  /** Why the run stops once this finish is saved, judged on the state that holds it. */
  function stopAfterFinish(state: AgenticRunSnapshot, returned: ReturnedCall, charge: number) {
    const saved = state.work[returned.index]!;
    if (!spendCap) {
      const allowance = saved.attempts.at(-1)!.reservation;
      if (allowance !== null && charge > allowance) {
        return new AgenticStateError('limit', {
          reason: 'assignment_overcharged',
          message: `Assignment ${saved.assignment.shard_id} of step "${saved.assignment.step_id}" used ${charge} tokens but reserved ${allowance}.`,
        });
      }
      if (state.token_limit !== null && state.charged > state.token_limit) {
        return legacyBudgetExhausted(state);
      }
    }
    const { outcome } = returned.result;
    const detail = returned.result.invalidOutput;
    if (outcome.status === 'failed' && !outcome.error.retryable) {
      return assignmentFailed(state, saved, detail);
    }
    if (outcome.status === 'failed' && saved.attempts.length >= state.max_attempts) {
      return assignmentFailed(state, saved, detail);
    }
    return undefined;
  }

  /** Why this work cannot start another attempt, if it cannot. */
  function blockedBeforeStart(state: AgenticRunSnapshot, work: Work) {
    const last = work.attempts.at(-1);
    if (isAgenticFailureBlocked(state, last)) return assignmentFailed(state, work);
    if (work.attempts.length >= state.max_attempts) return assignmentFailed(state, work);
    if (!spendCap && last && last.reservation !== null && last.charge > last.reservation) {
      return new AgenticStateError('limit', {
        reason: 'assignment_overcharged',
        message: `Assignment ${work.assignment.shard_id} of step "${work.assignment.step_id}" reported more token usage than it reserved.`,
      });
    }
    return undefined;
  }

  /** At the cap, stop starting work; running calls finish and their answers are kept. */
  function hasCapacity(state: AgenticRunSnapshot, work: Work): boolean {
    return spendCap
      ? !agenticSpendCapReached(state)
      : state.token_limit === null ||
          (state.charged < state.token_limit &&
            state.charged + (work.assignment.limits.tokens ?? 0) <= state.token_limit);
  }

  function startCommand(state: AgenticRunSnapshot, index: number) {
    const attemptId = randomUUID();
    const initial = spendCap ? estimate(state.work[index]!) : undefined;
    return {
      type: 'start_attempt' as const,
      operation_id: `start_attempt:${attemptId}`,
      expected_revision: state.revision,
      work: index,
      attempt_id: attemptId,
      ...(initial ? { charge: initial.tokens, charge_microusd: initial.microusd } : {}),
    };
  }

  return {
    estimate,
    finishCommand,
    stopAfterFinish,
    blockedBeforeStart,
    hasCapacity,
    startCommand,
  };
}
