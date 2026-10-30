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
