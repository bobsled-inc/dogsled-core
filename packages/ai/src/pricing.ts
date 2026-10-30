import type { ModelConnection, PlatformConfig } from './types.js';

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface Pricing {
  inputPerMillion: number;
  outputPerMillion?: number;
}

// Estimates use current on-demand list-price tiers. Provider modifiers such as
// prompt caching, batch discounts, and regional routing premiums are not modeled.
const MODEL_PRICING = new Map<string, Pricing>([
  ['amazon-bedrock:amazon.titan-embed-text-v2:0', { inputPerMillion: 0.02 }],
  ['amazon-bedrock:cohere.embed-english-v3', { inputPerMillion: 0.1 }],
  // Anthropic chat models use two keys: direct API IDs omit `anthropic.` and the
  // Bedrock revision suffix, while Bedrock keys preserve the full model ID verbatim.
  [
    'amazon-bedrock:anthropic.claude-3-haiku-20240307-v1:0',
    {
      inputPerMillion: 0.25,
      outputPerMillion: 1.25,
    },
  ],
  ['anthropic:claude-3-haiku-20240307', { inputPerMillion: 0.25, outputPerMillion: 1.25 }],
  [
    'amazon-bedrock:anthropic.claude-3-5-haiku-20241022-v1:0',
    {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
    },
  ],
  ['anthropic:claude-3-5-haiku-20241022', { inputPerMillion: 0.8, outputPerMillion: 4 }],
  [
    'amazon-bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0',
    {
      inputPerMillion: 6,
      outputPerMillion: 30,
    },
  ],
  // Direct API keys retain Anthropic's final $3/$15 list price. Bedrock's exact
  // keys use its $6/$30 public extended-access on-demand tier (effective Dec 2025).
  ['anthropic:claude-3-5-sonnet-20240620', { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    'amazon-bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0',
    {
      inputPerMillion: 6,
      outputPerMillion: 30,
    },
  ],
  ['anthropic:claude-3-5-sonnet-20241022', { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    'amazon-bedrock:anthropic.claude-3-7-sonnet-20250219-v1:0',
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
  ],
  ['anthropic:claude-3-7-sonnet-20250219', { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    'amazon-bedrock:anthropic.claude-haiku-4-5-20251001-v1:0',
    {
      inputPerMillion: 1,
      outputPerMillion: 5,
    },
  ],
  ['anthropic:claude-haiku-4-5-20251001', { inputPerMillion: 1, outputPerMillion: 5 }],
  [
    'amazon-bedrock:anthropic.claude-sonnet-4-5-20250929-v1:0',
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
  ],
  ['anthropic:claude-sonnet-4-5-20250929', { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    'amazon-bedrock:anthropic.claude-opus-4-1-20250805-v1:0',
    {
      inputPerMillion: 15,
      outputPerMillion: 75,
    },
  ],
  ['anthropic:claude-opus-4-1-20250805', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['openai:gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ['openai:gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['openai:gpt-5', { inputPerMillion: 1.25, outputPerMillion: 10 }],
  ['openai:gpt-5-mini', { inputPerMillion: 0.25, outputPerMillion: 2.0 }],
  ['openai:o4-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['openai:text-embedding-3-small', { inputPerMillion: 0.02 }],
  ['openai:text-embedding-3-large', { inputPerMillion: 0.13 }],
  ['openrouter:moonshotai/kimi-k2', { inputPerMillion: 0.27, outputPerMillion: 0.55 }],
]);

export interface CostEstimationOptions {
  /** Require a registered price because a cost ceiling must be enforced. */
  requireKnownPricing?: boolean;
  /** Receives the reporting-only degradation warning for an unregistered model. */
  onWarning?: (message: string) => void;
}

export class UnknownModelPricingError extends Error {
  constructor(connection: ModelConnection) {
    super(`No pricing registered for ${connection.provider}:${connection.model}`);
    this.name = 'UnknownModelPricingError';
  }
}

/**
 * The AI Gateway passes calls through at the provider's list price, so a gateway
 * model named `openai/gpt-4o-mini` uses the `openai:gpt-4o-mini` entry.
 */
function lookupPricing(connection: ModelConnection) {
  const direct = MODEL_PRICING.get(`${connection.provider}:${connection.model}`);
  if (direct || connection.provider !== 'ai-gateway') return direct;
  const slash = connection.model.indexOf('/');
  if (slash <= 0) return undefined;
  return MODEL_PRICING.get(
    `${connection.model.slice(0, slash)}:${connection.model.slice(slash + 1)}`
  );
}

export function estimateCostUsd(
  connection: ModelConnection,
  usage: TokenUsage,
  options: CostEstimationOptions = {}
): number {
  if (connection.provider === 'ollama') {
    return 0;
  }

  const pricing = lookupPricing(connection);
  if (!pricing) {
    const error = new UnknownModelPricingError(connection);
    const requireKnownPricing =
      options.requireKnownPricing ?? connection.cost_budget_usd !== undefined;
    if (requireKnownPricing) {
      throw error;
    }
    const warning = `${error.message}; cost is unknown and will be reported as $0 because no AI cost budget is configured`;
    if (options.onWarning) {
      options.onWarning(warning);
    } else {
      process.emitWarning(warning, { code: 'UNKNOWN_MODEL_PRICING' });
    }
    return 0;
  }

  const inputTokens = usage.inputTokens ?? usage.totalTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * (pricing.outputPerMillion ?? 0);
  return inputCost + outputCost;
}

export function hasCostBudget(
  connection: ModelConnection,
  platform?: PlatformConfig,
  callBudgetUsd?: number
): boolean {
  return (
    callBudgetUsd !== undefined ||
    connection.cost_budget_usd !== undefined ||
    platform?.budget?.ai_cost_daily_usd !== undefined
  );
}

export function estimatePreflightUsage(
  prompt: string,
  system?: string,
  outputTokenBudget = 4096
): Required<TokenUsage> {
  const inputChars = prompt.length + (system?.length ?? 0);
  const inputTokens = Math.max(Math.ceil(inputChars / 4), 1);
  return {
    inputTokens,
    outputTokens: outputTokenBudget,
    totalTokens: inputTokens + outputTokenBudget,
  };
}

export function extractTokenUsage(usage: unknown): Required<TokenUsage> {
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const record = usage as Record<string, unknown>;
  const explicitInputTokens =
    numberValue(record['inputTokens']) ??
    numberValue(record['promptTokens']) ??
    numberValue(record['tokens']);
  const outputTokens =
    numberValue(record['outputTokens']) ?? numberValue(record['completionTokens']) ?? 0;
  const totalTokens =
    numberValue(record['totalTokens']) ?? (explicitInputTokens ?? 0) + outputTokens;
  const inputTokens = explicitInputTokens ?? Math.max(totalTokens - outputTokens, 0);
  return { inputTokens, outputTokens, totalTokens };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Price usage with the built-in table. Returns null, never $0, for an unknown model. */
export function knownModelCostUsd(connection: ModelConnection, usage: TokenUsage): number | null {
  try {
    return estimateCostUsd(connection, usage, { requireKnownPricing: true });
  } catch (error) {
    if (error instanceof UnknownModelPricingError) return null;
    throw error;
  }
}
