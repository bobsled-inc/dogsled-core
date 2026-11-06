import { agenticDeadlinePassed } from './state-errors.js';
import { deadlineTime } from './limits.js';
import { agenticDeadlineAt } from './execution-window.js';
import { runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import {
  AgenticPublicationReceiptSchema,
  createAgenticPublicationIdentity,
  type AgenticPublisher,
  type AgenticPublicationContext,
} from './publication.js';
import {
  AgenticStateError,
  digestAgenticState,
  type AgenticRunSnapshot,
  type AgenticStateSession,
  type AgenticCheckpointCommand,
} from './state.js';
import { validateAgenticReceipt } from './checkpoint-receipt.js';

/** Preflight is protected work: it consumes the original saved deadline. */
export async function preflightAgenticPublication(
  publisher: AgenticPublisher,
  session: AgenticStateSession,
  snapshot: AgenticRunSnapshot,
  context: AgenticPublicationContext,
  signal: AbortSignal
): Promise<void> {
  if (Date.now() >= deadlineTime(agenticDeadlineAt(snapshot))) {
    throw agenticDeadlinePassed('before publication');
  }
  validateAgenticReceipt(await session.read(), snapshot);
  await runCancellable(signal, () => publisher.preflight(context, signal));
  validateAgenticReceipt(await session.read(), snapshot);
  if (Date.now() >= deadlineTime(agenticDeadlineAt(snapshot))) {
    throw agenticDeadlinePassed('before publication');
  }
  throwIfCancelled(signal);
}

export async function publishAgenticRun(
  publisher: AgenticPublisher,
  session: AgenticStateSession,
  snapshot: AgenticRunSnapshot,
  context: AgenticPublicationContext,
  findings: readonly JsonValue[],
  processedKeys: readonly JsonValue[],
  checkpoint: (command: AgenticCheckpointCommand) => Promise<AgenticRunSnapshot>,
  runSignal: AbortSignal,
  needsPreflight: boolean,
  signal?: AbortSignal
): Promise<AgenticRunSnapshot> {
  const assertOwner = async (): Promise<void> => {
    validateAgenticReceipt(await session.read(), snapshot);
  };
  const identity = createAgenticPublicationIdentity(snapshot);
  // Saved state is frozen. A publisher receives data of its own.
  let intent = structuredClone(snapshot.publication_intent);
  let receipt = intent ? await publisher.inspect(intent, signal) : null;
  if (!receipt) {
    if (Date.now() >= deadlineTime(agenticDeadlineAt(snapshot))) {
      throw agenticDeadlinePassed('before publication');
    }
    throwIfCancelled(runSignal);
    if (needsPreflight) {
      await preflightAgenticPublication(publisher, session, snapshot, context, runSignal);
    }
    await assertOwner();
    const claim = await publisher.claim(context.target, runSignal);
    await assertOwner();
    if (!intent) {
      intent = await publisher.prepare(
        context,
        identity,
        findings,
        processedKeys,
        claim,
        runSignal
      );
      if (intent.expected_version !== claim.version) throw new AgenticStateError('corrupt');
      await assertOwner();
      snapshot = await checkpoint({
        type: 'prepare_publication',
        operation_id: identity.operation_id,
        expected_revision: snapshot.revision,
        intent,
      });
    }
    await assertOwner();
    if (Date.now() >= deadlineTime(agenticDeadlineAt(snapshot))) {
      throw agenticDeadlinePassed('before publication');
    }
    throwIfCancelled(runSignal);
    try {
      receipt = await publisher.commit(intent, claim, runSignal);
    } catch (error) {
      // COMMIT may have succeeded. Reconcile without the cancelled signal before reporting failure.
      receipt = await publisher.inspect(intent);
      if (!receipt) throw error;
    }
  }
  const parsed = AgenticPublicationReceiptSchema.parse(receipt);
  if (digestAgenticState(parsed.intent) !== digestAgenticState(intent)) {
    throw new AgenticStateError('corrupt');
  }
  await assertOwner();
  snapshot = await checkpoint({
    type: 'confirm_publication',
    operation_id: identity.operation_id,
    expected_revision: snapshot.revision,
    receipt: parsed,
  });
  return snapshot;
}
