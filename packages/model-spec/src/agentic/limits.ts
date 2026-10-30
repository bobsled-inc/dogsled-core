import type { AgenticModelSpec, AgenticStep } from './model.js';

/**
 * `spend_cap` runs charge measured usage against run-level caps and stop dispatch at the
 * cap. Runs saved without the marker keep the original per-attempt reservation rules.
 */
export type AgenticAccounting = 'reservation' | 'spend_cap';

/** Omission inherits; null explicitly removes a per-assignment default. */
export function assignmentLimits(
  model: AgenticModelSpec,
  step: AgenticStep,
  legacyTokens?: number,
  accounting: AgenticAccounting = 'reservation'
) {
  // Spend-cap runs ignore the deprecated per-assignment limits.
  if (accounting === 'spend_cap') return { tokens: null };
  const value = (
    key: 'tokens_per_assignment' | 'tool_calls_per_assignment' | 'model_calls_per_assignment'
  ) => (step.limits?.[key] !== undefined ? step.limits[key] : model.limits[key]);
  return {
    tokens:
      value('tokens_per_assignment') === undefined
        ? (legacyTokens ?? null)
        : value('tokens_per_assignment')!,
    ...(value('tool_calls_per_assignment') !== undefined
      ? { tool_calls: value('tool_calls_per_assignment') }
      : {}),
    ...(value('model_calls_per_assignment') !== undefined
      ? { model_calls: value('model_calls_per_assignment') }
      : {}),
  };
}

export function deadlineTime(value: string | null): number {
  return value === null ? Infinity : Date.parse(value);
}

/** Reserve the remaining shared budget when no separate assignment cap exists. */
export function attemptReservation(
  tokens: number | null,
  total: number | null,
  charged: number
): number | null {
  return tokens ?? (total === null ? null : Math.max(0, total - charged));
}

const DEPRECATED_ASSIGNMENT_LIMITS = [
  'tokens_per_assignment',
  'tool_calls_per_assignment',
  'model_calls_per_assignment',
] as const;

/** YAML paths of per-assignment limits that spend-cap runs ignore, for a deprecation warning. */
export function deprecatedAssignmentLimitFields(model: AgenticModelSpec): string[] {
  const set = (limits: Record<string, unknown> | undefined) =>
    DEPRECATED_ASSIGNMENT_LIMITS.filter((key) => limits?.[key] != null);
  return [
    ...set(model.limits).map((key) => `limits.${key}`),
    ...model.plan.steps.flatMap((step) =>
      set(step.limits).map((key) => `plan.steps.${step.id}.limits.${key}`)
    ),
  ];
}
