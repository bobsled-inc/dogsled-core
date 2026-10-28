import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_FAMILIES,
  MODEL_FAMILY_IDS,
  RETIRED_MODEL_IDS,
  DEFAULT_MODEL_FAMILY_ID,
} from '../src/model-families.js';
import { resolveProviderModels } from '../src/providers.js';
import type { ModelConnection } from '../src/index.js';

const openAiEmbedding = vi.fn((model: string) => ({ kind: 'embedding', model }));
const openAiLanguage = vi.fn((model: string) => ({ kind: 'language', model }));

const bedrockEmbedding = vi.fn((model: string) => ({ kind: 'bedrock-embedding', model }));
const bedrockCallable = Object.assign(
  vi.fn((model: string) => ({ kind: 'bedrock-language', model })),
  { embedding: bedrockEmbedding }
);
const createAmazonBedrock = vi.fn(() => bedrockCallable);
const gatewayEmbedding = vi.fn((model: string) => ({ kind: 'gateway-embedding', model }));
const gatewayCallable = Object.assign(
  vi.fn((model: string) => ({ kind: 'gateway-language', model })),
  { embedding: gatewayEmbedding }
);
const createGateway = vi.fn(() => gatewayCallable);

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => Object.assign(openAiLanguage, { embedding: openAiEmbedding })),
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: (options: Record<string, unknown>) => createAmazonBedrock(options),
}));

vi.mock('ai', () => ({
  createGateway: (options: Record<string, unknown>) => createGateway(options),
}));

const anthropicEmbedding = vi.fn(() => {
  throw new Error('No such embeddingModel');
});
const anthropicLanguage = vi.fn((model: string) => ({ kind: 'anthropic-language', model }));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() =>
    Object.assign(anthropicLanguage, {
      textEmbeddingModel: anthropicEmbedding,
    })
  ),
}));

describe('resolveProviderModels', () => {
  it('resolves an Anthropic chat model without invoking its unsupported embedding factory', async () => {
    const models = await resolveProviderModels(
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        api_key: '$ANTHROPIC_API_KEY',
      },
      { ANTHROPIC_API_KEY: 'test-key' }
    );
    expect(models.languageModel).toEqual({
      kind: 'anthropic-language',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(models.languageModel).toBe(models.languageModel);
    expect(anthropicLanguage).toHaveBeenCalledTimes(1);
    expect(anthropicEmbedding).not.toHaveBeenCalled();
  });

  it('still resolves an embedding model without invoking the language factory', async () => {
    bedrockEmbedding.mockClear();
    bedrockCallable.mockClear();
    const models = await resolveProviderModels(
      {
        provider: 'amazon-bedrock',
        model: 'amazon.titan-embed-text-v2:0',
        region: 'us-east-1',
      },
      {}
    );
    expect(models.embeddingModel).toEqual({
      kind: 'bedrock-embedding',
      model: 'amazon.titan-embed-text-v2:0',
    });
    expect(models.embeddingModel).toBe(models.embeddingModel);
    expect(bedrockEmbedding).toHaveBeenCalledTimes(1);
    expect(bedrockCallable).not.toHaveBeenCalled();
  });

  it('treats OpenAI gpt models as language-only', async () => {
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'gpt-5-mini',
      api_key: '$OPENAI_API_KEY',
    };

    const models = await resolveProviderModels(connection, { OPENAI_API_KEY: 'test-key' });

    expect(models).toEqual({ languageModel: { kind: 'language', model: 'gpt-5-mini' } });
    expect(openAiLanguage).toHaveBeenCalledWith('gpt-5-mini');
    expect(openAiEmbedding).not.toHaveBeenCalledWith('gpt-5-mini');
  });

  it('treats OpenAI text-embedding models as embedding-only', async () => {
    const connection: ModelConnection = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key: '$OPENAI_API_KEY',
    };

    const models = await resolveProviderModels(connection, { OPENAI_API_KEY: 'test-key' });

    expect(models).toEqual({
      embeddingModel: { kind: 'embedding', model: 'text-embedding-3-small' },
    });
    expect(openAiEmbedding).toHaveBeenCalledWith('text-embedding-3-small');
    expect(openAiLanguage).not.toHaveBeenCalledWith('text-embedding-3-small');
  });

  const modelCases: Array<[string, string]> = MODEL_FAMILY_IDS.flatMap((familyId) => {
    const family = MODEL_FAMILIES[familyId];
    return [
      [familyId, family.currentVersion],
      [family.currentVersion, family.currentVersion],
      ...family.previousVersions.map(
        (modelId) => [modelId, family.currentVersion] as [string, string]
      ),
    ];
  });
  for (const retiredModelId of RETIRED_MODEL_IDS) {
    modelCases.push([retiredModelId, MODEL_FAMILIES[DEFAULT_MODEL_FAMILY_ID].currentVersion]);
  }
  modelCases.push(['vendor/model-id', 'vendor/model-id']);

  it.each(modelCases)('resolves AI Gateway model %s to %s', async (model, resolvedModel) => {
    gatewayCallable.mockClear();
    createGateway.mockClear();
    const models = await resolveProviderModels(
      { provider: 'ai-gateway', model, api_key: '$AI_GATEWAY_API_KEY' },
      { AI_GATEWAY_API_KEY: 'test-gateway-key' }
    );

    expect(createGateway).toHaveBeenCalledWith({ apiKey: 'test-gateway-key' });
    expect(models.languageModel).toEqual({
      kind: 'gateway-language',
      model: resolvedModel,
    });
  });

  it('passes a resolved Bedrock api_key to createAmazonBedrock when configured', async () => {
    createAmazonBedrock.mockClear();
    const connection: ModelConnection = {
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      api_key: '$AWS_BEARER_TOKEN_BEDROCK',
    };

    await resolveProviderModels(connection, { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer' });

    expect(createAmazonBedrock).toHaveBeenCalledTimes(1);
    const options = createAmazonBedrock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({ region: 'us-east-1', apiKey: 'bedrock-bearer' });
    expect(options.credentialProvider).toBeUndefined();
  });

  it('falls back to the AWS credential chain when no api_key is set on Bedrock', async () => {
    createAmazonBedrock.mockClear();
    const connection: ModelConnection = {
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
    };

    await resolveProviderModels(connection, {});

    expect(createAmazonBedrock).toHaveBeenCalledTimes(1);
    const options = createAmazonBedrock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.region).toBe('us-east-1');
    expect(options.apiKey).toBeUndefined();
    expect(typeof options.credentialProvider).toBe('function');
  });

  it('resolves both $VAR and ${{ env.VAR }} placeholder shapes on Bedrock api_key', async () => {
    createAmazonBedrock.mockClear();
    const connection: ModelConnection = {
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      api_key: '${{ env.AWS_BEARER_TOKEN_BEDROCK }}',
    };

    await resolveProviderModels(connection, { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer' });

    expect(createAmazonBedrock).toHaveBeenCalledTimes(1);
    const options = createAmazonBedrock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({ region: 'us-east-1', apiKey: 'bedrock-bearer' });
    expect(options.credentialProvider).toBeUndefined();
  });
});

describe('provider runtime security boundary', () => {
  it('rejects a hostile Bedrock region before reading secrets or creating a provider', async () => {
    createAmazonBedrock.mockClear();
    const readSecret = vi.fn(() => 'synthetic');
    const env = Object.defineProperty({}, 'AWS_BEARER_TOKEN_BEDROCK', { get: readSecret });
    await expect(
      resolveProviderModels(
        {
          provider: 'amazon-bedrock',
          model: 'test',
          region: 'evil.example#',
          api_key: '$AWS_BEARER_TOKEN_BEDROCK',
        },
        env
      )
    ).rejects.toThrow('Invalid Bedrock region');
    expect(readSecret).not.toHaveBeenCalled();
    expect(createAmazonBedrock).not.toHaveBeenCalled();
  });
  it.each(['$UNRELATED_SECRET', '${{ env.UNRELATED_SECRET }}'])(
    'rejects undeclared key %s before reading its value',
    async (api_key) => {
      const readSecret = vi.fn(() => 'must-not-appear');
      const env = Object.defineProperty({}, 'UNRELATED_SECRET', { get: readSecret });
      await expect(
        resolveProviderModels({ provider: 'openai', model: 'gpt-5-mini', api_key }, env)
      ).rejects.toThrow(
        'Undeclared API key environment variable: UNRELATED_SECRET. Add UNRELATED_SECRET to auth_env_vars.'
      );
      expect(readSecret).not.toHaveBeenCalled();
    }
  );
  it('resolves declared custom keys from an explicit environment map', async () => {
    const result = await resolveProviderModels(
      {
        provider: 'openai',
        model: 'gpt-5-mini',
        api_key: '$CUSTOM_AI_KEY',
        auth_env_vars: ['CUSTOM_AI_KEY'],
      },
      { CUSTOM_AI_KEY: 'synthetic' }
    );
    expect(result.languageModel).toEqual({ kind: 'language', model: 'gpt-5-mini' });
  });
  it('rejects insecure remote Ollama URLs before importing the provider', async () => {
    await expect(
      resolveProviderModels(
        { provider: 'ollama', model: 'test', base_url: 'http://remote.example/api' },
        {}
      )
    ).rejects.toThrow('Ollama base_url must use HTTPS or HTTP on loopback');
  });
});
