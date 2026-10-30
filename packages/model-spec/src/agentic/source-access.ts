import { runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import type { AgentAssignment } from './assignment.js';
import { AgenticSourceRequestSchema } from './executor.js';
import type { AgenticSourceAccess, AgenticSourceHost } from './executor.js';
import { AGENTIC_MAX_ROWS, AgenticJsonSchema } from './rows.js';

/** Host-owned allowlist. Model text cannot add a capability or change its scope. */
export function createAssignmentSourceAccess(
  assignment: AgentAssignment,
  signal: AbortSignal,
  host: AgenticSourceHost
) {
  const allowed = new Set(assignment.allowed_sources);
  const pending = new Set<Promise<unknown>>();
  let open = true;
  let calls = 0;
  let invalid = false;
  // Safe reason for the first failure; never includes provider text or model-chosen names.
  let failure: string | undefined;
  const fail = (reason: string): never => {
    failure ??= reason;
    throw new Error(reason);
  };
  const sources: AgenticSourceAccess = (request) => {
    const operation = (async () => {
      try {
        throwIfCancelled(signal);
        if (!open) fail('was made after the assignment finished');
        if (invalid) fail('was made after an earlier source request failed');
        if (pending.size >= 16) fail('exceeded 16 concurrent source requests');
        const parsed = AgenticSourceRequestSchema.safeParse(
          AgenticJsonSchema.safeParse(request).data
        );
        if (!parsed.success) return fail('had an invalid shape or exceeded the JSON size limit');
        if (!allowed.has(parsed.data.source)) fail('named a source this step does not declare');
        if (!['read', 'search'].includes(parsed.data.operation)) {
          fail(`used unsupported operation on source "${parsed.data.source}"`);
        }
        if (assignment.limits.tool_calls != null && calls >= assignment.limits.tool_calls) {
          fail(`exceeded the tool call limit (${assignment.limits.tool_calls})`);
        }
        calls++;
        const source = parsed.data.source;
        let response: unknown;
        try {
          response = await runCancellable(signal, async () =>
            host(structuredClone(parsed.data), {
              assignment: structuredClone(assignment),
              signal,
            })
          );
        } catch {
          throwIfCancelled(signal);
          // The host's own text may contain credentials; record only where it failed.
          return fail(`to "${source}" failed in the source host`);
        }
        throwIfCancelled(signal);
        const checked = AgenticJsonSchema.safeParse(response);
        if (!checked.success) fail(`to "${source}" returned more data than the JSON size limit`);
        const value = checked.data!;
        const rows = Array.isArray(value)
          ? value
          : value && typeof value === 'object'
            ? value.rows
            : undefined;
        if (Array.isArray(rows) && rows.length > AGENTIC_MAX_ROWS) {
          fail(`to "${source}" returned more than ${AGENTIC_MAX_ROWS} rows`);
        }
        return structuredClone(value);
      } catch {
        invalid = true;
        failure ??= 'failed';
        // Source/provider errors may contain credentials. Never expose them to the executor.
        throw new Error('Agentic source request failed');
      }
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
    valid: () => !invalid,
    failure: () => failure,
    async close() {
      open = false;
      await Promise.allSettled([...pending]);
    },
  };
}
