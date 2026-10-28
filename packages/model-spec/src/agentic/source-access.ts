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
  const sources: AgenticSourceAccess = (request) => {
    const operation = (async () => {
      try {
        throwIfCancelled(signal);
        if (!open || invalid || pending.size >= 16) throw new Error('Source access is closed');
        const parsed = AgenticSourceRequestSchema.parse(AgenticJsonSchema.parse(request));
        if (!allowed.has(parsed.source) || !['read', 'search'].includes(parsed.operation)) {
          throw new Error('Source access denied');
        }
        if (assignment.limits.tool_calls != null && calls >= assignment.limits.tool_calls) {
          throw new Error('Assignment tool limit exceeded');
        }
        calls++;
        const response = await runCancellable(signal, async () =>
          host(structuredClone(parsed), {
            assignment: structuredClone(assignment),
            signal,
          })
        );
        throwIfCancelled(signal);
        const value = AgenticJsonSchema.parse(response);
        const rows = Array.isArray(value)
          ? value
          : value && typeof value === 'object'
            ? value.rows
            : undefined;
        if (Array.isArray(rows) && rows.length > AGENTIC_MAX_ROWS) {
          throw new Error('Source row limit exceeded');
        }
        return structuredClone(value);
      } catch {
        invalid = true;
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
    async close() {
      open = false;
      await Promise.allSettled([...pending]);
    },
  };
}
