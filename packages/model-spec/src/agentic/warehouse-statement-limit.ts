import {
  isCancellationError,
  resolveRunner,
  type IntegrationFile,
  type ResolveRunnerOptions,
  type SqlQueryRunner,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { AgenticStateError, statementTimeoutReason } from './state-errors.js';

/**
 * The heartbeat renews at one third of the lease. The limit and backstop together stay
 * inside the remaining two thirds, so a hung renewal is reported before the lease expires.
 * Deriving both from the lease also gives a host that raised it for a queueing warehouse
 * more time per statement. Opening a connection holds no lease, so it has a longer bound
 * for a warehouse that has to start.
 */
export function warehouseStatementLimits(leaseMs = 120_000) {
  const lease = Math.min(600_000, Math.max(10_000, leaseMs));
  const statementMs = Math.floor(lease / 2000) * 1000;
  const backstopMs = Math.floor(lease / 12);
  return { statementMs, backstopMs, openMs: Math.max(300_000, statementMs + backstopMs) };
}
type Limits = ReturnType<typeof warehouseStatementLimits>;

/** What happens to a session whose statement timed out. */
export interface StatementTimeoutHandling {
  /** How long ownership can stay blocked. Omit it when the caller holds no lease. */
  retryAfterMs?: number;
  onTimeout?: (error: AgenticStateError) => void;
}

function statementTimeout(
  { statementMs }: Limits,
  { retryAfterMs }: StatementTimeoutHandling,
  cause?: unknown
) {
  return new AgenticStateError(
    'lease_lost',
    {
      reason: statementTimeoutReason,
      message: `A checkpoint store statement was queued or running for ${statementMs / 1000} seconds without finishing, so this process stopped using its session.`,
      hint: 'Resume the run once its lease has expired. For a slow warehouse, raise checkpoint_store.lease_seconds; the statement limit is half of it.',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
    // The driver's text stays in the cause: formatters never print it.
    cause === undefined ? undefined : { cause }
  );
}

function connectTimeout({ openMs }: Limits) {
  return new AgenticStateError('unavailable', {
    reason: 'connect_timeout',
    message: `The checkpoint store did not open a connection within ${openMs / 1000} seconds.`,
    hint: 'The warehouse may be stopped or still starting. Check that it is available, then resume the run.',
  });
}

/** Rejects with `timeoutError()` at the limit, even if `operation` never settles. */
async function within<T>(
  operation: Promise<T>,
  limitMs: number,
  timeoutError: () => unknown
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      // Left referenced: the deadline must fire even if nothing else keeps the process alive.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounds every statement on a runner and keeps its call shape. The deadline stops waiting;
 * it does not cancel. The server-side limit stops the statement, closing the connection ends
 * any open transaction, and a statement that still lands later fails its fencing predicate
 * once the lease has expired. After a timeout the connection may still be busy, so later
 * statements, such as a ROLLBACK that would queue behind the hung one, fail at once.
 */
function limitRunner(
  runner: SqlRunnerModule,
  limits: Limits,
  handling: StatementTimeoutHandling
): SqlRunnerModule {
  let timedOut: AgenticStateError | undefined;
  const expire = (cause?: unknown) => {
    if (!timedOut) {
      timedOut = statementTimeout(limits, handling, cause);
      handling.onTimeout?.(timedOut);
    }
    return timedOut;
  };
  const limit = async <T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T> => {
    if (timedOut) throw timedOut;
    const started = performance.now();
    try {
      return await within(start(), limits.statementMs + limits.backstopMs, () => expire());
    } catch (error) {
      // Warehouses report their own timeout in different words. Elapsed time identifies it
      // on every dialect, and any statement that used the whole limit has the same outcome.
      if (performance.now() - started < limits.statementMs || isCancellationError(error, signal)) {
        throw error;
      }
      throw expire(error);
    }
  };
  return {
    ...runner,
    run: (...args: Parameters<SqlRunnerModule['run']>) =>
      limit(args[1]?.signal, () => runner.run(...args)),
    ...(runner.query && {
      query: (...args: Parameters<SqlQueryRunner>) =>
        limit(args[2]?.signal, () => runner.query!(...args)),
    }),
    ...(runner.close && {
      close: async () => {
        // A connection that will not close must not hold up the outcome of the run.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            runner.close!(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, limits.backstopMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  };
}

/** Opens a dedicated state or cursor runner. Model and publication runners stay unlimited. */
export async function openLimitedRunner(
  integration: IntegrationFile,
  options: ResolveRunnerOptions & { leaseMs?: number },
  handling: StatementTimeoutHandling = {}
): Promise<SqlRunnerModule> {
  const limits = warehouseStatementLimits(options.leaseMs);
  const opening = resolveRunner(integration, {
    ...options,
    statementTimeoutMs: limits.statementMs,
  });
  try {
    const runner = await within(opening, limits.openMs, () => connectTimeout(limits));
    return limitRunner(runner, limits, handling);
  } catch (error) {
    // A connection that arrives after the deadline has no owner left to close it.
    void opening.then((late) => late.close?.()).catch(() => {});
    throw error;
  }
}
