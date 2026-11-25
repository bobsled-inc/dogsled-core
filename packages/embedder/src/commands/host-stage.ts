import { connectHostEmbedding, type HostEmbeddingOptions } from '@bobsled-inc/ai';
import { CommandError, EXIT_VALIDATION, requireHostEmbeddingEnv } from '@bobsled-inc/protocol';

import type { HostEmbedConfig } from '../config.js';
import type { RunEmbedderOptions } from '../runtime/processor.js';

/** The part of an embedding run that depends on where the model comes from. */
export type EmbedStage = Pick<
  RunEmbedderOptions,
  'dimensions' | 'batchSize' | 'hostText' | 'embedFn'
> & { provider: string; model: string };

/** Zero vectors, for runs that only check the wiring. */
export function stubStage(provider: string, model: string, dimensions: number): EmbedStage {
  return {
    provider,
    model,
    dimensions,
    batchSize: 100,
    embedFn: async (texts) => ({
      vectors: texts.map(() => Array.from({ length: dimensions }, () => 0)),
      tokensUsed: 0,
    }),
  };
}

/**
 * Ask the host application for its model before any SCHEMA is written and before any text
 * is sent. The vector column takes its length from the answer.
 */
export async function prepareHostStage(
  config: HostEmbedConfig,
  env: Record<string, string | undefined>,
  options: Omit<HostEmbeddingOptions, 'url' | 'token'> = {}
): Promise<EmbedStage> {
  if (env['DOGSLED_EMBED_STUB'] === '1') {
    if (config.dimension === undefined) {
      throw new CommandError(
        'DOGSLED_EMBED_STUB=1 with embedding provider "host" needs a dimension in the embed ' +
          'config, because the host is not asked for it.',
        EXIT_VALIDATION
      );
    }
    return { ...stubStage('host', 'stub', config.dimension), hostText: {} };
  }

  const connection = await connectHostEmbedding({ ...options, ...requireHostEmbeddingEnv(env) });
  const { model, limits } = connection;
  if (config.dimension !== undefined && config.dimension !== model.dimensions) {
    throw new CommandError(
      `The embed config sets dimension ${config.dimension}, but the host's embedding model has ` +
        `${model.dimensions}.`,
      EXIT_VALIDATION
    );
  }

  // A record's texts stay together, so a flush must hold at least one record.
  const textsPerRecord = Math.max(...Object.values(config.streams).map((fields) => fields.length));
  return {
    provider: model.provider,
    model: model.id,
    dimensions: model.dimensions,
    batchSize: Math.max(connection.textsInFlight, textsPerRecord),
    hostText: { maxCharacters: limits.maxInputCharacters },
    embedFn: async (texts) => {
      const { requests, ...result } = await connection.embed(texts);
      return { ...result, apiCalls: requests };
    },
  };
}
