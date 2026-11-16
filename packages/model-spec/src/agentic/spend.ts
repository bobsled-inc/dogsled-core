import type { AgentAssignment, AgenticUsage } from './assignment.js';
import { AgenticStateError } from './state-errors.js';
import type { AgenticProfile, ResolvedAgenticModel } from './resolve.js';

/**
 * Host pricing for one model profile, in US dollars. Return null when the price is
 * unknown. The coordinator calls it for estimates and for every finished attempt.
 */
export type AgenticPriceUsage = (
  profile: AgenticProfile,
  usage: { input_tokens: number; output_tokens: number }
) => number | null;

/** Rough input size: about four bytes per token. A lower bound for multi-turn loops. */
export function estimateAssignmentTokens(assignment: AgentAssignment): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(assignment), 'utf8') / 4));
}

/** Unknown prices count as zero; callers that need a cost cap verify pricing first. */
export function priceMicrousd(
  price: AgenticPriceUsage | undefined,
  profile: AgenticProfile,
  usage: { input_tokens: number; output_tokens: number }
): number {
  // `profile` comes from saved state, which is frozen. A host receives data of its own.
  const usd = price?.(structuredClone(profile), usage);
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return 0;
  return Math.ceil(usd * 1_000_000);
}

/** Split a charged total into priced input and output, counting unexplained tokens as input. */
export function chargedUsage(
  usage: AgenticUsage,
  charge: number
): { input_tokens: number; output_tokens: number } {
  if (usage.status !== 'measured') return { input_tokens: charge, output_tokens: 0 };
  return {
    input_tokens: usage.input_tokens + Math.max(0, charge - usage.total_tokens),
    output_tokens: usage.output_tokens,
  };
}

/** A cost cap needs a known price for every profile the plan can call. */
export function assertAgenticPricing(
  resolved: ResolvedAgenticModel,
  price: AgenticPriceUsage | undefined
): void {
  for (const { step, profile } of resolved.steps) {
    const usd = price?.(profile, { input_tokens: 1_000, output_tokens: 1_000 });
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      const model = `${profile.connection.provider}/${profile.connection.model}`;
      throw new AgenticStateError('limit', {
        reason: 'pricing_unknown',
        message: `A cost cap (limits.max_cost_usd or --agent-max-cost) needs model pricing, but Bobsled Core has no price for profile "${profile.name}" (${model}) used by step "${step.id}".`,
        hint: 'Use limits.tokens as the cap for this model instead, or remove the cost cap.',
      });
    }
  }
}
