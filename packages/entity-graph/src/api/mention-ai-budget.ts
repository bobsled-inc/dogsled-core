import type { LlmCall } from '../runtime/mention/extract.js';
import type { SurfaceProposalCall } from '../runtime/mention/surface-proposer.js';
import type { PerSourceRateLimiter } from '../runtime/mention/budget.js';

interface BudgetedAiCallOptions {
  rateLimiter: Pick<PerSourceRateLimiter, 'consume'>;
  sourceHandle: string;
  markBudgetExhausted: () => void;
  addBudgetUsed: (amount: number) => void;
}

export function wrapMentionLlmCall(llmCall: LlmCall, options: BudgetedAiCallOptions): LlmCall {
  return async (prompt) => {
    options.rateLimiter.consume(options.sourceHandle);
    const result = await llmCall(prompt);
    if (result.ok) {
      options.addBudgetUsed(result.costUsd);
    } else if (result.error === 'budget_exceeded') {
      options.markBudgetExhausted();
    }
    return result;
  };
}

export function wrapSurfaceProposer(
  surfaceProposer: SurfaceProposalCall,
  options: BudgetedAiCallOptions
): SurfaceProposalCall {
  return async (input) => {
    options.rateLimiter.consume(options.sourceHandle);
    const result = await surfaceProposer(input);
    if (result.ok) {
      options.addBudgetUsed(result.costUsd);
    } else if (result.error === 'budget_exceeded') {
      options.markBudgetExhausted();
    }
    return result;
  };
}
