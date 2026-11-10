import { AGENTIC_MAX_BYTES, AGENTIC_MAX_ROWS } from './rows.js';
import { AgenticStateError } from './state-errors.js';

/**
 * What one state store can hold. The run loop bounds input with these values, and the store
 * rejects a larger checkpoint. The defaults cap unbranded declarations. The row store declares
 * more on the engines measured in docs/agentic-state.md.
 */
export interface AgenticStoreLimits {
  /** Rows in one input batch and assignments in one run. */
  maxRows: number;
  /** UTF-8 bytes in one input batch, and in a run's final output. */
  maxBatchBytes: number;
  /** UTF-8 bytes in one run's complete snapshot. */
  maxCheckpointBytes: number;
}

const MiB = 1024 * 1024;
const ROW_STORE_LIMITS_BRAND = Symbol.for('@bobsled-inc/model-spec/agentic-row-store-limits');

/** A store that declares nothing, the file store and the warehouse store hold this much. */
export const AGENTIC_DEFAULT_STORE_LIMITS: Readonly<AgenticStoreLimits> = Object.freeze({
  maxRows: AGENTIC_MAX_ROWS,
  maxBatchBytes: AGENTIC_MAX_BYTES,
  maxCheckpointBytes: 16 * MiB,
});

/**
 * The row store on DuckDB, PostgreSQL and Snowflake. As measured in docs/agentic-state.md, a run at
 * this size resumed in seconds on DuckDB and PostgreSQL and in under a minute on Snowflake, and fit
 * in the memory measured there.
 */
export const AGENTIC_ROW_STORE_LIMITS: Readonly<AgenticStoreLimits> = Object.freeze(
  Object.defineProperty(
    { maxRows: 10_000, maxBatchBytes: 16 * MiB, maxCheckpointBytes: 128 * MiB },
    ROW_STORE_LIMITS_BRAND,
    { value: true, enumerable: false }
  )
);

/** The most any store declares, and so what the snapshot schema accepts. */
export const AGENTIC_MAX_STORE_LIMITS: Readonly<AgenticStoreLimits> = AGENTIC_ROW_STORE_LIMITS;

/**
 * Values in one snapshot: one for every 64 bytes it may hold, which is the 262,144 that 16 MiB
 * has always had. The count bounds parser work before any schema reads a snapshot.
 */
export function agenticCheckpointValues(limits: Pick<AgenticStoreLimits, 'maxCheckpointBytes'>) {
  return Math.floor(limits.maxCheckpointBytes / 64);
}

/**
 * The row-store brand selects the higher ceiling across separately loaded bundles. An ordinary
 * copy drops the brand and keeps the defaults as its ceiling. Read each limit once into a frozen
 * copy so that a getter or later change cannot give a run more than was checked.
 */
export function resolveAgenticStoreLimits(store: {
  limits?: AgenticStoreLimits;
}): AgenticStoreLimits {
  const declared = store.limits ?? AGENTIC_DEFAULT_STORE_LIMITS;
  if (declared === AGENTIC_DEFAULT_STORE_LIMITS) return declared;
  const brand = Object.getOwnPropertyDescriptor(declared, ROW_STORE_LIMITS_BRAND);
  const ceilings =
    brand?.value === true && !brand.enumerable
      ? AGENTIC_MAX_STORE_LIMITS
      : AGENTIC_DEFAULT_STORE_LIMITS;
  const limits: AgenticStoreLimits = {
    maxRows: declared.maxRows,
    maxBatchBytes: declared.maxBatchBytes,
    maxCheckpointBytes: declared.maxCheckpointBytes,
  };
  for (const name of ['maxRows', 'maxBatchBytes', 'maxCheckpointBytes'] as const) {
    const value = limits[name];
    const ceiling = ceilings[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      const valueLabel = typeof value === 'number' ? value : 'a non-numeric value';
      throw new AgenticStateError('limit', {
        reason: 'invalid_store_limits',
        message: `The state store declares ${name} ${valueLabel}; the allowed range is 1 to ${ceiling}.`,
      });
    }
  }
  return Object.freeze(limits);
}

/**
 * What a run's checkpoints are checked against: everything the store may hold. A supplied store
 * that declares less than the defaults is still checked at the defaults, as it always was, and
 * its declaration bounds only the input the run prepares.
 */
export function agenticCheckpointLimits(limits: AgenticStoreLimits): AgenticStoreLimits {
  return {
    maxRows: Math.max(limits.maxRows, AGENTIC_DEFAULT_STORE_LIMITS.maxRows),
    maxBatchBytes: Math.max(limits.maxBatchBytes, AGENTIC_DEFAULT_STORE_LIMITS.maxBatchBytes),
    maxCheckpointBytes: Math.max(
      limits.maxCheckpointBytes,
      AGENTIC_DEFAULT_STORE_LIMITS.maxCheckpointBytes
    ),
  };
}

const formatMiB = (bytes: number): string => String(Math.round((bytes / MiB) * 100) / 100);

/** A run's size, as the snapshot schema and the verified checkpoint measure it. */
export interface AgenticCheckpointSize {
  /** Assignments in the run. */
  work: number;
  /** The most rows in any one frozen input. */
  inputRows: number;
  values: number;
  /** UTF-8 bytes of the snapshot's text and of its JSON. */
  textBytes: number;
  jsonBytes: number;
}

/** Why a snapshot of this size does not fit `limits`, or undefined when it does. */
export function agenticSizeLimitError(
  size: AgenticCheckpointSize,
  limits: AgenticStoreLimits
): AgenticStateError | undefined {
  if (size.work > limits.maxRows || size.inputRows > limits.maxRows) {
    const count = Math.max(size.work, size.inputRows);
    return new AgenticStateError('limit', {
      reason: 'too_many_rows',
      message: `The agentic run has ${count.toLocaleString('en-US')} ${size.work > limits.maxRows ? 'assignments' : 'input rows'}; this state store holds at most ${limits.maxRows.toLocaleString('en-US')}.`,
      hint: 'Process fewer input rows per run.',
    });
  }
  if (
    size.values > agenticCheckpointValues(limits) ||
    size.textBytes > limits.maxCheckpointBytes ||
    size.jsonBytes > limits.maxCheckpointBytes
  ) {
    return new AgenticStateError('limit', {
      reason: 'snapshot_too_large',
      message: `The agentic run checkpoint is larger than this state store holds: ${formatMiB(limits.maxCheckpointBytes)} MiB and ${agenticCheckpointValues(limits).toLocaleString('en-US')} values.`,
      hint: 'Process fewer or smaller input rows per run.',
    });
  }
  return undefined;
}
