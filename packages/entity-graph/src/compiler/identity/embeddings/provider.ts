import { EnvSecretResolver } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';
import { out } from '@bobsled-inc/model-spec/shared';

import type { SemanticTriageConfig } from '../types.js';

export type SemanticEmbeddingProviderId = string;

export interface SemanticEmbeddingProviderConfig {
  id: SemanticEmbeddingProviderId;
  model: string;
  dimensions: number;
  pricePerMillionTokensUsd: number;
}

export interface SemanticEmbeddingResult {
  vectors: number[][];
  tokensUsed: number;
}

export interface SemanticEmbeddingProvider extends SemanticEmbeddingProviderConfig {
  embed(texts: string[]): Promise<SemanticEmbeddingResult>;
}

export const SEMANTIC_EMBEDDING_PROVIDERS: Record<string, SemanticEmbeddingProviderConfig> = {
  openai_text_embedding_3_small: {
    id: 'openai_text_embedding_3_small',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    pricePerMillionTokensUsd: 0.02,
  },
};

const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_PRICE_PER_MILLION_TOKENS_USD = 0.02;

const OPENAI_EMBEDDINGS_TIMEOUT_MS = 30_000;

interface OpenAiEmbeddingsResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage?: {
    total_tokens?: number;
  };
}

function validateOpenAiEmbeddingsResponse(
  rawPayload: unknown,
  expectedCount: number
): OpenAiEmbeddingsResponse {
  if (typeof rawPayload !== 'object' || rawPayload === null || !('data' in rawPayload)) {
    throw new CommandError(
      `OpenAI embeddings response missing data array: ${JSON.stringify(rawPayload).slice(0, 500)}`,
      1
    );
  }

  const payload = rawPayload as { data: unknown; usage?: { total_tokens?: unknown } };
  if (!Array.isArray(payload.data)) {
    throw new CommandError(
      `OpenAI embeddings response missing data array: ${JSON.stringify(rawPayload).slice(0, 500)}`,
      1
    );
  }

  const data = payload.data.map((item, itemIndex) => {
    if (typeof item !== 'object' || item === null) {
      throw new CommandError(`OpenAI embeddings response item ${itemIndex} is not an object`, 1);
    }
    const candidate = item as { index?: unknown; embedding?: unknown };
    if (typeof candidate.index !== 'number' || !Number.isInteger(candidate.index)) {
      throw new CommandError(`OpenAI embeddings response item ${itemIndex} has invalid index`, 1);
    }
    if (candidate.index < 0 || candidate.index >= expectedCount) {
      throw new CommandError('OpenAI embeddings response contained an invalid index', 1);
    }
    if (
      !Array.isArray(candidate.embedding) ||
      !candidate.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new CommandError(
        `OpenAI embeddings response item ${itemIndex} has invalid embedding vector`,
        1
      );
    }
    const embedding = candidate.embedding as number[];
    return { index: candidate.index, embedding };
  });

  if (data.length !== expectedCount) {
    throw new CommandError(
      `OpenAI embeddings response returned ${data.length} vectors for ${expectedCount} inputs`,
      1
    );
  }

  return {
    data,
    ...(typeof payload.usage?.total_tokens === 'number'
      ? { usage: { total_tokens: payload.usage.total_tokens } }
      : {}),
  };
}

export function estimateEmbeddingTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateEmbeddingCostUsd(
  tokens: number,
  provider: SemanticEmbeddingProviderConfig
): number {
  return (tokens / 1_000_000) * provider.pricePerMillionTokensUsd;
}

export function resolveSemanticEmbeddingProviderConfig(
  triage: Pick<
    SemanticTriageConfig,
    'provider' | 'model' | 'dimensions' | 'pricePerMillionTokensUsd'
  >
): SemanticEmbeddingProviderConfig {
  const known = SEMANTIC_EMBEDDING_PROVIDERS[triage.provider];
  return {
    id: triage.provider,
    model: triage.model ?? known?.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
    dimensions: triage.dimensions ?? known?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    pricePerMillionTokensUsd:
      triage.pricePerMillionTokensUsd ??
      known?.pricePerMillionTokensUsd ??
      DEFAULT_PRICE_PER_MILLION_TOKENS_USD,
  };
}

async function embedWithOpenAi(
  texts: string[],
  model: string,
  apiKey: string,
  fetchFn: typeof fetch
): Promise<SemanticEmbeddingResult> {
  if (texts.length === 0) {
    return { vectors: [], tokensUsed: 0 };
  }

  const response = await fetchFn('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: texts,
      encoding_format: 'float',
    }),
    signal: AbortSignal.timeout(OPENAI_EMBEDDINGS_TIMEOUT_MS),
    redirect: 'error',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CommandError(`OpenAI embeddings request failed (${response.status}): ${body}`, 1);
  }

  const rawPayload = await response.json();
  const payload = validateOpenAiEmbeddingsResponse(rawPayload, texts.length);
  const ordered = new Array<number[]>(texts.length);
  const seen = new Set<number>();

  // validateOpenAiEmbeddingsResponse enforces index bounds and embedding shape; this loop only orders vectors and rejects duplicate indices.
  for (const item of payload.data) {
    if (seen.has(item.index)) {
      throw new CommandError(
        `OpenAI embeddings response contained duplicate index ${item.index}`,
        1
      );
    }
    seen.add(item.index);
    ordered[item.index] = item.embedding;
  }

  const vectors = ordered.map((vector) => {
    if (vector === undefined) {
      throw new CommandError('OpenAI embeddings response omitted one or more vectors', 1);
    }
    return vector;
  });

  return {
    vectors,
    tokensUsed:
      payload.usage?.total_tokens ??
      texts.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0),
  };
}

function stubVector(text: string, dimensions: number): number[] {
  const seed = Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const vector = Array.from({ length: dimensions }, (_, index) => ((seed + index) % 997) / 997);
  // Deterministic, normalized test stub for cosine-similarity comparisons.
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export async function createSemanticEmbeddingProvider(options: {
  triage: Pick<
    SemanticTriageConfig,
    'provider' | 'model' | 'dimensions' | 'pricePerMillionTokensUsd'
  >;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
}): Promise<SemanticEmbeddingProvider> {
  const env = options.env ?? process.env;
  const config = resolveSemanticEmbeddingProviderConfig(options.triage);

  if (env['DOGSLED_EMBED_STUB'] === '1') {
    out.warn(
      'DOGSLED_EMBED_STUB is active — embeddings are synthetic stubs and must not be used in production.'
    );
    return {
      ...config,
      async embed(texts: string[]) {
        return {
          vectors: texts.map((text) => stubVector(text, config.dimensions)),
          tokensUsed: texts.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0),
        };
      },
    };
  }

  const apiKey = await new EnvSecretResolver(env).resolve('OPENAI_API_KEY');

  return {
    ...config,
    embed: (texts: string[]) =>
      embedWithOpenAi(texts, config.model, apiKey, options.fetchFn ?? fetch),
  };
}
