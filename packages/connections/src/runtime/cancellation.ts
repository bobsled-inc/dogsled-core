/**
 * Cooperative cancellation primitives for the SQL runner contract.
 *
 * The contract this module exists to enforce: when a caller aborts an
 * `AbortSignal` mid-statement, the runner must ask the DRIVER to cancel the
 * active operation — not merely reject the promise while the warehouse keeps
 * burning compute. Every built-in runner routes its statement execution through
 * {@link runCancellable} and registers a driver-specific canceller:
 *
 * | Dialect    | Driver primitive                                  |
 * | ---------- | ------------------------------------------------- |
 * | DuckDB     | `DuckDBConnection.interrupt()`                    |
 * | BigQuery   | `Job.cancel()`                                    |
 * | Snowflake  | `RowStatement.cancel(cb)`                         |
 * | Databricks | `IOperation.cancel()`                             |
 * | Postgres   | `pg_cancel_backend(pid)` over a side connection   |
 *
 * `signal` is optional everywhere. Absent a signal these helpers are a
 * pass-through, so existing callers and host-registered custom runners keep
 * working unchanged.
 */

/**
 * Thrown when a statement is cancelled through an `AbortSignal`.
 *
 * Distinct from an ordinary execution failure on purpose: consumers branch on
 * {@link isCancellationError} to report a cancelled run as cancelled rather
 * than collapsing it into a misleading warehouse error.
 */
export class SqlCancelledError extends Error {
  override readonly name = 'SqlCancelledError';
  /** Discriminator for structural checks across package/realm boundaries. */
  readonly cancelled = true as const;

  constructor(message = 'SQL execution cancelled.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * True when `error` represents cancellation rather than a warehouse failure.
 *
 * Accepts three shapes so the check survives realm boundaries and driver
 * variation:
 *   - a {@link SqlCancelledError} instance,
 *   - any error carrying `cancelled === true` (structural — survives a
 *     duplicated module instance in a bundled consumer),
 *   - a DOM `AbortError`, which is what `AbortSignal.throwIfAborted()` and
 *     several `fetch`-based drivers raise.
 */
export function isCancellationError(
  error: unknown,
  signal?: Pick<AbortSignal, 'aborted'>
): boolean {
  if (error instanceof SqlCancelledError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { cancelled?: unknown }).cancelled === true) return true;
  // `AbortError` is also used by driver timeouts and unrelated fetches. Treat
  // that generic name as caller cancellation only when THIS operation's signal
  // actually aborted; otherwise preserve the ordinary failure diagnostic.
  return signal?.aborted === true && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Reject immediately if `signal` is already aborted.
 *
 * Used as the pre-flight guard so an already-aborted signal prevents warehouse
 * execution from starting at all — no connection opened, no statement sent.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SqlCancelledError('SQL execution cancelled before the statement started.', {
      cause: signal.reason,
    });
  }
}

/**
 * Registers a driver-specific canceller for the operation currently in flight.
 *
 * Call this as soon as the driver hands back a cancellable handle (a BigQuery
 * job, a Snowflake statement, a Databricks operation). If the signal has
 * ALREADY aborted by the time the handle exists, the canceller fires
 * immediately — that closes the race where the abort lands between the
 * pre-flight guard and the driver returning its handle.
 */
export type RegisterCanceller = (cancel: () => void | Promise<void>) => void;

/**
 * Run a driver operation under cooperative cancellation.
 *
 * `op` receives a {@link RegisterCanceller}. On abort:
 *   1. the registered canceller runs, so the DRIVER tears down the active
 *      operation (this is the part that actually stops warehouse work), and
 *   2. the returned promise settles with a {@link SqlCancelledError}.
 *
 * The returned promise does not settle until both the driver's cancellation
 * request and the active operation have settled. This is intentional: returning
 * a cancellation result while the warehouse operation is still running would
 * orphan work and let callers close the runner too early. A canceller failure is
 * retained as the cancellation error's cause, but the operation is still
 * awaited so no driver rejection can escape in the background.
 *
 * With no signal this is exactly `op(noop)` — no listeners, no extra promises.
 */
export async function runCancellable<T>(
  signal: AbortSignal | undefined,
  op: (register: RegisterCanceller) => Promise<T>
): Promise<T> {
  if (!signal) return op(noopRegister);
  throwIfCancelled(signal);

  let canceller: (() => void | Promise<void>) | undefined;
  let cancelRequest: Promise<void> | undefined;
  let cancelError: unknown;
  const invokeCanceller = (): Promise<void> | undefined => {
    if (cancelRequest) return cancelRequest;
    const fn = canceller;
    if (!fn) return undefined;
    // Fire once — a second abort event (or a late registration after abort)
    // must not double-cancel a handle the driver may already have released.
    canceller = undefined;
    cancelRequest = Promise.resolve()
      .then(fn)
      .catch((error: unknown) => {
        // Cancellation remains the public outcome, but preserve delivery
        // failure as its cause for diagnostics instead of replacing it with an
        // ordinary warehouse failure.
        cancelError = error;
      });
    return cancelRequest;
  };

  const register: RegisterCanceller = (cancel) => {
    canceller = cancel;
    if (signal.aborted) void invokeCanceller();
  };

  let observeAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    observeAbort = resolve;
  });
  const onAbort = (): void => {
    void invokeCanceller();
    observeAbort();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  let running: Promise<T>;
  try {
    running = op(register);
  } catch (error) {
    running = Promise.reject(error);
  }

  // `op` may synchronously abort the signal before returning its promise.
  if (signal.aborted) onAbort();

  const completed = running.then(
    (value) => ({ kind: 'completed' as const, value }),
    (error: unknown) => ({ kind: 'failed' as const, error })
  );

  try {
    const first = await Promise.race([
      completed,
      aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    if (first.kind === 'completed') return first.value;
    if (first.kind === 'failed') throw first.error;

    // A handle may only become available after the abort (BigQuery jobs and
    // Databricks operations are examples). `register()` notices the already
    // aborted signal and starts cancellation as soon as that handle exists.
    // Waiting for the operation first is safe because its settlement depends on
    // that late registration; afterwards, also await the cancel acknowledgement
    // itself in case the driver operation settled before the acknowledgement.
    await completed;
    await cancelRequest;

    throw new SqlCancelledError('SQL execution cancelled while the statement was in flight.', {
      cause: cancelError ?? signal.reason,
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Break the reference so a long-lived signal does not retain the handle.
    canceller = undefined;
  }
}

const noopRegister: RegisterCanceller = () => {};
