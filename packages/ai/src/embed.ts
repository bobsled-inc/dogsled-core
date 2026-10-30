import { embedMany as sdkEmbedMany } from 'ai';

import {
  finalizeBudgetReservation,
  isBudgetError,
  reserveBudget,
  settleFailedBudgetReservation,
} from './budget.js';
import {
  estimateCostUsd,
  estimatePreflightUsage,
  extractTokenUsage,
  hasCostBudget,
  UnknownModelPricingError,
} from './pricing.js';
import { resolveProviderModels } from './providers.js';
import type {
  BudgetLedger,
  EmbedInput,
  EmbedResult,
  ModelConnection,
  PlatformConfig,
} from './types.js';

type SdkEmbedModel = Parameters<typeof sdkEmbedMany>[0]['model'];

export interface EmbedManyOptions {
  chunkSize?: number;
  env?: Record<string, string | undefined>;
  platform?: PlatformConfig;
  projectKey?: string;
  costBudgetUsd?: number;
  ledger?: BudgetLedger;
  modelOverride?: unknown;
}

export async function* embedMany(
  connection: ModelConnection,
  inputs: readonly EmbedInput[],
  options: EmbedManyOptions = {}
): AsyncIterable<EmbedResult> {
  if (inputs.length === 0) {
    return;
  }

  const providerModels = options.modelOverride
    ? { embeddingModel: options.modelOverride }
    : await resolveProviderModels(connection, options.env);
  if (!providerModels.embeddingModel) {
    for (const input of inputs) {
      yield {
        ok: false,
        id: input.id,
        error: 'provider_error',
        message: `Provider "${connection.provider}" does not expose an embedding model factory`,
        retriable: false,
      };
    }
    return;
  }

  const chunkSize = options.chunkSize ?? 96;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(
      `embedMany chunkSize must be a positive integer. Received: ${String(chunkSize)}`
    );
  }
  for (let index = 0; index < inputs.length; index += chunkSize) {
    const batch = inputs.slice(index, index + chunkSize);
    try {
      const estimatedCostUsd = estimateCostUsd(
        connection,
        estimatePreflightUsage(batch.map((input) => input.text).join('\n'), undefined, 0),
        {
          requireKnownPricing: hasCostBudget(connection, options.platform, options.costBudgetUsd),
        }
      );
      const reservation = await reserveBudget({
        connection,
        platform: options.platform,
        projectKey: options.projectKey,
        callBudgetUsd: options.costBudgetUsd,
        estimatedCostUsd,
        ledger: options.ledger,
      });

      let result: Awaited<ReturnType<typeof sdkEmbedMany>>;
      try {
        result = await sdkEmbedMany({
          model: providerModels.embeddingModel as SdkEmbedModel,
          values: batch.map((input) => input.text),
          maxRetries: 2,
        });
      } catch (error) {
        await settleFailedBudgetReservation(reservation);
        throw error;
      }
      const usage = extractTokenUsage(result.usage);
      const costUsd = estimateCostUsd(connection, usage, { requireKnownPricing: false });
      await finalizeBudgetReservation(reservation, costUsd);

      const perInputTokenUsage = usage.totalTokens / batch.length;
      const perInputCostUsd = costUsd / batch.length;
      for (const [batchIndex, input] of batch.entries()) {
        const vector = result.embeddings[batchIndex];
        if (!vector) {
          yield {
            ok: false,
            id: input.id,
            error: 'provider_error',
            message: 'Embedding provider omitted a vector for one input',
            retriable: true,
          };
          continue;
        }
        yield {
          ok: true,
          id: input.id,
          vector,
          tokenUsage: perInputTokenUsage,
          costUsd: perInputCostUsd,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetriable = !isBudgetError(error) && !(error instanceof UnknownModelPricingError);
      for (const input of batch) {
        yield {
          ok: false,
          id: input.id,
          error: isBudgetError(error) ? 'budget_exceeded' : 'provider_error',
          message,
          retriable: isRetriable,
        };
      }
    }
  }
}
