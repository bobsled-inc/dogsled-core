import { describe, expect, it } from 'vitest';

import {
  EnvPlaceholderSchema,
  ModelConnectionSchema,
  PlatformConfigSchema,
} from '../../src/config-contracts.js';

describe('metadata configuration contracts', () => {
  it.each(['$OPENAI_API_KEY', '${{ env.OPENAI_API_KEY }}'])(
    'accepts the environment placeholder %s',
    (placeholder) => {
      expect(EnvPlaceholderSchema.safeParse(placeholder).success).toBe(true);
    }
  );

  it('rejects literal API keys for model connections', () => {
    expect(
      ModelConnectionSchema.safeParse({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        api_key: 'raw-secret',
      }).success
    ).toBe(false);
  });

  it('accepts namespaced AI Gateway model IDs and rejects unnamespaced IDs', () => {
    expect(
      ModelConnectionSchema.safeParse({
        provider: 'ai-gateway',
        model: 'zai/glm-flash',
        api_key: '$AI_GATEWAY_API_KEY',
      }).success
    ).toBe(true);
    expect(
      ModelConnectionSchema.safeParse({
        provider: 'ai-gateway',
        model: 'glm-flash',
        api_key: '$AI_GATEWAY_API_KEY',
      }).success
    ).toBe(false);
  });

  it.each([
    ['openai', 'gpt-4.1-mini', 'OPENAI_API_KEY'],
    ['anthropic', 'claude-test', 'ANTHROPIC_API_KEY'],
    ['google', 'gemini-test', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['google', 'gemini-test', 'GOOGLE_API_KEY'],
    ['google', 'gemini-test', 'GEMINI_API_KEY'],
    ['openrouter', 'vendor/model', 'OPENROUTER_API_KEY'],
    ['ai-gateway', 'openai/gpt-5-mini', 'AI_GATEWAY_API_KEY'],
    ['typesafe', 'classifier', 'TYPESAFE_API_KEY'],
    ['amazon-bedrock', 'vendor.model', 'AWS_BEARER_TOKEN_BEDROCK'],
  ])('accepts the standard %s key name %s without a declaration', (provider, model, key) => {
    expect(ModelConnectionSchema.safeParse({ provider, model, api_key: `$${key}` }).success).toBe(
      true
    );
  });

  it('keeps standard key names scoped to their own provider', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      api_key: '$AI_GATEWAY_API_KEY',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Undeclared API key environment variable: AI_GATEWAY_API_KEY. Add AI_GATEWAY_API_KEY to auth_env_vars.'
    );
  });

  it('keeps platform configuration strict', () => {
    expect(PlatformConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
