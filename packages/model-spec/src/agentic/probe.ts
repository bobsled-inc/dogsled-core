import { deadlineTime } from './limits.js';
/** Bounded, serial dispatch probe. This is not a durable publication adapter. */
import { isCancellationError, runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import type { ExecuteAgent, AgenticSourceHost } from './executor.js';
import { AGENTIC_MAX_BYTES, AGENTIC_MAX_ROWS } from './rows.js';
import type { AgenticColumn } from './model.js';
import type { ResolvedAgenticModel } from './resolve.js';
import type { SupportedDialect } from '../compiler/dialect.js';
import { executeAgenticRun } from './run.js';
import type { AgenticRunOptions } from './run.js';

export interface AgenticProbeContext {
  resolved: ResolvedAgenticModel;
  integration: string;
  target: string;
  inputRef: string;
  /** Internal warehouse publication schema, bound to the saved run identity. */
  publicationSchema?: string;
  /** SELECT that also inlines ephemeral ancestors, when present. */
  inputSql?: string;
  /** Per-reference SQL for ephemeral prepared inputs. */
  inputSqlByRef?: Record<string, string>;
  /** Schema for the specific input requested by a plan step. */
  inputColumns?: AgenticColumn[];
  /** Apply this input filter before the row limit. The coordinator validates it again. */
  incremental?: { cursor_field: string; after?: string | number };
  signal: AbortSignal;
  maxRows: number;
  maxBytes: number;
}

/** Explicit host opt-in for the bounded execution path and test publication seam. */
export interface ExperimentalAgenticProbe {
  supportedDialects: readonly SupportedDialect[];
  inputs: Readonly<Record<string, unknown>>;
  platform: { models?: Readonly<Record<string, unknown>> };
  /**
   * `true` only when `executeAgent` runs every profile and signs in to the
   * model provider itself. Each profile's own `api_key` name then counts as
   * declared when the run resolves profiles. Defaults to `false`.
   */
  hostManagedModelAuth?: boolean;
  tokensPerAssignment?: number;
  /** Maximum active assignments in this process. Defaults to 1; range 1–64. */
  concurrency?: number;
  /** Minimum delay between assignment starts. Defaults to 0; range 0–60000 ms. */
  minDispatchIntervalMs?: number;
  /** Approved tools this executor provides by default. Omitted means no extra tools. */
  supportedTools?: readonly string[];
  executeAgent: ExecuteAgent;
  /** Trusted read-only adapter. Required for agent_loop, absent from direct-call payloads. */
  sources?: AgenticSourceHost;
  /** Must bound preparation before returning; the coordinator checks returned data too. */
  prepare(context: AgenticProbeContext): Promise<unknown>;
  /** Test-only publication seam. Complete it before downstream SQL starts. */
  publish(
    context: AgenticProbeContext,
    rows: readonly JsonValue[],
    processedKeys: readonly JsonValue[]
  ): Promise<void>;
}

/** The publication callback remains a test seam. Completed execution is never republished on resume. */
export async function executeAgenticProbe(
  host: ExperimentalAgenticProbe,
  context: Omit<AgenticProbeContext, 'signal' | 'maxRows' | 'maxBytes'>,
  signal: AbortSignal | undefined,
  persistence: AgenticRunOptions & { projectDirectory: string }
): Promise<void> {
  const result = await executeAgenticRun(host, context, {
    ...persistence,
    ...(signal ? { signal } : {}),
  });
  if (result.reusedCompletion) {
    throw new Error(
      'Agentic execution is complete; warehouse publication is pending and needs host reconciliation'
    );
  }
  const remaining = deadlineTime(result.deadlineAt) - Date.now();
  if (remaining <= 0) throw new Error('Agentic run deadline expired');
  const timeout = Number.isFinite(remaining)
    ? AbortSignal.timeout(remaining)
    : new AbortController().signal;
  const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  throwIfCancelled(runSignal);
  if (result.processedKeys.length) {
    try {
      await runCancellable(runSignal, async () =>
        host.publish(
          { ...context, signal: runSignal, maxRows: AGENTIC_MAX_ROWS, maxBytes: AGENTIC_MAX_BYTES },
          result.rows,
          result.processedKeys
        )
      );
    } catch (error) {
      if (isCancellationError(error, runSignal)) throw error;
      throw new Error('Agentic probe publication failed', { cause: error });
    }
  }
  throwIfCancelled(runSignal);
}
