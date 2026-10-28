import { CommandError, EXIT_ERROR, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import type { BudgetLedger, BudgetUsage, ModelConnection, PlatformConfig } from './types.js';

export class CallBudgetExceeded extends CommandError {
  constructor(costUsd: number, budgetUsd: number) {
    super(
      `AI call cost $${costUsd.toFixed(6)} exceeds per-call budget $${budgetUsd.toFixed(6)}`,
      EXIT_ERROR
    );
    this.name = 'CallBudgetExceeded';
  }
}

export class DailyBudgetExceeded extends CommandError {
  constructor(costUsd: number, usedUsd: number, budgetUsd: number) {
    super(
      `AI daily cost would reach $${(usedUsd + costUsd).toFixed(6)}, exceeding budget $${budgetUsd.toFixed(6)}`,
      EXIT_ERROR
    );
    this.name = 'DailyBudgetExceeded';
  }
}

export class InvalidBudgetCost extends CommandError {
  constructor(label: string, costUsd: number) {
    super(
      `AI budget ${label} must be a finite non-negative number. Received: ${String(costUsd)}`,
      EXIT_VALIDATION
    );
    this.name = 'InvalidBudgetCost';
  }
}

export class MissingProjectKey extends CommandError {
  constructor() {
    super('AI daily budget enforcement requires a non-empty project key', EXIT_VALIDATION);
    this.name = 'MissingProjectKey';
  }
}

export class MemoryBudgetLedger implements BudgetLedger {
  private readonly usage = new Map<string, BudgetUsage>();

  async tryReserveCost(
    projectKey: string,
    date: string,
    costUsd: number,
    dailyBudgetUsd: number
  ): Promise<{ ok: true; usage: BudgetUsage } | { ok: false; usage: BudgetUsage }> {
    validateCostUsd('costUsd', costUsd);
    validateCostUsd('dailyBudgetUsd', dailyBudgetUsd);
    const key = `${projectKey}:${date}`;
    const current = this.usage.get(key) ?? { date, costUsd: 0 };
    const nextCostUsd = current.costUsd + costUsd;
    if (nextCostUsd > dailyBudgetUsd) {
      return { ok: false, usage: current };
    }
    const usage = { date, costUsd: Math.max(nextCostUsd, 0) };
    this.usage.set(key, usage);
    return { ok: true, usage };
  }

  async releaseReservedCost(
    projectKey: string,
    date: string,
    releaseUsd: number
  ): Promise<BudgetUsage> {
    validateCostUsd('releaseUsd', releaseUsd);
    const key = `${projectKey}:${date}`;
    const current = this.usage.get(key) ?? { date, costUsd: 0 };
    const usage = { date, costUsd: Math.max(current.costUsd - releaseUsd, 0) };
    this.usage.set(key, usage);
    return usage;
  }

  async settleReservedCost(
    projectKey: string,
    date: string,
    reservedUsd: number,
    actualUsd: number
  ): Promise<BudgetUsage> {
    validateCostUsd('reservedUsd', reservedUsd);
    validateCostUsd('actualUsd', actualUsd);
    const key = `${projectKey}:${date}`;
    const current = this.usage.get(key) ?? { date, costUsd: 0 };
    const usage = { date, costUsd: Math.max(current.costUsd - reservedUsd + actualUsd, 0) };
    this.usage.set(key, usage);
    return usage;
  }
}

const defaultMemoryLedger = new MemoryBudgetLedger();

export function isBudgetError(error: unknown): boolean {
  return error instanceof CallBudgetExceeded || error instanceof DailyBudgetExceeded;
}

export interface BudgetReservation {
  ledger: BudgetLedger;
  projectKey: string;
  date: string;
  reservedCostUsd: number;
  dailyBudgetUsd: number;
}

export type BudgetReservationResult =
  | {
      status: 'reserved';
      reservation: BudgetReservation;
    }
  | {
      status: 'not_required';
    };

export interface BudgetCheckOptions {
  connection: ModelConnection;
  platform?: PlatformConfig;
  projectKey?: string;
  callBudgetUsd?: number;
  estimatedCostUsd: number;
  ledger?: BudgetLedger;
  now?: Date;
}

function validateCostUsd(label: string, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new InvalidBudgetCost(label, costUsd);
  }
}

function requireProjectKey(projectKey: string | undefined): string {
  const normalized = projectKey?.trim();
  if (!normalized) {
    throw new MissingProjectKey();
  }
  return normalized;
}

export async function enforceBudget(options: BudgetCheckOptions): Promise<BudgetReservationResult> {
  return reserveBudget(options);
}

export async function reserveBudget(options: BudgetCheckOptions): Promise<BudgetReservationResult> {
  validateCostUsd('estimatedCostUsd', options.estimatedCostUsd);
  const callBudgetUsd = options.callBudgetUsd ?? options.connection.cost_budget_usd;
  if (callBudgetUsd !== undefined) {
    validateCostUsd('callBudgetUsd', callBudgetUsd);
  }
  if (callBudgetUsd !== undefined && options.estimatedCostUsd > callBudgetUsd) {
    throw new CallBudgetExceeded(options.estimatedCostUsd, callBudgetUsd);
  }

  const dailyBudgetUsd = options.platform?.budget?.ai_cost_daily_usd;
  if (dailyBudgetUsd === undefined) {
    return { status: 'not_required' };
  }
  validateCostUsd('dailyBudgetUsd', dailyBudgetUsd);

  const ledger = options.ledger ?? defaultMemoryLedger;
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const projectKey = requireProjectKey(options.projectKey);
  const reservation = await ledger.tryReserveCost(
    projectKey,
    date,
    options.estimatedCostUsd,
    dailyBudgetUsd
  );
  if (!reservation.ok) {
    throw new DailyBudgetExceeded(
      options.estimatedCostUsd,
      reservation.usage.costUsd,
      dailyBudgetUsd
    );
  }
  return {
    status: 'reserved',
    reservation: {
      ledger,
      projectKey,
      date,
      reservedCostUsd: options.estimatedCostUsd,
      dailyBudgetUsd,
    },
  };
}

export async function finalizeBudgetReservation(
  reservationResult: BudgetReservationResult | undefined,
  actualCostUsd: number
): Promise<void> {
  validateCostUsd('actualCostUsd', actualCostUsd);
  if (!reservationResult || reservationResult.status === 'not_required') {
    return;
  }

  const { reservation } = reservationResult;
  const deltaUsd = actualCostUsd - reservation.reservedCostUsd;
  if (deltaUsd === 0) {
    return;
  }
  if (deltaUsd < 0) {
    await reservation.ledger.releaseReservedCost(
      reservation.projectKey,
      reservation.date,
      Math.abs(deltaUsd)
    );
    return;
  }

  const usage = await reservation.ledger.settleReservedCost(
    reservation.projectKey,
    reservation.date,
    reservation.reservedCostUsd,
    actualCostUsd
  );
  if (usage.costUsd > reservation.dailyBudgetUsd) {
    throw new DailyBudgetExceeded(0, usage.costUsd, reservation.dailyBudgetUsd);
  }
}
