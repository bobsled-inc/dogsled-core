import { describe, expect, it } from 'vitest';
import { defaultAgenticPriceUsage } from '../../../src/runtime/agentic-host.js';

const profile = (provider: string, model: string) =>
  ({ name: 'review', connection: { provider, model } }) as Parameters<
    typeof defaultAgenticPriceUsage
  >[0];

describe('default agentic pricing', () => {
  it('prices known models from the built-in table', () => {
    const usd = defaultAgenticPriceUsage(profile('openai', 'gpt-4o-mini'), {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(usd).toBeGreaterThan(0);
  });
  it('returns null for unknown models instead of reporting zero cost', () => {
    expect(
      defaultAgenticPriceUsage(profile('openai', 'no-such-model'), {
        input_tokens: 10,
        output_tokens: 10,
      })
    ).toBeNull();
  });
});
