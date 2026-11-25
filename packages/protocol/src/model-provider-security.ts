import { z } from 'zod';

import { parseEnvPlaceholder } from './env-placeholders.js';
import { AuthEnvVarsSchema } from './declared-environment.js';
import { HOST_EMBEDDING_ENV_RESERVED_MESSAGE, isHostEmbeddingEnvName } from './host-embedding.js';

export class ModelProviderConfigError extends Error {
  constructor(
    readonly field: 'region' | 'base_url' | 'api_key',
    message: string
  ) {
    super(message);
  }
}

export const BedrockRegionSchema = z
  .string()
  .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Invalid Bedrock region');
export const ModelAuthEnvVarsSchema = AuthEnvVarsSchema;
export const OllamaBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  }, 'Ollama base_url must use HTTPS or HTTP on loopback');

const STANDARD_API_KEY_NAMES: Record<string, readonly string[]> = {
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'ai-gateway': ['AI_GATEWAY_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
};

export function validateModelProviderConfig(config: {
  provider: string;
  region?: string;
  base_url?: string;
  api_key?: string;
  auth_env_vars?: string[];
}): void {
  if (
    config.provider === 'amazon-bedrock' &&
    !BedrockRegionSchema.safeParse(config.region ?? 'us-east-1').success
  ) {
    throw new ModelProviderConfigError('region', 'Invalid Bedrock region');
  }
  if (config.provider === 'ollama') {
    if (!OllamaBaseUrlSchema.safeParse(config.base_url ?? 'http://127.0.0.1:11434/api').success) {
      throw new ModelProviderConfigError(
        'base_url',
        'Ollama base_url must use HTTPS or HTTP on loopback'
      );
    }
  }
  const key = config.api_key === undefined ? null : parseEnvPlaceholder(config.api_key);
  if (key !== null && isHostEmbeddingEnvName(key)) {
    throw new ModelProviderConfigError('api_key', `${HOST_EMBEDDING_ENV_RESERVED_MESSAGE}.`);
  }
  if (
    key !== null &&
    !(STANDARD_API_KEY_NAMES[config.provider] ?? []).includes(key) &&
    !config.auth_env_vars?.includes(key)
  ) {
    throw new ModelProviderConfigError(
      'api_key',
      `Undeclared API key environment variable: ${key}. Add ${key} to auth_env_vars.`
    );
  }
}
