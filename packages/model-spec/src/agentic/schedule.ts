import {
  agenticDeadlineAt,
  agenticSpendCapError,
  agenticSpendCapReached,
  agenticSpendCaps,
  formatMicroUsd,
  isAgenticFailureBlocked,
} from './execution-window.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '@bobsled-inc/connections';
import { AgenticStateError } from './state.js';
import { AgenticAssignmentError } from './errors.js';
import { invokeAgenticAssignment } from './invoke.js';
import { chargedUsage, estimateAssignmentTokens, priceMicrousd } from './spend.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import type { ExperimentalAgenticProbe } from './probe.js';

type Work = AgenticRunSnapshot['work'][number];

function assignmentFailed(
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

function legacyBudgetExhausted(snapshot: AgenticRunSnapshot): AgenticStateError {
  return new AgenticStateError('limit', {
    reason: 'token_budget_exhausted',
    message: `The run token budget (limits.tokens: ${snapshot.token_limit}) is used up or reserved; ${snapshot.charged} tokens are charged.`,
  });
}

/** Execute bounded work while keeping all checkpoint changes in one coordinator. */
export async function scheduleAgenticAssignments(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  options: {
    snapshot: AgenticRunSnapshot;
    checkpoint: (command: AgenticCheckpointCommand) => Promise<AgenticRunSnapshot>;
    signal: AbortSignal;
    abort: () => void;
    concurrency: number;
    minDispatchIntervalMs: number;
    dispatchClock?: { nextAt: number };
  }
): Promise<void> {
  let snapshot = options.snapshot;
  const runSignal = options.signal;
  const { concurrency, minDispatchIntervalMs } = options;
  const spendCap = snapshot.accounting === 'spend_cap';
  const checkpoint = async (command: AgenticCheckpointCommand) => {
    snapshot = await options.checkpoint(command);
    return snapshot;
  };
  const estimates = new Map<string, { tokens: number; microusd: number }>();
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
  // Out-of-order failure can leave earlier shards unfinished. Inspect every saved
  // shard before resume can spend tokens on any of them.
  for (const work of snapshot.work) {
    if (
      !spendCap &&
      work.attempts.some(
        (attempt) => attempt.reservation !== null && attempt.charge > attempt.reservation
      )
    ) {
      throw new AgenticStateError('limit', {
        reason: 'assignment_overcharged',
        message: `Assignment ${work.assignment.shard_id} of step "${work.assignment.step_id}" reported more token usage than it reserved.`,
        hint: 'This run uses the older reservation accounting and cannot continue. Start a new run ID.',
      });
    }
    if (work.accepted) continue;
    const last = work.attempts.at(-1);
    if (isAgenticFailureBlocked(snapshot, last)) throw assignmentFailed(snapshot, work);
    if (work.attempts.length >= snapshot.max_attempts) throw assignmentFailed(snapshot, work);
  }
  // Before the first call of a fresh run, refuse a batch whose input alone exceeds the cap.
  if (spendCap && snapshot.work.every((work) => work.attempts.length === 0)) {
    const caps = agenticSpendCaps(snapshot);
    const pending = snapshot.work.filter((work) => !work.accepted).map(estimate);
    const tokens = pending.reduce((sum, item) => sum + item.tokens, 0);
    const microusd = pending.reduce((sum, item) => sum + item.microusd, 0);
    const overTokens = caps.tokens !== null && snapshot.charged + tokens > caps.tokens;
    const overCost =
      caps.microusd !== null && (snapshot.charged_microusd ?? 0) + microusd > caps.microusd;
    if (overTokens || overCost) {
      const step = snapshot.work[0]?.assignment.step_id ?? 'unknown';
      throw new AgenticStateError('limit', {
        reason: 'estimate_exceeds_cap',
        message: overCost
          ? `The ${pending.length} assignments of step "${step}" need at least ${formatMicroUsd(microusd)} of input alone, more than the ${formatMicroUsd(caps.microusd!)} cap (limits.max_cost_usd). No model calls were made.`
          : `The ${pending.length} assignments of step "${step}" need at least ${tokens.toLocaleString('en-US')} input tokens, more than the ${caps.tokens!.toLocaleString('en-US')} token cap (limits.tokens). No model calls were made.`,
        hint: 'Raise the cap or process fewer input rows. The estimate counts input only, so the real cost is higher.',
      });
    }
  }
  // Only this coordinator writes checkpoints. Executors may finish in any order.
  // Legacy runs charge each started attempt its full reservation in the durable snapshot.
  type Completion = { index: number; attemptId: string } & (
    | { result: Awaited<ReturnType<typeof invoke>>; error?: never }
    | { error: unknown; result?: never }
  );
  type Finished = Completion & { result: NonNullable<Completion['result']> };
  const active = new Map<number, Promise<void>>();
  const ready: Completion[] = [];
  const dispatchClock = options.dispatchClock ?? { nextAt: 0 };
  // Accepted work stays accepted, so this search resumes where it stopped.
  let unfinished = 0;
  const firstUnfinished = () => {
    while (snapshot.work[unfinished]?.accepted) unfinished++;
    return unfinished;
  };
  async function invoke(index: number, attemptId: string) {
    const template = snapshot.work[index]!.assignment;
    return invokeAgenticAssignment(
      host,
      {
        ...template,
        limits: {
          ...template.limits,
          tokens: snapshot.work[index]!.attempts.at(-1)!.reservation,
          deadline_at: agenticDeadlineAt(snapshot),
        },
      },
      attemptId,
      runSignal
    );
  }

  /** Save a finished attempt. Separate from `accept` so paid answers survive a stop. */
  async function saveFinish(completed: Finished) {
    const { outcome } = completed.result;
    const work = snapshot.work[completed.index]!;
    // Unreported usage keeps the start estimate rather than charging nothing.
    const charge = spendCap
      ? Math.max(
          completed.result.charge,
          outcome.usage.status === 'measured' ? 0 : estimate(work).tokens
        )
      : completed.result.charge;
    const microusd = spendCap
      ? priceMicrousd(host.priceUsage, work.assignment.profile, chargedUsage(outcome.usage, charge))
      : 0;
    // Implausible usage reports would overflow the saved totals; stop with a clear reason.
    if (
      charge > Number.MAX_SAFE_INTEGER - snapshot.charged ||
      microusd > Number.MAX_SAFE_INTEGER - (snapshot.charged_microusd ?? 0)
    ) {
      throw new AgenticStateError('limit', {
        reason: 'usage_overflow',
        message: `The executor reported implausibly large usage for assignment ${work.assignment.shard_id} of step "${work.assignment.step_id}".`,
        hint: 'Check the executor usage report, then resume.',
      });
    }
    await checkpoint({
      type: 'finish_attempt',
      operation_id: `finish_attempt:${completed.attemptId}`,
      expected_revision: snapshot.revision,
      work: completed.index,
      attempt_id: completed.attemptId,
      outcome,
      charge,
      ...(spendCap ? { charge_microusd: microusd } : {}),
    });
    return charge;
  }

  async function accept(completed: Completion) {
    active.delete(completed.index);
    if (!completed.result) throw completed.error;
    const { outcome } = completed.result;
    const charge = await saveFinish(completed as Finished);
    throwIfCancelled(runSignal);
    const saved = snapshot.work[completed.index]!;
    if (!spendCap) {
      const allowance = saved.attempts.at(-1)!.reservation;
      if (allowance !== null && charge > allowance) {
        throw new AgenticStateError('limit', {
          reason: 'assignment_overcharged',
          message: `Assignment ${saved.assignment.shard_id} of step "${saved.assignment.step_id}" used ${charge} tokens but reserved ${allowance}.`,
        });
      }
      if (snapshot.token_limit !== null && snapshot.charged > snapshot.token_limit) {
        throw legacyBudgetExhausted(snapshot);
      }
    }
    const detail = completed.result.invalidOutput;
    if (outcome.status === 'failed' && !outcome.error.retryable) {
      throw assignmentFailed(snapshot, saved, detail);
    }
    if (outcome.status === 'failed' && saved.attempts.length >= snapshot.max_attempts) {
      throw assignmentFailed(snapshot, saved, detail);
    }
  }
  try {
    while (firstUnfinished() < snapshot.work.length || active.size) {
      // Fast executors and synchronous stores can otherwise keep this loop in microtasks,
      // so signals (Ctrl-C, SIGTERM) and timers would never be delivered.
      await yieldToEventLoop();
      throwIfCancelled(runSignal);
      const completed = ready.shift();
      if (completed) {
        await accept(completed);
        continue;
      }
      let index = firstUnfinished();
      while (snapshot.work[index]?.accepted || active.has(index)) index++;
      if (index < snapshot.work.length && active.size < concurrency) {
        const work = snapshot.work[index]!;
        const last = work.attempts.at(-1);
        if (isAgenticFailureBlocked(snapshot, last)) throw assignmentFailed(snapshot, work);
        if (work.attempts.length >= snapshot.max_attempts) throw assignmentFailed(snapshot, work);
        if (!spendCap && last && last.reservation !== null && last.charge > last.reservation) {
          throw new AgenticStateError('limit', {
            reason: 'assignment_overcharged',
            message: `Assignment ${work.assignment.shard_id} of step "${work.assignment.step_id}" reported more token usage than it reserved.`,
          });
        }
        // At the cap, stop starting work; running calls finish and their answers are kept.
        const capacity = spendCap
          ? !agenticSpendCapReached(snapshot)
          : snapshot.token_limit === null ||
            (snapshot.charged < snapshot.token_limit &&
              snapshot.charged + (work.assignment.limits.tokens ?? 0) <= snapshot.token_limit);
        if (capacity && Date.now() >= dispatchClock.nextAt) {
          const attemptId = randomUUID();
          const initial = spendCap ? estimate(work) : undefined;
          await checkpoint({
            type: 'start_attempt',
            operation_id: `start_attempt:${attemptId}`,
            expected_revision: snapshot.revision,
            work: index,
            attempt_id: attemptId,
            ...(initial ? { charge: initial.tokens, charge_microusd: initial.microusd } : {}),
          });
          // A call may have failed while the reservation was being saved.
          // Process those completions before starting another external call.
          while (ready.length) await accept(ready.shift()!);
          throwIfCancelled(runSignal);
          active.set(
            index,
            invoke(index, attemptId).then(
              (result) => {
                ready.push({ index, attemptId, result });
              },
              (error: unknown) => {
                ready.push({ index, attemptId, error });
              }
            )
          );
          // The executor has started by now, so the interval holds between calls themselves,
          // however long this one took to prepare and however quick the next checkpoint is.
          dispatchClock.nextAt = Date.now() + minDispatchIntervalMs;
          continue;
        }
        if (!capacity && active.size === 0) {
          throw spendCap ? agenticSpendCapError(snapshot) : legacyBudgetExhausted(snapshot);
        }
        if (capacity) {
          // A completion interrupts throttling so accepted results are saved promptly.
          const waiting = new AbortController();
          try {
            await Promise.race([
              ...active.values(),
              delay(Math.max(1, dispatchClock.nextAt - Date.now()), undefined, {
                signal: AbortSignal.any([runSignal, waiting.signal]),
              }),
            ]);
          } finally {
            waiting.abort();
          }
          continue;
        }
      }
      if (active.size) await Promise.race(active.values());
    }
  } catch (error) {
    // Save answers that already finished; spend-cap runs keep every answer they paid for.
    // Keep draining: another answer can arrive while a checkpoint write is awaited.
    const drainFinished = async () => {
      if (!spendCap) return;
      while (ready.length) {
        const completed = ready.shift()!;
        if (!completed.result) continue;
        await saveFinish(completed as Finished).catch(() => undefined);
      }
    };
    await drainFinished();
    // Stop active calls before releasing the store. Unfinished attempts keep their charge.
    options.abort();
    await Promise.all(active.values());
    // A successful invocation can settle while cancellation is unwinding.
    await drainFinished();
    throw error;
  }
}
