import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';
import {
  AgenticCursorConflict,
  type AgenticCursorKey,
  type AgenticCursorStore,
  type AgenticCursorValues,
} from './cursor.js';
import {
  AgenticRunSnapshotSchema,
  AgenticStateError,
  digestAgenticState,
  type AgenticStateStore,
  type AgenticCheckpointCommand,
} from './state.js';
import { validateAgenticReceipt } from './checkpoint-receipt.js';

/** Retire the old checkpoint before changing the shared cursor owner. A crash between
 * these writes leaves a retired owner that a later start can safely replace. */
export async function beginAgenticCursor(
  cursors: AgenticCursorStore,
  states: AgenticStateStore,
  key: AgenticCursorKey,
  signature: string,
  runId: string,
  allowTakeover: boolean,
  signal?: AbortSignal
): Promise<AgenticCursorValues> {
  let previousRunId: string;
  try {
    return await cursors.begin(key, signature, runId);
  } catch (error) {
    if (!(error instanceof AgenticCursorConflict) || !allowTakeover) throw error;
    previousRunId = error.activeRun;
  }
  if (!cursors.supersede) throw new AgenticStateError('takeover_unsupported');
  throwIfCancelled(signal);
  const previousKey = { scope: key.scope, model: key.model, id: previousRunId };
  // Acquisition must exclude a live coordinator, including its publication work.
  const session = await states.acquire(previousKey).catch((error: unknown) => {
    if (isCancellationError(error, signal)) throw error;
    throw new AgenticStateError('takeover_blocked');
  });
  try {
    throwIfCancelled(signal);
    const raw = await session.read();
    if (!raw) throw new AgenticStateError('missing');
    const previous = AgenticRunSnapshotSchema.parse(raw);
    if (
      digestAgenticState(previous.key) !== digestAgenticState(previousKey) ||
      (previous.definition as { target?: unknown }).target !== key.target
    ) {
      throw new AgenticStateError('conflict');
    }
    // A commit may have reached the warehouse even if its reply was lost. Never
    // replace that run: its receipt and cursor must first be reconciled by resume.
    if (previous.publication !== 'pending') throw new AgenticStateError('publication_pending');
    if (!previous.superseded) {
      const command: AgenticCheckpointCommand = {
        type: 'supersede',
        operation_id: 'supersede',
        expected_revision: previous.revision,
      };
      const requestedAt = Date.now();
      try {
        validateAgenticReceipt(await session.checkpoint(command), previous, command, requestedAt);
      } catch {
        // A lost reply is not a reason to undo or skip retirement.
        validateAgenticReceipt(await session.read(), previous, command, requestedAt);
      }
    }
    throwIfCancelled(signal);
    return await cursors.supersede(key, signature, previousRunId, runId);
  } finally {
    await session.release();
  }
}
