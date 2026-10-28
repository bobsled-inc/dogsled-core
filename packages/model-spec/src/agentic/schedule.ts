import { agenticDeadlineAt, isAgenticFailureBlocked } from './execution-window.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '@bobsled-inc/connections';
import { AgenticStateError } from './state.js';
import { invokeAgenticAssignment } from './invoke.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import type { ExperimentalAgenticProbe } from './probe.js';

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
  const checkpoint = async (command: AgenticCheckpointCommand) => {
    snapshot = await options.checkpoint(command);
    return snapshot;
  };
  // Out-of-order failure can leave earlier shards unfinished. Inspect every saved
  // shard before resume can spend tokens on any of them.
  for (const work of snapshot.work) {
    if (
      work.attempts.some(
        (attempt) => attempt.reservation !== null && attempt.charge > attempt.reservation
      )
    ) {
      throw new AgenticStateError('limit');
    }
    if (work.accepted) continue;
    const last = work.attempts.at(-1);
    if (isAgenticFailureBlocked(snapshot, last)) {
      throw new Error('Agentic assignment failed');
    }
    if (work.attempts.length >= snapshot.max_attempts) throw new AgenticStateError('limit');
  }
  // Only this coordinator writes checkpoints. Executors may finish in any order.
  // Each started attempt already charges its full reservation in the durable snapshot.
  type Completion = { index: number; attemptId: string } & (
    | { result: Awaited<ReturnType<typeof invoke>>; error?: never }
    | { error: unknown; result?: never }
  );
  const active = new Map<number, Promise<void>>();
  const ready: Completion[] = [];
  const dispatchClock = options.dispatchClock ?? { nextAt: 0 };
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

  async function accept(completed: Completion) {
    active.delete(completed.index);
    if (!completed.result) throw completed.error;
    const { outcome, charge } = completed.result;
    await checkpoint({
      type: 'finish_attempt',
      operation_id: `finish_attempt:${completed.attemptId}`,
      expected_revision: snapshot.revision,
      work: completed.index,
      attempt_id: completed.attemptId,
      outcome,
      charge,
    });
    throwIfCancelled(runSignal);
    const allowance = snapshot.work[completed.index]!.attempts.at(-1)!.reservation;
    if (
      (allowance !== null && charge > allowance) ||
      (snapshot.token_limit !== null && snapshot.charged > snapshot.token_limit)
    ) {
      throw new AgenticStateError('limit');
    }
    if (outcome.status === 'failed' && !outcome.error.retryable) {
      throw new Error('Agentic assignment failed');
    }
    if (
      outcome.status === 'failed' &&
      snapshot.work[completed.index]!.attempts.length >= snapshot.max_attempts
    ) {
      throw new AgenticStateError('limit');
    }
  }
  try {
    while (snapshot.work.some((work) => !work.accepted) || active.size) {
      throwIfCancelled(runSignal);
      const completed = ready.shift();
      if (completed) {
        await accept(completed);
        continue;
      }
      const index = snapshot.work.findIndex((work, index) => !work.accepted && !active.has(index));
      if (index !== -1 && active.size < concurrency) {
        const work = snapshot.work[index]!;
        const last = work.attempts.at(-1);
        if (isAgenticFailureBlocked(snapshot, last)) {
          throw new Error('Agentic assignment failed');
        }
        if (
          (last && last.reservation !== null && last.charge > last.reservation) ||
          work.attempts.length >= snapshot.max_attempts
        ) {
          throw new AgenticStateError('limit');
        }
        const capacity =
          snapshot.token_limit === null ||
          (snapshot.charged < snapshot.token_limit &&
            snapshot.charged + (work.assignment.limits.tokens ?? 0) <= snapshot.token_limit);
        if (capacity && Date.now() >= dispatchClock.nextAt) {
          const attemptId = randomUUID();
          await checkpoint({
            type: 'start_attempt',
            operation_id: `start_attempt:${attemptId}`,
            expected_revision: snapshot.revision,
            work: index,
            attempt_id: attemptId,
          });
          // A call may have failed while the reservation was being saved.
          // Process those completions before starting another external call.
          while (ready.length) await accept(ready.shift()!);
          throwIfCancelled(runSignal);
          dispatchClock.nextAt = Date.now() + minDispatchIntervalMs;
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
          continue;
        }
        if (!capacity && active.size === 0) throw new AgenticStateError('limit');
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
    // Stop active calls before releasing the store. Unfinished reservations remain charged.
    options.abort();
    await Promise.all(active.values());
    throw error;
  }
}
