import {
  AgenticRunSnapshotSchema,
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
  transitionAgenticCheckpoint,
} from './state.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import { jsonEqual } from './json-equal.js';

interface Validated {
  snapshot: AgenticRunSnapshot;
  json: string;
}

/** A shape-valid snapshot is not proof that the requested reservation or acceptance happened. */
export function validateAgenticReceipt(
  value: unknown,
  before: AgenticRunSnapshot,
  command?: AgenticCheckpointCommand,
  requestedAt = Date.now()
): AgenticRunSnapshot {
  return checkReceipt(value, before, command, requestedAt);
}

/**
 * Receipt validation for one coordinator session. It retains only the last state it validated,
 * as JSON text. While the coordinator's state still serializes to that text, the next command
 * is applied to a private copy instead of validating both states again. Any difference falls
 * back to the complete check, which reports the original error.
 */
export function createAgenticReceiptValidator(): typeof validateAgenticReceipt {
  let last: Validated | undefined;
  return (value, before, command, requestedAt = Date.now()) => {
    const known =
      last?.snapshot === before && JSON.stringify(before) === last.json ? last : undefined;
    const snapshot = checkReceipt(value, before, command, requestedAt, known);
    last = { snapshot, json: JSON.stringify(snapshot) };
    return snapshot;
  };
}

function checkReceipt(
  value: unknown,
  before: AgenticRunSnapshot,
  command?: AgenticCheckpointCommand,
  requestedAt = Date.now(),
  validated?: Validated
): AgenticRunSnapshot {
  const parsed = AgenticRunSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new AgenticStateError('corrupt');
  const snapshot = parsed.data;
  let appliedAt = requestedAt;
  if (command?.type === 'finish_attempt') {
    const attempt = snapshot.work[command.work]?.attempts.find(
      (item) => item.id === command.attempt_id
    );
    appliedAt = Date.parse(attempt?.finished_at ?? '');
    if (!Number.isFinite(appliedAt) || appliedAt < requestedAt || appliedAt > Date.now()) {
      throw new AgenticStateError('corrupt');
    }
  }
  if (command && validated) {
    // The command has the same effect on a copy of the validated state. The response was
    // validated above, so an equal expected state is valid too.
    try {
      const expected = JSON.parse(validated.json) as AgenticRunSnapshot;
      transitionAgenticCheckpoint(expected, command, appliedAt);
      if (jsonEqual(expected, snapshot)) return snapshot;
    } catch {
      // The complete check below reproduces the error.
    }
  }
  const expected = command ? applyAgenticCheckpoint(before, command, appliedAt) : before;
  if (digestAgenticState(snapshot) !== digestAgenticState(expected)) {
    throw new AgenticStateError('corrupt');
  }
  return snapshot;
}
