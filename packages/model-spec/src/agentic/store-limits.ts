import { AGENTIC_MAX_CHECKPOINT_BYTES } from './checkpoint-json.js';
import { AGENTIC_MAX_BYTES, AGENTIC_MAX_ROWS } from './rows.js';
import { AgenticStateError } from './state-errors.js';

/**
 * What one state store can hold. The run loop bounds input with these values, and the store
 * rejects a larger checkpoint. Today's schema bounds are the ceiling a store may declare:
 * a store that can hold more raises them together with its own declaration.
 */
export interface AgenticStoreLimits {
  /** Rows in one input batch and assignments in one run. */
  maxRows: number;
  /** UTF-8 bytes in one input batch. */
  maxBatchBytes: number;
  /** UTF-8 bytes in one run's complete snapshot. */
  maxCheckpointBytes: number;
}

export const AGENTIC_DEFAULT_STORE_LIMITS: Readonly<AgenticStoreLimits> = Object.freeze({
  maxRows: AGENTIC_MAX_ROWS,
  maxBatchBytes: AGENTIC_MAX_BYTES,
  maxCheckpointBytes: AGENTIC_MAX_CHECKPOINT_BYTES,
});

/** Supplied stores that declare nothing keep the historic limits. */
export function resolveAgenticStoreLimits(store: {
  limits?: AgenticStoreLimits;
}): AgenticStoreLimits {
  const limits = store.limits ?? AGENTIC_DEFAULT_STORE_LIMITS;
  for (const name of ['maxRows', 'maxBatchBytes', 'maxCheckpointBytes'] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > AGENTIC_DEFAULT_STORE_LIMITS[name]) {
      throw new AgenticStateError('limit', {
        reason: 'invalid_store_limits',
        message: `The state store declares ${name} ${value}; the allowed range is 1 to ${AGENTIC_DEFAULT_STORE_LIMITS[name]}.`,
      });
    }
  }
  return limits;
}
