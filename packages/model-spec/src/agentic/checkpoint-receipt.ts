import { AgenticStateError, digestAgenticState, transitionAgenticCheckpoint } from './state.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import {
  advanceVerifiedCheckpoint,
  applyAgenticCheckpointWithin,
  checkpointLimitError,
  isVerifiedCheckpoint,
  safeParseVerifiedCheckpoint,
} from './checkpoint-verified.js';
import { isExactJson, jsonEqual } from './json-equal.js';
import { AGENTIC_DEFAULT_STORE_LIMITS, type AgenticStoreLimits } from './store-limits.js';

/** When the store says it finished the attempt, provided that is within this request. */
function finishTime(
  snapshot: AgenticRunSnapshot,
  command: Extract<AgenticCheckpointCommand, { type: 'finish_attempt' }>,
  requestedAt: number
): number | undefined {
  const attempt = snapshot.work[command.work]?.attempts.find(
    (item) => item.id === command.attempt_id
  );
  const finishedAt = Date.parse(attempt?.finished_at ?? '');
  return Number.isFinite(finishedAt) && finishedAt >= requestedAt && finishedAt <= Date.now()
    ? finishedAt
    : undefined;
}

/**
 * A response equal to the state the command must produce from verified state is proved by that
 * equality, so it needs no validation of its own. Returns undefined for anything else, including
 * any error reading a malformed response: the complete check decides those.
 */
function provedReceipt(
  value: unknown,
  before: AgenticRunSnapshot,
  command: AgenticCheckpointCommand,
  requestedAt: number,
  limits: AgenticStoreLimits
): AgenticRunSnapshot | undefined {
  if (!isVerifiedCheckpoint(before)) return undefined;
  try {
    const appliedAt =
      command.type === 'finish_attempt'
        ? finishTime(value as AgenticRunSnapshot, command, requestedAt)
        : requestedAt;
    if (appliedAt === undefined) return undefined;
    const expected = advanceVerifiedCheckpoint(before, command, appliedAt, limits);
    const shared = isVerifiedCheckpoint(value);
    if (!expected || !isExactJson(expected, value, shared)) return undefined;
    return shared ? value : expected;
  } catch {
    return undefined;
  }
}

/**
 * A shape-valid snapshot is not proof that the requested reservation or acceptance happened.
 * The result is verified state, frozen and separate from `value`, unless `value` is not plain JSON.
 * `limits` is what the store may hold: a larger response is refused like any other invalid one.
 */
export function validateAgenticReceipt(
  value: unknown,
  before: AgenticRunSnapshot,
  command?: AgenticCheckpointCommand,
  requestedAt = Date.now(),
  limits: AgenticStoreLimits = AGENTIC_DEFAULT_STORE_LIMITS
): AgenticRunSnapshot {
  const proved = command && provedReceipt(value, before, command, requestedAt, limits);
  if (proved) return proved;
  // A read that is exactly verified state is valid by that equality, however large the run.
  if (!command && isVerifiedCheckpoint(before) && isExactJson(before, value)) return before;
  const parsed = safeParseVerifiedCheckpoint(value);
  if (!parsed.success || checkpointLimitError(parsed.data, limits)) {
    throw new AgenticStateError('corrupt');
  }
  const snapshot = parsed.data;
  let appliedAt: number | undefined = requestedAt;
  if (command?.type === 'finish_attempt') {
    appliedAt = finishTime(snapshot, command, requestedAt);
    if (appliedAt === undefined) throw new AgenticStateError('corrupt');
  }
  if (command && isVerifiedCheckpoint(before)) {
    // The command has the same effect on a copy of verified state. The response was validated
    // above, so an equal expected state is valid too.
    try {
      const expected = JSON.parse(JSON.stringify(before)) as AgenticRunSnapshot;
      transitionAgenticCheckpoint(expected, command, appliedAt);
      if (jsonEqual(expected, snapshot)) return snapshot;
    } catch {
      // The complete check below reproduces the error.
    }
  }
  const expected = command
    ? applyAgenticCheckpointWithin(before, command, appliedAt, limits)
    : before;
  if (digestAgenticState(snapshot) !== digestAgenticState(expected)) {
    throw new AgenticStateError('corrupt');
  }
  return snapshot;
}
