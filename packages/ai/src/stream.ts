import { streamText } from 'ai';

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
} from './pricing.js';
import { resolveProviderModels } from './providers.js';
import type { BudgetLedger, DeltaEvent, ModelConnection, PlatformConfig } from './types.js';

type SdkStreamModel = Parameters<typeof streamText>[0]['model'];

export interface GenerateStreamOptions {
  prompt: string;
  system?: string;
  env?: Record<string, string | undefined>;
  modelOverride?: unknown;
  platform?: PlatformConfig;
  projectKey?: string;
  costBudgetUsd?: number;
  ledger?: BudgetLedger;
}

export async function* generateStream(
  connection: ModelConnection,
  opts: GenerateStreamOptions
): AsyncIterable<DeltaEvent> {
  let result: ReturnType<typeof streamText> | undefined;
  let reservation: Awaited<ReturnType<typeof reserveBudget>> | undefined;
  try {
    const providerModels = opts.modelOverride
      ? { languageModel: opts.modelOverride }
      : await resolveProviderModels(connection, opts.env);
    if (!providerModels.languageModel) {
      yield {
        type: 'error',
        error: 'provider_error',
        message: `Provider "${connection.provider}" does not expose a language model factory`,
      };
      return;
    }

    const estimatedCostUsd = estimateCostUsd(
      connection,
      estimatePreflightUsage(opts.prompt, opts.system),
      {
        requireKnownPricing: hasCostBudget(connection, opts.platform, opts.costBudgetUsd),
      }
    );
    reservation = await reserveBudget({
      connection,
      platform: opts.platform,
      projectKey: opts.projectKey,
      callBudgetUsd: opts.costBudgetUsd,
      estimatedCostUsd,
      ledger: opts.ledger,
    });

    result = streamText({
      model: providerModels.languageModel as SdkStreamModel,
      prompt: opts.prompt,
      system: opts.system,
    });
    for await (const text of result.textStream) {
      yield { type: 'delta', text };
    }
    const usage = extractTokenUsage(await result.usage);
    const settled = reservation;
    reservation = undefined;
    await finalizeBudgetReservation(
      settled,
      estimateCostUsd(connection, usage, { requireKnownPricing: false })
    );
  } catch (error) {
    yield {
      type: 'error',
      error: isBudgetError(error) ? 'budget_exceeded' : 'provider_error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (reservation && result) {
      // Usage may never resolve after an interrupted stream. Give an available report
      // one event-loop turn, then keep the estimate rather than refunding unknown work.
      const reported = await Promise.race([
        Promise.resolve(result.usage).catch(() => undefined),
        new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
      ]);
      if (
        reported &&
        typeof reported.inputTokens === 'number' &&
        Number.isFinite(reported.inputTokens) &&
        reported.inputTokens >= 0 &&
        typeof reported.outputTokens === 'number' &&
        Number.isFinite(reported.outputTokens) &&
        reported.outputTokens >= 0
      ) {
        await settleFailedBudgetReservation(
          reservation,
          estimateCostUsd(connection, extractTokenUsage(reported), { requireKnownPricing: false })
        );
      }
    } else {
      await settleFailedBudgetReservation(reservation);
    }
  }
}
