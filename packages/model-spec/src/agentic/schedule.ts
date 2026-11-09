import {
  agenticDeadlineAt,
  agenticSpendCapError,
  agenticSpendCaps,
  formatMicroUsd,
  isAgenticFailureBlocked,
} from './execution-window.js';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '@bobsled-inc/connections';
import { AgenticStateError, applyAgenticCheckpoint } from './state.js';
import { invokeAgenticAssignment } from './invoke.js';
import {
  assignmentFailed,
  createScheduleRules,
  legacyBudgetExhausted,
  type ReturnedCall,
} from './schedule-rules.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import type { ExperimentalAgenticProbe } from './probe.js';

/** Execute bounded work while keeping all checkpoint changes in one coordinator. */
export async function scheduleAgenticAssignments(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  options: {
    snapshot: AgenticRunSnapshot;
    checkpoint: (command: AgenticCheckpointCommand) => Promise<AgenticRunSnapshot>;
    /** Saves several commands as one checkpoint, or returns null when the store saved none of
     * them. Present only for a store that offers it. */
    checkpointGroup?: (commands: AgenticCheckpointCommand[]) => Promise<AgenticRunSnapshot | null>;
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
  const {
    estimate,
    finishCommand,
    stopAfterFinish,
    blockedBeforeStart,
    hasCapacity,
    startCommand,
  } = createScheduleRules(host, spendCap);
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
  type Finished = Completion & ReturnedCall;
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
  function dispatch(index: number, attemptId: string) {
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
  }

  /** Save a finished attempt. Separate from `accept` so paid answers survive a stop. */
  async function saveFinish(completed: Finished) {
    const { command, charge } = finishCommand(snapshot, completed);
    await checkpoint(command);
    return charge;
  }

  async function accept(completed: Completion) {
    active.delete(completed.index);
    if (!completed.result) throw completed.error;
    const charge = await saveFinish(completed as Finished);
    throwIfCancelled(runSignal);
    const stop = stopAfterFinish(snapshot, completed as Finished, charge);
    if (stop) throw stop;
  }

  /** Waits for a call to return or for the dispatch interval to pass, whichever comes first. */
  async function waitForInterval() {
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
  }

  async function oneAtATime() {
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
        const blocked = blockedBeforeStart(snapshot, work);
        if (blocked) throw blocked;
        const capacity = hasCapacity(snapshot, work);
        if (capacity && Date.now() >= dispatchClock.nextAt) {
          const command = startCommand(snapshot, index);
          await checkpoint(command);
          // A call may have failed while the reservation was being saved.
          // Process those completions before starting another external call.
          while (ready.length) await accept(ready.shift()!);
          throwIfCancelled(runSignal);
          dispatch(index, command.attempt_id);
          // The executor has started by now, so the interval holds between calls themselves,
          // however long this one took to prepare and however quick the next checkpoint is.
          dispatchClock.nextAt = Date.now() + minDispatchIntervalMs;
          continue;
        }
        if (!capacity && active.size === 0) {
          throw spendCap ? agenticSpendCapError(snapshot) : legacyBudgetExhausted(snapshot);
        }
        if (capacity) {
          await waitForInterval();
          continue;
        }
      }
      if (active.size) await Promise.race(active.values());
    }
  }

  /** Whether saving the calls that have returned would stop the run. */
  function returnedCallsStop(): boolean {
    let state = snapshot;
    for (const completed of ready) {
      if (!completed.result) return true;
      try {
        const { command, charge } = finishCommand(state, completed as Finished);
        state = applyAgenticCheckpoint(state, command, Date.now());
        if (stopAfterFinish(state, completed as Finished, charge)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  const finishSaved = (completed: Completion): boolean =>
    snapshot.work[completed.index]?.attempts.some(
      (attempt) => attempt.id === completed.attemptId && attempt.finish_digest !== undefined
    ) ?? false;

  /**
   * Group commit. Each pass saves, as one checkpoint, the finishes of every call that has returned
   * and the starts of as many calls as there are free slots, then makes those calls. What becomes
   * due while that checkpoint is saved waits for the next one. A call is still made only once its
   * start is saved. The group is worked out on the state its commands produce, by the same rules
   * as one command at a time, and anything the transition refuses there goes on its own, after the
   * group, so that it is decided and reported as it always has been.
   */
  async function inGroups(
    checkpointGroup: (commands: AgenticCheckpointCommand[]) => Promise<AgenticRunSnapshot | null>
  ) {
    while (firstUnfinished() < snapshot.work.length || active.size) {
      await yieldToEventLoop();
      throwIfCancelled(runSignal);
      let state = snapshot;
      const commands: AgenticCheckpointCommand[] = [];
      const finished: Finished[] = [];
      const starts: { index: number; attemptId: string }[] = [];
      let stop: { error: unknown } | undefined;
      let alone: Finished | ReturnType<typeof startCommand> | undefined;
      // Finishes first, oldest first, so that starts see what they charged.
      while (ready.length && !stop && !alone) {
        const completed = ready.shift()!;
        active.delete(completed.index);
        if (!completed.result) {
          stop = { error: completed.error };
          break;
        }
        let finish: ReturnType<typeof finishCommand>;
        try {
          finish = finishCommand(state, completed as Finished);
        } catch (error) {
          stop = { error };
          break;
        }
        try {
          state = applyAgenticCheckpoint(state, finish.command, Date.now());
        } catch {
          alone = completed as Finished;
          break;
        }
        commands.push(finish.command);
        finished.push(completed as Finished);
        const failure = stopAfterFinish(state, completed as Finished, finish.charge);
        if (failure) stop = { error: failure };
      }
      let noCapacity = false;
      let throttled = false;
      if (!stop && !alone) {
        for (let index = firstUnfinished(); active.size + starts.length < concurrency; index++) {
          while (state.work[index]?.accepted || active.has(index)) index++;
          if (index >= state.work.length) break;
          const work = state.work[index]!;
          const blocked = blockedBeforeStart(state, work);
          if (blocked) {
            stop = { error: blocked };
            break;
          }
          if (!hasCapacity(state, work)) {
            noCapacity = true;
            break;
          }
          // An interval between calls allows one start per checkpoint, as one at a time does.
          if (minDispatchIntervalMs && (starts.length || Date.now() < dispatchClock.nextAt)) {
            throttled = true;
            break;
          }
          const command = startCommand(state, index);
          try {
            state = applyAgenticCheckpoint(state, command, Date.now());
          } catch {
            alone = command;
            break;
          }
          commands.push(command);
          starts.push({ index, attemptId: command.attempt_id });
        }
      }
      if (commands.length) {
        try {
          const saved = commands.length > 1 ? await checkpointGroup(commands) : null;
          if (saved) {
            snapshot = saved;
          } else {
            // One command, or a group the store saved none of: one at a time decides and
            // reports each command as it always has.
            for (const command of commands) await checkpoint(command);
          }
        } catch (error) {
          // Answers this did not save go back, so that the drain below can still save them.
          const returned = alone && 'result' in alone ? [...finished, alone] : finished;
          ready.unshift(...returned.filter((completed) => !finishSaved(completed)));
          throw error;
        }
      }
      if (alone && 'result' in alone) {
        await accept(alone);
        continue;
      }
      if (stop) throw stop.error;
      if (alone) {
        await checkpoint(alone);
        starts.push({ index: alone.work, attemptId: alone.attempt_id });
      }
      if (starts.length) {
        throwIfCancelled(runSignal);
        // A call may have failed while the group was being saved. If saving it stops the run,
        // make no more calls: the next pass saves it and stops.
        if (!returnedCallsStop()) {
          for (const start of starts) dispatch(start.index, start.attemptId);
          dispatchClock.nextAt = Date.now() + minDispatchIntervalMs;
        }
        continue;
      }
      if (commands.length) continue;
      if (noCapacity && active.size === 0) {
        throw spendCap ? agenticSpendCapError(snapshot) : legacyBudgetExhausted(snapshot);
      }
      if (throttled) {
        await waitForInterval();
        continue;
      }
      if (active.size) await Promise.race(active.values());
    }
  }

  try {
    if (options.checkpointGroup) await inGroups(options.checkpointGroup);
    else await oneAtATime();
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
