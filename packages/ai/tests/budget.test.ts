import { describe, expect, it } from 'vitest';

import {
  CallBudgetExceeded,
  DailyBudgetExceeded,
  InvalidBudgetCost,
  MemoryBudgetLedger,
  MissingProjectKey,
  enforceBudget,
  finalizeBudgetReservation,
} from '../src/index.js';
import type { ModelConnection } from '../src/index.js';

const connection: ModelConnection = {
  provider: 'amazon-bedrock',
  model: 'amazon.titan-embed-text-v2:0',
  region: 'us-east-1',
  dimension: 1024,
};

describe('enforceBudget', () => {
  it('rejects calls above the per-call budget', async () => {
    await expect(
      enforceBudget({
        connection,
        estimatedCostUsd: 0.02,
        callBudgetUsd: 0.01,
      })
    ).rejects.toBeInstanceOf(CallBudgetExceeded);
  });

  it('persists same-day spend in the ledger and rejects daily overages', async () => {
    const ledger = new MemoryBudgetLedger();
    const now = new Date('2026-05-05T12:00:00.000Z');

    const reservation = await enforceBudget({
      connection,
      platform: { budget: { ai_cost_daily_usd: 0.03 } },
      projectKey: 'demo',
      estimatedCostUsd: 0.02,
      ledger,
      now,
    });
    expect(reservation.status).toBe('reserved');

    await expect(
      enforceBudget({
        connection,
        platform: { budget: { ai_cost_daily_usd: 0.03 } },
        projectKey: 'demo',
        estimatedCostUsd: 0.02,
        ledger,
        now,
      })
    ).rejects.toBeInstanceOf(DailyBudgetExceeded);
  });

  it('returns not_required when no daily budget needs a reservation', async () => {
    await expect(
      enforceBudget({
        connection,
        estimatedCostUsd: 0.01,
      })
    ).resolves.toEqual({ status: 'not_required' });
  });

  it('uses one in-process default ledger when callers do not pass a ledger', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    const projectKey = `default-ledger-${Math.random()}`;

    await enforceBudget({
      connection,
      platform: { budget: { ai_cost_daily_usd: 0.03 } },
      projectKey,
      estimatedCostUsd: 0.02,
      now,
    });

    await expect(
      enforceBudget({
        connection,
        platform: { budget: { ai_cost_daily_usd: 0.03 } },
        projectKey,
        estimatedCostUsd: 0.02,
        now,
      })
    ).rejects.toBeInstanceOf(DailyBudgetExceeded);
  });

  it('requires an explicit project key when daily budgeting is enabled', async () => {
    await expect(
      enforceBudget({
        connection,
        platform: { budget: { ai_cost_daily_usd: 0.03 } },
        estimatedCostUsd: 0.01,
      })
    ).rejects.toBeInstanceOf(MissingProjectKey);
  });

  it('rejects non-finite and negative budget costs', async () => {
    await expect(
      enforceBudget({
        connection,
        estimatedCostUsd: Number.NaN,
      })
    ).rejects.toBeInstanceOf(InvalidBudgetCost);

    await expect(
      finalizeBudgetReservation(
        {
          status: 'reserved',
          reservation: {
            ledger: new MemoryBudgetLedger(),
            projectKey: 'demo',
            date: '2026-05-05',
            reservedCostUsd: 0.01,
            dailyBudgetUsd: 1,
          },
        },
        -0.01
      )
    ).rejects.toBeInstanceOf(InvalidBudgetCost);
  });

  it('releases unused reservation as a non-negative refund', async () => {
    const ledger = new MemoryBudgetLedger();
    const result = await enforceBudget({
      connection,
      platform: { budget: { ai_cost_daily_usd: 0.03 } },
      projectKey: 'release-demo',
      estimatedCostUsd: 0.02,
      ledger,
      now: new Date('2026-05-05T12:00:00.000Z'),
    });

    await finalizeBudgetReservation(result, 0.01);

    await expect(
      enforceBudget({
        connection,
        platform: { budget: { ai_cost_daily_usd: 0.03 } },
        projectKey: 'release-demo',
        estimatedCostUsd: 0.02,
        ledger,
        now: new Date('2026-05-05T12:00:00.000Z'),
      })
    ).resolves.toMatchObject({ status: 'reserved' });
  });

  it('records actual spend before reporting a post-call daily overage', async () => {
    const ledger = new MemoryBudgetLedger();
    const now = new Date('2026-05-05T12:00:00.000Z');
    const result = await enforceBudget({
      connection,
      platform: { budget: { ai_cost_daily_usd: 0.03 } },
      projectKey: 'overrun-demo',
      estimatedCostUsd: 0.02,
      ledger,
      now,
    });

    await expect(finalizeBudgetReservation(result, 0.04)).rejects.toBeInstanceOf(
      DailyBudgetExceeded
    );

    await expect(
      enforceBudget({
        connection,
        platform: { budget: { ai_cost_daily_usd: 0.03 } },
        projectKey: 'overrun-demo',
        estimatedCostUsd: 0.001,
        ledger,
        now,
      })
    ).rejects.toBeInstanceOf(DailyBudgetExceeded);
  });
});
