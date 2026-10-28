import { isCancellationError, runCancellable } from '@bobsled-inc/connections';
import { AgentAssignmentSchema, parseAgentAssignmentOutcome } from './assignment.js';
import type { AgentAssignment } from './assignment.js';
import { agenticChargeableTokens } from './executor.js';
import type { ExperimentalAgenticProbe } from './probe.js';
import { createAssignmentBudget } from './call-budget.js';
import { createAssignmentSourceAccess } from './source-access.js';

/** Runtime handles live only for this attempt and are never part of saved state. */
export async function invokeAgenticAssignment(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  template: AgentAssignment,
  attemptId: string,
  signal: AbortSignal
) {
  const lifetime = new AbortController();
  const assignmentSignal = AbortSignal.any([signal, lifetime.signal]);
  const assignment = AgentAssignmentSchema.parse(
    structuredClone({ ...template, attempt_id: attemptId })
  );
  const limits = createAssignmentBudget(assignment, assignmentSignal);
  const access =
    assignment.mode === 'agent_loop' && host.sources
      ? createAssignmentSourceAccess(assignment, assignmentSignal, host.sources)
      : undefined;
  try {
    const result = await runCancellable(assignmentSignal, async () => {
      const payload = structuredClone(assignment);
      if (assignment.mode === 'agent_loop') {
        if (!access) throw new Error('Agent loops require source access');
        return host.executeAgent({
          assignment: { ...payload, mode: 'agent_loop' },
          signal: assignmentSignal,
          budget: limits.budget,
          sources: access.sources,
        });
      }
      return host.executeAgent({
        assignment: { ...payload, mode: 'llm_call' },
        signal: assignmentSignal,
        budget: limits.budget,
      });
    });
    limits.close();
    await access?.close();
    const outcome = parseAgentAssignmentOutcome(assignment, result);
    const charge = Math.max(
      limits.charged(),
      agenticChargeableTokens(
        { id: attemptId, attempt_id: attemptId, tokens: assignment.limits.tokens },
        outcome.usage
      )
    );
    if (access && !access.valid()) throw new Error('Source access violation');
    // A measured overcharge is returned so the coordinator saves it before failing.
    if (
      !limits.valid() &&
      (assignment.limits.tokens === null || charge <= assignment.limits.tokens)
    ) {
      throw new Error('Assignment budget violation');
    }
    return { outcome, charge };
  } catch (error) {
    if (isCancellationError(error, signal)) throw error;
    throw new Error('Agentic host operation failed', { cause: error });
  } finally {
    limits.close();
    lifetime.abort();
    await access?.close();
  }
}
