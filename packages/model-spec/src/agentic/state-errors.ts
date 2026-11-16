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

/**
 * Safe, user-facing context for a state error. Never put provider text, row data or
 * credentials here: the message is printed by the CLI and saved in JSON results.
 */
export interface AgenticErrorDetail {
  /** Stable machine-readable cause within the code, such as `spend_cap_reached`. */
  reason?: string;
  /** Replaces the default message for the code. */
  message?: string;
  /** What the user can do next. Appended to the message. */
  hint?: string;
  /** How long a new session must wait before it can acquire ownership. */
  retryAfterMs?: number;
}

const DEFAULT_MESSAGES: Record<AgenticStateErrorCode, string> = {
  superseded: 'Agentic run was superseded by a new run and cannot resume.',
  cursor_busy:
    'Another agentic run owns this incremental batch. Wait for it to stop before starting a new run.',
  publication_pending:
    'The previous agentic run may have published output. Resume that run to confirm publication before starting a new run.',
  takeover_blocked:
    'Cannot take over the previous agentic run. It may still be active, or its checkpoint store is unavailable.',
  takeover_unsupported:
    'The cursor store does not support safe takeover. Upgrade the store or resume the previous run.',
  lease_lost:
    'This process lost ownership of the agentic run checkpoint, so it stopped. Resume the run to continue.',
  conflict:
    'The saved agentic run state conflicts with this request. Another process may have changed it.',
  missing: 'No saved agentic run matches this run ID and scope.',
  corrupt:
    'The saved agentic run checkpoint is damaged or was written by an incompatible Bobsled Core version.',
  unavailable: 'The agentic checkpoint store is unavailable.',
  limit: 'An agentic run limit was reached.',
  expired: 'The agentic run deadline (limits.timeout_seconds) has passed.',
};

/** A `lease_lost` reason: a statement used its whole limit, so the session gave up. */
export const statementTimeoutReason = 'statement_timeout';

export class AgenticStateError extends Error {
  readonly reason?: string;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  /** `cause` may hold storage or driver text; formatters show only its type and code. */
  constructor(
    readonly code: AgenticStateErrorCode,
    detail: AgenticErrorDetail = {},
    options?: { cause?: unknown }
  ) {
    // Keep the stable code first so users and scripts can search for it.
    const label = detail.reason ? `${code} (${detail.reason})` : code;
    const message = detail.message ?? DEFAULT_MESSAGES[code];
    super(`Agentic state ${label}: ${message}${detail.hint ? ` ${detail.hint}` : ''}`, options);
    this.name = 'AgenticStateError';
    if (detail.reason !== undefined) this.reason = detail.reason;
    if (detail.hint !== undefined) this.hint = detail.hint;
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs;
  }
}

/** Shared deadline failure. `phase` says what was about to start, such as "before publication". */
export function agenticDeadlinePassed(phase: string): AgenticStateError {
  return new AgenticStateError('expired', {
    reason: 'deadline_passed',
    message: `The run deadline (limits.timeout_seconds) passed ${phase}.`,
    hint: 'Resume the run with --agent-resume; each resume gets a fresh timeout window and keeps accepted work.',
  });
}
