import { executionWindowsAfter } from './execution-window.js';
import {
  AgenticStateError,
  digestAgenticState,
  type AgenticRunSnapshot,
  type AgenticCheckpointCommand,
} from './state.js';
import { createAgenticPublicationIdentity } from './publication.js';

export function applyPublicationCheckpoint(
  state: AgenticRunSnapshot,
  command: Extract<
    AgenticCheckpointCommand,
    { type: 'prepare_publication' | 'confirm_publication' }
  >
): AgenticRunSnapshot {
  const conflict = (): never => {
    throw new AgenticStateError('conflict');
  };
  if (state.status !== 'execution_complete') conflict();
  const intent = command.type === 'prepare_publication' ? command.intent : command.receipt.intent;
  if (
    command.operation_id !== intent.identity.operation_id ||
    digestAgenticState(intent.identity) !==
      digestAgenticState(createAgenticPublicationIdentity(state))
  ) {
    conflict();
  }
  const prior =
    command.type === 'prepare_publication' ? state.publication_intent : state.publication_receipt;
  const payload = command.type === 'prepare_publication' ? command.intent : command.receipt;
  if (prior) {
    const offset =
      command.type === 'prepare_publication' && state.publication === 'confirmed' ? 2 : 1;
    if (
      command.expected_revision !==
        state.revision - offset - executionWindowsAfter(state, command.expected_revision) ||
      digestAgenticState(prior) !== digestAgenticState(payload)
    ) {
      conflict();
    }
    return state;
  }
  if (command.expected_revision !== state.revision) conflict();
  if (command.type === 'prepare_publication') {
    if (state.publication !== 'pending') conflict();
    state.publication_intent = command.intent;
    state.publication = 'prepared';
  } else {
    if (
      state.publication !== 'prepared' ||
      digestAgenticState(state.publication_intent) !== digestAgenticState(intent)
    ) {
      conflict();
    }
    state.publication_receipt = command.receipt;
    state.publication = 'confirmed';
  }
  state.revision++;
  return state;
}
