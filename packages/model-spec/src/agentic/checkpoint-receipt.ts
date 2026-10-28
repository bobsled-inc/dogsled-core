import {
  AgenticRunSnapshotSchema,
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
} from './state.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';

/** A shape-valid snapshot is not proof that the requested reservation or acceptance happened. */
export function validateAgenticReceipt(
  value: unknown,
  before: AgenticRunSnapshot,
  command?: AgenticCheckpointCommand,
  requestedAt = Date.now()
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
  const expected = command ? applyAgenticCheckpoint(before, command, appliedAt) : before;
  if (digestAgenticState(snapshot) !== digestAgenticState(expected)) {
    throw new AgenticStateError('corrupt');
  }
  return snapshot;
}
