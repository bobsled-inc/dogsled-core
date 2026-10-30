import type { z } from 'zod';

import type { ModelConnection, PlatformConfig } from '@bobsled-inc/connections';

export type { ModelConnection, PlatformConfig };

export interface EmbedInput {
  id: string;
  text: string;
}

export type EmbedResult =
  | {
      ok: true;
      id: string;
      vector: number[];
      tokenUsage: number;
      costUsd: number;
    }
  | {
      ok: false;
      id: string;
      error: 'budget_exceeded' | 'provider_error';
      message: string;
      retriable: boolean;
    };

export interface GenerateStructuredOptions<T> {
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  costBudgetUsd?: number;
  /**
   * Sampling temperature forwarded to the provider. Deterministic pipelines
   * (e.g. entity-graph agent review) pin this to 0.
   */
  temperature?: number;
  /** Cancel the provider request. */
  abortSignal?: AbortSignal;
  /** Maximum output tokens for this call. Must be a positive safe integer. */
  maxOutputTokens?: number;
  /** SDK retries. Set to zero when the caller owns retry accounting. */
  maxRetries?: number;
}

/** Validated provider counts. Absence means usage is unknown. */
export interface StructuredTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type GenerateStructuredResult<T> =
  | {
      ok: true;
      value: T;
      usage?: StructuredTokenUsage;
      tokenUsage: number;
      costUsd: number;
      warnings?: string[];
    }
  | {
      ok: false;
      error: 'schema_violation' | 'budget_exceeded' | 'provider_error';
      raw?: string;
      message: string;
      attempts: number;
      usage?: StructuredTokenUsage;
      /** HTTP status from the provider when known, such as 401 or 429. */
      status?: number;
    };

export type DeltaEvent =
  | {
      type: 'delta';
      text: string;
    }
  | {
      type: 'error';
      error: 'budget_exceeded' | 'provider_error';
      message: string;
    };

export interface BudgetUsage {
  date: string;
  costUsd: number;
}

export interface BudgetLedger {
  tryReserveCost(
    projectKey: string,
    date: string,
    costUsd: number,
    dailyBudgetUsd: number
  ): Promise<{ ok: true; usage: BudgetUsage } | { ok: false; usage: BudgetUsage }>;
  releaseReservedCost(projectKey: string, date: string, releaseUsd: number): Promise<BudgetUsage>;
  settleReservedCost(
    projectKey: string,
    date: string,
    reservedUsd: number,
    actualUsd: number
  ): Promise<BudgetUsage>;
}
