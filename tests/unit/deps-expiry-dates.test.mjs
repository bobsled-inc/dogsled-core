import { describe, it, expect } from 'vitest';
import {
  expiryStatus,
  daysUntil,
  EXEMPTION_GRACE_DAYS,
} from '../../scripts/security/expiry-dates.mjs';

describe('expiryStatus', () => {
  const date = '2026-11-15T00:00:00Z';
  const dateMs = Date.parse(date);

  it('returns ok when now is before the date', () => {
    expect(expiryStatus(date, 3, dateMs - 86_400_000)).toBe('ok');
  });

  it('returns warning during the grace period', () => {
    expect(expiryStatus(date, 3, dateMs)).toBe('warning');
    expect(expiryStatus(date, 3, dateMs + 2 * 86_400_000)).toBe('warning');
  });

  it('returns expired after the grace period', () => {
    expect(expiryStatus(date, 3, dateMs + 3 * 86_400_000)).toBe('expired');
    expect(expiryStatus(date, 3, dateMs + 10 * 86_400_000)).toBe('expired');
  });

  it('expires immediately when graceDays is 0', () => {
    expect(expiryStatus(date, 0, dateMs - 1)).toBe('ok');
    expect(expiryStatus(date, 0, dateMs)).toBe('expired');
  });

  it('returns expired for an invalid date', () => {
    expect(expiryStatus('not-a-date', 3)).toBe('expired');
  });
});

describe('daysUntil', () => {
  it('returns positive days for a future date', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(daysUntil('2026-11-12T00:00:00Z', now)).toBe(3);
  });

  it('returns zero on the day', () => {
    const now = Date.parse('2026-11-12T00:00:00Z');
    expect(daysUntil('2026-11-12T00:00:00Z', now)).toBe(0);
  });

  it('returns negative days for a past date', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(daysUntil('2026-11-12T00:00:00Z', now)).toBe(-3);
  });

  it('returns -Infinity for an invalid date', () => {
    expect(daysUntil('invalid')).toBe(-Infinity);
  });
});

describe('EXEMPTION_GRACE_DAYS', () => {
  it('is 3 days', () => {
    expect(EXEMPTION_GRACE_DAYS).toBe(3);
  });
});
