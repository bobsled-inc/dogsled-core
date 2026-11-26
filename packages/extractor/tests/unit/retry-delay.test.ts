import { afterEach, describe, expect, it, vi } from 'vitest';

import { jitteredRetryDelayMs, retryDelayMs } from '../../src/runtime/retry-delay.js';

const exponential = { backoff: 'exponential', retryAfterHeader: true } as const;
const fixed = { backoff: 'fixed', retryAfterHeader: true } as const;

function throttled(headers: Record<string, string>): Response {
  return new Response('', { status: 429, headers });
}

describe('jitteredRetryDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [0, 1000],
    [1, 2000],
    [2, 4000],
    [3, 8000],
    [4, 16_000],
  ])('waits between 0 and %i-th ceiling %i ms', (attempt, ceiling) => {
    expect(jitteredRetryDelayMs(exponential, undefined, attempt, () => 0)).toBe(0);
    expect(jitteredRetryDelayMs(exponential, undefined, attempt, () => 0.5)).toBe(ceiling / 2);
    expect(jitteredRetryDelayMs(exponential, undefined, attempt, () => 0.999999)).toBeLessThan(
      ceiling
    );
  });

  it('never waits 30 seconds or more, however many attempts failed', () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      expect(jitteredRetryDelayMs(exponential, undefined, attempt, () => 0.999999)).toBeLessThan(
        30_000
      );
    }
    expect(jitteredRetryDelayMs(exponential, undefined, 10, () => 0.5)).toBe(15_000);
  });

  it('stays inside its ceiling for random draws', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(1000 * 2 ** attempt, 30_000);
      for (let draw = 0; draw < 500; draw += 1) {
        const delay = jitteredRetryDelayMs(exponential, undefined, attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });

  it('uses Math.random unless the caller passes another source', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    expect(jitteredRetryDelayMs(exponential, undefined, 2)).toBe(1000);
  });

  it('keeps a fixed backoff at one second without jitter', () => {
    for (const attempt of [0, 1, 5]) {
      expect(jitteredRetryDelayMs(fixed, undefined, attempt, () => 0.1)).toBe(1000);
    }
  });

  it('waits exactly as long as Retry-After asks, whatever the random draw', () => {
    const response = throttled({ 'Retry-After': '7' });
    expect(jitteredRetryDelayMs(exponential, response, 0, () => 0)).toBe(7000);
    expect(jitteredRetryDelayMs(exponential, response, 3, () => 0.999)).toBe(7000);
    expect(jitteredRetryDelayMs(fixed, response, 0, () => 0.5)).toBe(7000);
  });

  it('reads a Retry-After date', () => {
    const soon = new Date(Date.now() + 10_000).toUTCString();
    const delay = jitteredRetryDelayMs(exponential, throttled({ 'Retry-After': soon }), 0);
    expect(delay).toBeGreaterThan(8000);
    expect(delay).toBeLessThanOrEqual(10_000);
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(jitteredRetryDelayMs(exponential, throttled({ 'Retry-After': past }), 0)).toBe(0);
  });

  it('caps Retry-After at five minutes', () => {
    expect(jitteredRetryDelayMs(exponential, throttled({ 'Retry-After': '86400' }), 0)).toBe(
      300_000
    );
  });

  it('ignores Retry-After when the policy turns it off or the value is not usable', () => {
    const response = throttled({ 'Retry-After': '7' });
    const off = { backoff: 'exponential', retryAfterHeader: false } as const;
    expect(jitteredRetryDelayMs(off, response, 1, () => 0.5)).toBe(1000);
    expect(
      jitteredRetryDelayMs(exponential, throttled({ 'Retry-After': 'soon' }), 1, () => 0.5)
    ).toBe(1000);
  });
});

describe('retryDelayMs', () => {
  it('stays the same fixed doubling for token requests', () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(exponential, undefined, attempt))
    ).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(retryDelayMs(fixed, undefined, 3)).toBe(1000);
    expect(retryDelayMs(exponential, throttled({ 'Retry-After': '3' }), 0)).toBe(3000);
  });
});
