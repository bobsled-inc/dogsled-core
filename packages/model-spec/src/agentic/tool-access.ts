import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { AgenticToolNamesSchema, type AgenticModelSpec, type AgenticStep } from './model.js';
import type { ResolvedAgenticModel } from './resolve.js';

/** Capability declarations do not replace the host's per-call authorization. */
export function validateAgenticTools(
  model: AgenticModelSpec,
  supportedTools: readonly string[] = []
): void {
  const available = new Set(supportedTools);
  for (const step of model.plan.steps) {
    for (const name of step.execution.tools ?? []) {
      if (!available.has(name)) {
        throw new CommandError(`Agentic tool "${name}" is unavailable`, EXIT_VALIDATION);
      }
    }
  }
}

/** Bind host defaults once so checkpoints retain the effective tool selection. */
export function bindAgenticTools<T extends { resolved: ResolvedAgenticModel }>(
  context: T,
  supportedTools: readonly string[] = []
): T {
  if (!supportedTools.length) return context;
  const defaults = AgenticToolNamesSchema.parse(supportedTools);
  const bind = (step: AgenticStep) =>
    step.execution.mode === 'agent_loop' && step.execution.tools === undefined
      ? { ...step, execution: { ...step.execution, tools: defaults } }
      : step;
  return {
    ...context,
    resolved: {
      ...context.resolved,
      model: {
        ...context.resolved.model,
        plan: {
          ...context.resolved.model.plan,
          steps: context.resolved.model.plan.steps.map(bind),
        },
      },
      steps: context.resolved.steps.map((resolved) => ({ ...resolved, step: bind(resolved.step) })),
    },
  };
}
