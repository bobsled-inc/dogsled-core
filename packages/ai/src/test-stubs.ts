import type {
  EmbedResult,
  GenerateStructuredResult,
  DeltaEvent,
  BudgetLedger,
  BudgetUsage,
} from './types.js';

/**
 * Typed test factories for `@bobsled-inc/ai`.
 *
 * Discriminated-union returns are easy to bypass with raw `vi.mock(...)`.
 * Use these factories so type checks catch missing branches.
 */

export function mockStructuredOk<T>(value: T, costUsd = 0.0001): GenerateStructuredResult<T> {
  return { ok: true, value, tokenUsage: 100, costUsd };
}

export function mockStructuredSchemaViolation<T>(
  raw = '',
  attempts = 1
): GenerateStructuredResult<T> {
  return {
    ok: false,
    error: 'schema_violation',
    raw,
    message: 'LLM output failed schema validation',
    attempts,
  };
}

export function mockStructuredProviderError<T>(
  message = 'provider unavailable',
  attempts = 1
): GenerateStructuredResult<T> {
  return { ok: false, error: 'provider_error', message, attempts };
}

export function mockStructuredBudgetExceeded<T>(
  message = 'call budget exceeded'
): GenerateStructuredResult<T> {
  return { ok: false, error: 'budget_exceeded', message, attempts: 0 };
}

export function mockEmbedSuccess(id: string, vector: number[], costUsd = 0.0001): EmbedResult {
  return { ok: true, id, vector, tokenUsage: vector.length, costUsd };
}

export function mockEmbedError(
  id: string,
  error: 'budget_exceeded' | 'provider_error',
  message = 'embed failed',
  retriable = false
): EmbedResult {
  return { ok: false, id, error, message, retriable };
}

export function mockStreamDelta(text: string): DeltaEvent {
  return { type: 'delta', text };
}

export function mockStreamError(
  error: 'budget_exceeded' | 'provider_error',
  message = 'stream failed'
): DeltaEvent {
  return { type: 'error', error, message };
}

export async function* mockStream(events: DeltaEvent[]): AsyncIterable<DeltaEvent> {
  for (const event of events) {
    yield event;
  }
}

/** In-memory budget ledger that always reserves successfully — for tests. */
export class AlwaysOkBudgetLedger implements BudgetLedger {
  private usage: Record<string, Record<string, number>> = {};

  async tryReserveCost(projectKey: string, date: string, costUsd: number, _dailyBudgetUsd: number) {
    this.usage[projectKey] ??= {};
    this.usage[projectKey][date] = (this.usage[projectKey][date] ?? 0) + costUsd;
    const usage: BudgetUsage = { date, costUsd: this.usage[projectKey][date] ?? 0 };
    return { ok: true as const, usage };
  }

  async releaseReservedCost(projectKey: string, date: string, releaseUsd: number) {
    this.usage[projectKey] ??= {};
    this.usage[projectKey][date] = Math.max(0, (this.usage[projectKey][date] ?? 0) - releaseUsd);
    return { date, costUsd: this.usage[projectKey][date] ?? 0 };
  }

  async settleReservedCost(
    projectKey: string,
    date: string,
    reservedUsd: number,
    actualUsd: number
  ) {
    this.usage[projectKey] ??= {};
    const delta = actualUsd - reservedUsd;
    this.usage[projectKey][date] = Math.max(0, (this.usage[projectKey][date] ?? 0) + delta);
    return { date, costUsd: this.usage[projectKey][date] ?? 0 };
  }
}

/** Budget ledger that fails reservation — for testing budget-exceeded paths. */
export class AlwaysExceededBudgetLedger implements BudgetLedger {
  async tryReserveCost(_projectKey: string, date: string, _costUsd: number, _budget: number) {
    return { ok: false as const, usage: { date, costUsd: 0 } };
  }
  async releaseReservedCost(_projectKey: string, date: string, _r: number) {
    return { date, costUsd: 0 };
  }
  async settleReservedCost(_p: string, date: string, _r: number, _a: number) {
    return { date, costUsd: 0 };
  }
}
