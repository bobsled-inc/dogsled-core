import { assertExhaustive } from './assert-exhaustive.js';
import type { ModelConnection } from './types.js';

/**
 * AI SDK provider options that ask the model for `connection.dimension`, or `undefined`
 * when it is not set or the model is not known to take it. Checked against the bundled
 * provider packages: OpenRouter's has no dimension option.
 */
export function embeddingDimensionOptions(
  connection: ModelConnection
): Record<string, Record<string, number>> | undefined {
  const { dimension, model, provider } = connection;
  if (dimension === undefined) return undefined;
  switch (provider) {
    case 'openai':
      return model.startsWith('text-embedding-3-')
        ? { openai: { dimensions: dimension } }
        : undefined;
    case 'google':
      return model.startsWith('gemini-embedding-')
        ? { google: { outputDimensionality: dimension } }
        : undefined;
    case 'amazon-bedrock':
      // `includes` also matches cross-region inference profiles, such as `us.` ids.
      if (model.includes('amazon.titan-embed-text-v2')) {
        return { bedrock: { dimensions: dimension } };
      }
      if (model.includes('cohere.embed-v4')) return { bedrock: { outputDimension: dimension } };
      return undefined;
    case 'ollama':
      return { ollama: { dimensions: dimension } };
    case 'anthropic':
    case 'openrouter':
    case 'ai-gateway':
    case 'typesafe':
      return undefined;
    default:
      assertExhaustive(provider);
  }
}
