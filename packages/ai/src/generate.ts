import { generateObject } from 'ai';

import { finalizeBudgetReservation, isBudgetError, reserveBudget } from './budget.js';
import {
  estimateCostUsd,
  estimatePreflightUsage,
  extractTokenUsage,
  hasCostBudget,
} from './pricing.js';
import { resolveProviderModels } from './providers.js';
import type {
  BudgetLedger,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  ModelConnection,
  PlatformConfig,
  StructuredTokenUsage,
} from './types.js';

type SdkGenerateModel = Parameters<typeof generateObject>[0]['model'];

export interface GenerateOptions {
  env?: Record<string, string | undefined>;
  platform?: PlatformConfig;
  projectKey?: string;
  ledger?: BudgetLedger;
  modelOverride?: unknown;
  /** Observe cost without enforcing cost ceilings when the caller owns run budgets. */
  costBudgetMode?: 'enforce' | 'observe';
}

function rawTextFromError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  return typeof record['text'] === 'string' ? record['text'] : undefined;
}

function isSchemaViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.includes('NoObjectGenerated');
}

function measuredUsage(value: unknown): StructuredTokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = record['inputTokens'] ?? record['promptTokens'];
  const outputTokens = record['outputTokens'] ?? record['completionTokens'];
  if (!validCount(inputTokens) || !validCount(outputTokens)) return undefined;
  const totalTokens = record['totalTokens'] ?? inputTokens + outputTokens;
  if (!validCount(totalTokens) || totalTokens !== inputTokens + outputTokens) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function errorUsage(error: unknown): StructuredTokenUsage | undefined {
  return typeof error === 'object' && error !== null
    ? measuredUsage((error as Record<string, unknown>)['usage'])
    : undefined;
}

export async function generateStructured<T>(
  connection: ModelConnection,
  opts: GenerateStructuredOptions<T>,
  runOptions: GenerateOptions = {}
): Promise<GenerateStructuredResult<T>> {
  let reportedUsage: StructuredTokenUsage | undefined;
  try {
    if (
      opts.maxOutputTokens !== undefined &&
      (!validCount(opts.maxOutputTokens) || opts.maxOutputTokens === 0)
    ) {
      throw new Error('maxOutputTokens must be a positive safe integer');
    }
    if (opts.maxRetries !== undefined && !validCount(opts.maxRetries)) {
      throw new Error('maxRetries must be a non-negative safe integer');
    }
    opts.abortSignal?.throwIfAborted();
    const observeCost = runOptions.costBudgetMode === 'observe';
    const warnings = new Set<string>();
    const onWarning = (warning: string): void => {
      warnings.add(warning);
    };
    const providerModels = runOptions.modelOverride
      ? { languageModel: runOptions.modelOverride }
      : await resolveProviderModels(connection, runOptions.env);
    if (!providerModels.languageModel) {
      return {
        ok: false,
        error: 'provider_error',
        message: `Provider "${connection.provider}" does not expose a language model factory`,
        attempts: 1,
      };
    }

    const estimatedCostUsd = estimateCostUsd(
      connection,
      estimatePreflightUsage(opts.prompt, opts.system, opts.maxOutputTokens),
      {
        requireKnownPricing:
          !observeCost && hasCostBudget(connection, runOptions.platform, opts.costBudgetUsd),
        onWarning,
      }
    );
    const reservation = observeCost
      ? undefined
      : await reserveBudget({
          connection,
          platform: runOptions.platform,
          projectKey: runOptions.projectKey,
          callBudgetUsd: opts.costBudgetUsd,
          estimatedCostUsd,
          ledger: runOptions.ledger,
        });

    const result = await generateObject({
      model: providerModels.languageModel as SdkGenerateModel,
      schema: opts.schema,
      prompt: opts.prompt,
      system: opts.system,
      ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    reportedUsage = measuredUsage(result.usage);
    const usage = extractTokenUsage(result.usage);
    const costUsd = estimateCostUsd(connection, usage, {
      requireKnownPricing: false,
      onWarning,
    });
    if (reservation) await finalizeBudgetReservation(reservation, costUsd);

    return {
      ok: true,
      value: result.object,
      ...(reportedUsage ? { usage: reportedUsage } : {}),
      tokenUsage: usage.totalTokens,
      costUsd,
      ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
    };
  } catch (error) {
    reportedUsage ??= errorUsage(error);
    const message = error instanceof Error ? error.message : String(error);
    if (isSchemaViolation(error)) {
      return {
        ok: false,
        error: 'schema_violation',
        raw: rawTextFromError(error),
        ...(reportedUsage ? { usage: reportedUsage } : {}),
        message,
        attempts: 1,
      };
    }
    return {
      ok: false,
      ...(reportedUsage ? { usage: reportedUsage } : {}),
      error: isBudgetError(error) ? 'budget_exceeded' : 'provider_error',
      message,
      attempts: 1,
    };
  }
}
