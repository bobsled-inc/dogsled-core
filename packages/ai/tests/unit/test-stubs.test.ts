import { describe, it, expect } from 'vitest';

import {
  mockStructuredOk,
  mockStructuredSchemaViolation,
  mockStructuredProviderError,
  mockStructuredBudgetExceeded,
  mockEmbedSuccess,
  mockEmbedError,
  mockStreamDelta,
  mockStreamError,
  mockStream,
  AlwaysOkBudgetLedger,
  AlwaysExceededBudgetLedger,
} from '../../src/test-stubs.js';

describe('@bobsled-inc/ai/test-stubs', () => {
  it('mockStructuredOk returns typed ok branch', () => {
    const r = mockStructuredOk({ entity_id: 'e1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.entity_id).toBe('e1');
  });

  it('mockStructuredSchemaViolation returns error branch with raw', () => {
    const r = mockStructuredSchemaViolation<unknown>('not json');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('schema_violation');
      expect(r.raw).toBe('not json');
    }
  });

  it('mockStructuredProviderError surfaces provider error', () => {
    const r = mockStructuredProviderError<unknown>('boom');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('provider_error');
  });

  it('mockStructuredBudgetExceeded surfaces budget_exceeded', () => {
    const r = mockStructuredBudgetExceeded<unknown>();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('budget_exceeded');
  });

  it('mockEmbedSuccess returns typed ok branch', () => {
    const r = mockEmbedSuccess('e1', [0.1, 0.2]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vector).toEqual([0.1, 0.2]);
  });

  it('mockEmbedError surfaces error branch with id, discriminator, and message', () => {
    const r = mockEmbedError('e1', 'provider_error');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.id).toBe('e1');
      expect(r.error).toBe('provider_error');
      expect(r.message).toBe('embed failed');
      expect(r.retriable).toBe(false);
    }
  });

  it('mockEmbedError surfaces budget_exceeded branch with retriable override', () => {
    const r = mockEmbedError('e2', 'budget_exceeded', 'over cap', true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.id).toBe('e2');
      expect(r.error).toBe('budget_exceeded');
      expect(r.message).toBe('over cap');
      expect(r.retriable).toBe(true);
    }
  });

  it('mockStream yields delta + error events in order', async () => {
    const events = [mockStreamDelta('hello'), mockStreamError('provider_error')];
    const out: string[] = [];
    for await (const ev of mockStream(events)) {
      out.push(ev.type);
    }
    expect(out).toEqual(['delta', 'error']);
  });

  it('AlwaysOkBudgetLedger tracks running cost per project/date', async () => {
    const ledger = new AlwaysOkBudgetLedger();
    const r1 = await ledger.tryReserveCost('p', '2026-05-07', 0.5, 100);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.usage.costUsd).toBe(0.5);
    const r2 = await ledger.tryReserveCost('p', '2026-05-07', 0.25, 100);
    // Assert success explicitly so a regression to ok=false fails loudly
    // instead of silently skipping the cost assertion.
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.usage.costUsd).toBe(0.75);
  });

  it('AlwaysExceededBudgetLedger always denies reservation; release/settle are no-ops', async () => {
    const ledger = new AlwaysExceededBudgetLedger();
    const r = await ledger.tryReserveCost('p', '2026-05-07', 0.001, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.usage.costUsd).toBe(0);
      expect(r.usage.date).toBe('2026-05-07');
    }
    // Non-reservation paths must not throw and must report 0 spent (no
    // state to track when reservation always denies). Asserting the
    // neutral return ensures regressions to "actually update state"
    // would surface here.
    const released = await ledger.releaseReservedCost('p', '2026-05-07', 0.5);
    expect(released).toEqual({ date: '2026-05-07', costUsd: 0 });
    const settled = await ledger.settleReservedCost('p', '2026-05-07', 0.5, 0.25);
    expect(settled).toEqual({ date: '2026-05-07', costUsd: 0 });
  });
});
