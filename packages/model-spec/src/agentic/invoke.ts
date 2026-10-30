import { isCancellationError, runCancellable } from '@bobsled-inc/connections';
import {
  AgentAssignmentSchema,
  AgenticUsageSchema,
  parseAgentAssignmentOutcome,
} from './assignment.js';
import type { AgentAssignment, AgentAssignmentOutcome } from './assignment.js';
import { agenticChargeableTokens } from './executor.js';
import type { ExperimentalAgenticProbe } from './probe.js';
import { createAssignmentBudget } from './call-budget.js';
import { createAssignmentSourceAccess } from './source-access.js';
import { AgenticHostError, describeZodIssues } from './errors.js';

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
  const label = `step "${assignment.step_id}" assignment ${assignment.shard_id}`;
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
    let outcome: AgentAssignmentOutcome;
    let invalidOutput: string | undefined;
    try {
      outcome = parseAgentAssignmentOutcome(assignment, result);
    } catch (error) {
      // An invalid answer is a retryable failed attempt, never accepted and never fatal.
      invalidOutput = describeZodIssues(error);
      const usage = AgenticUsageSchema.safeParse(
        result && typeof result === 'object' ? (result as { usage?: unknown }).usage : undefined
      );
      outcome = parseAgentAssignmentOutcome(assignment, {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'failed',
        error: { kind: 'validation', code: 'invalid_executor_output', retryable: true },
        usage: usage.success ? usage.data : { status: 'unknown', reason: 'unavailable' },
      });
    }
    const charge = Math.max(
      limits.charged(),
      agenticChargeableTokens(
        { id: attemptId, attempt_id: attemptId, tokens: assignment.limits.tokens },
        outcome.usage
      )
    );
    if (access && !access.valid()) {
      throw new AgenticHostError(
        `Agentic ${label} stopped because a source request ${access.failure() ?? 'failed'}.`,
        { cause: undefined }
      );
    }
    // A measured overcharge is returned so the coordinator saves it before failing.
    if (
      !limits.valid() &&
      (assignment.limits.tokens === null || charge <= assignment.limits.tokens)
    ) {
      throw new AgenticHostError(
        `Agentic ${label} stopped because the executor broke the token budget contract: ${limits.failure() ?? 'invalid usage report'}.`,
        { cause: undefined }
      );
    }
    return { outcome, charge, ...(invalidOutput ? { invalidOutput } : {}) };
  } catch (error) {
    if (isCancellationError(error, signal)) throw error;
    if (error instanceof AgenticHostError) throw error;
    // parseAgentAssignmentOutcome messages describe fields, never values.
    throw new AgenticHostError(`Agentic executor failed for ${label}.`, { cause: error });
  } finally {
    limits.close();
    lifetime.abort();
    await access?.close();
  }
}
