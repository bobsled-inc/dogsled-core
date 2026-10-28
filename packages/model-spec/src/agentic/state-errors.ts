export type AgenticStateErrorCode =
  | 'superseded'
  | 'cursor_busy'
  | 'publication_pending'
  | 'takeover_blocked'
  | 'takeover_unsupported'
  | 'lease_lost'
  | 'conflict'
  | 'missing'
  | 'corrupt'
  | 'unavailable'
  | 'limit'
  | 'expired';
export class AgenticStateError extends Error {
  constructor(readonly code: AgenticStateErrorCode) {
    const messages: Partial<Record<AgenticStateErrorCode, string>> = {
      superseded: 'Agentic run was superseded by a new run and cannot resume.',
      cursor_busy:
        'Another agentic run owns this incremental batch. Wait for it to stop before starting a new run.',
      publication_pending:
        'The previous agentic run may have published output. Resume that run to confirm publication before starting a new run.',
      takeover_blocked:
        'Cannot take over the previous agentic run. It may still be active, or its checkpoint store is unavailable.',
      takeover_unsupported:
        'The cursor store does not support safe takeover. Upgrade the store or resume the previous run.',
    };
    super(messages[code] ?? `Agentic state ${code}`);
    this.name = 'AgenticStateError';
  }
}
