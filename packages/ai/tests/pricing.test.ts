import { describe, expect, it, vi } from 'vitest';

import { estimateCostUsd, UnknownModelPricingError } from '../src/pricing.js';
import type { ModelConnection } from '../src/index.js';

describe('model pricing', () => {
  it('prices OpenAI gpt-5-mini text input and output tokens', () => {
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'gpt-5-mini',
      api_key: '$OPENAI_API_KEY',
    };

    expect(estimateCostUsd(connection, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      2.25
    );
  });

  it('prices the reported Bedrock Claude 3.5 Haiku blocker', () => {
    const connection: ModelConnection = {
      provider: 'amazon-bedrock',
      model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      region: 'us-east-1',
    };

    expect(estimateCostUsd(connection, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      4.8
    );
  });

  it('prices Anthropic models under matching Bedrock and direct API keys', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const bedrock: ModelConnection = {
      provider: 'amazon-bedrock',
      model: 'anthropic.claude-opus-4-1-20250805-v1:0',
      region: 'us-east-1',
    };
    const direct: ModelConnection = {
      provider: 'anthropic',
      model: 'claude-opus-4-1-20250805',
      api_key: '$ANTHROPIC_API_KEY',
    };

    expect(estimateCostUsd(bedrock, usage)).toBe(90);
    expect(estimateCostUsd(direct, usage)).toBe(90);
  });

  it.each([
    ['amazon-bedrock', 'anthropic.claude-3-5-sonnet-20240620-v1:0', 36],
    ['anthropic', 'claude-3-5-sonnet-20240620', 18],
    ['amazon-bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 36],
    ['anthropic', 'claude-3-5-sonnet-20241022', 18],
  ] as const)(
    'prices the %s Claude 3.5 Sonnet key at its provider rate',
    (provider, model, cost) => {
      const connection: ModelConnection =
        provider === 'amazon-bedrock'
          ? { provider, model, region: 'us-east-1' }
          : { provider, model, api_key: '$ANTHROPIC_API_KEY' };

      expect(estimateCostUsd(connection, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
        cost
      );
    }
  );

  it.each([
    ['gpt-4o', 12.5],
    ['gpt-4o-mini', 0.75],
    ['gpt-5', 11.25],
    ['o4-mini', 5.5],
  ])('prices the OpenAI %s chat model', (model, expectedCost) => {
    const connection: ModelConnection = {
      provider: 'openai',
      model,
      api_key: '$OPENAI_API_KEY',
    };

    expect(estimateCostUsd(connection, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      expectedCost
    );
  });

  it('reports zero with a warning for unknown models when no budget is configured', () => {
    const warnings: string[] = [];
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'unknown-paid-model',
      api_key: '$OPENAI_API_KEY',
    };

    expect(
      estimateCostUsd(
        connection,
        { inputTokens: 1 },
        { onWarning: (warning) => warnings.push(warning) }
      )
    ).toBe(0);
    expect(warnings).toEqual([
      expect.stringContaining('cost is unknown and will be reported as $0'),
    ]);
  });

  it('emits a process warning when reporting callers do not provide a warning sink', () => {
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'unknown-paid-model',
      api_key: '$OPENAI_API_KEY',
    };

    expect(estimateCostUsd(connection, { inputTokens: 1 })).toBe(0);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('cost is unknown'), {
      code: 'UNKNOWN_MODEL_PRICING',
    });
    warningSpy.mockRestore();
  });

  it('still fails closed for unknown models when a budget is configured', () => {
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'unknown-paid-model',
      api_key: '$OPENAI_API_KEY',
      cost_budget_usd: 1,
    };

    expect(() => estimateCostUsd(connection, { inputTokens: 1 })).toThrow(UnknownModelPricingError);
  });
});
