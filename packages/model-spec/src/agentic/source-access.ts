import { runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';
import type { AgentAssignment } from './assignment.js';
import { AgenticSourceRequestSchema } from './executor.js';
import type { AgenticSourceAccess, AgenticSourceHost } from './executor.js';
import { AGENTIC_MAX_ROWS, AgenticJsonSchema } from './rows.js';

/** A rejected request. `policy` marks requests the executor must never make. */
class SourceRequestError extends Error {
  constructor(
    readonly reason: string,
    readonly policy: boolean
  ) {
    super(`Agentic source request failed: ${reason}`);
    this.name = 'SourceRequestError';
  }
}

/**
 * Host-owned allowlist. Model text cannot add a capability or change its scope.
 *
 * A failed or rejected request rejects only that call, with a safe reason the executor
 * can show the model; agent loops are expected to recover. A policy violation (an
 * undeclared source, an unsupported operation, a call after the assignment finished or
 * over its call limit) also fails the assignment through `denied()`. Neither stops the run.
 */
export function createAssignmentSourceAccess(
  assignment: AgentAssignment,
  signal: AbortSignal,
  host: AgenticSourceHost
) {
  const allowed = new Set(assignment.allowed_sources);
  const pending = new Set<Promise<unknown>>();
  let open = true;
  let calls = 0;
  // Safe reason for the first policy violation; never provider text or model-chosen names.
  let denied: string | undefined;
  const reject = (reason: string, policy = false): never => {
    if (policy) denied ??= reason;
    throw new SourceRequestError(reason, policy);
  };
  const sources: AgenticSourceAccess = (request) => {
    const operation = (async () => {
      throwIfCancelled(signal);
      if (!open) reject('the request was made after the assignment finished', true);
      if (pending.size >= 16) reject('more than 16 source requests were in flight');
      const parsed = AgenticSourceRequestSchema.safeParse(
        AgenticJsonSchema.safeParse(request).data
      );
      if (!parsed.success) return reject('the request had an invalid shape or was too large');
      if (!allowed.has(parsed.data.source)) {
        reject('the request named a source this step does not declare', true);
      }
      const source = parsed.data.source;
      if (!['read', 'search'].includes(parsed.data.operation)) {
        reject(`source "${source}" supports only read and search`, true);
      }
      if (assignment.limits.tool_calls != null && calls >= assignment.limits.tool_calls) {
        reject(`the assignment used its ${assignment.limits.tool_calls} source calls`, true);
      }
      calls++;
      let response: unknown;
      try {
        response = await runCancellable(signal, async () =>
          host(structuredClone(parsed.data), {
            assignment: structuredClone(assignment),
            signal,
          })
        );
      } catch (error) {
        throwIfCancelled(signal);
        // Host policy errors are fixed CommandError text; anything else may hold credentials.
        reject(
          error instanceof CommandError
            ? `source "${source}": ${error.message}`
            : `source "${source}" failed in the source host`
        );
      }
      throwIfCancelled(signal);
      const checked = AgenticJsonSchema.safeParse(response);
      if (!checked.success) reject(`source "${source}" returned more data than the JSON limit`);
      const value = checked.data!;
      const rows = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
          ? value.rows
          : undefined;
      if (Array.isArray(rows) && rows.length > AGENTIC_MAX_ROWS) {
        reject(`source "${source}" returned more than ${AGENTIC_MAX_ROWS} rows`);
      }
      return structuredClone(value);
    })();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  };
  return {
    sources,
    /** The first policy violation, which fails this assignment; undefined when none. */
    denied: () => denied,
    async close() {
      open = false;
      await Promise.allSettled([...pending]);
    },
  };
}
