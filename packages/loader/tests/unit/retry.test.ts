import { describe, expect, it, vi } from 'vitest';

import { withRetry, isRetryableError, CircuitBreakerError } from '../../src/runtime/retry.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { initialDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('400 Bad Request'));

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toThrow('400 Bad Request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after maxAttempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(
      withRetry(fn, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toThrow('503 Service Unavailable');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('invokes onRetry callback with correct arguments', async () => {
    const onRetry = vi.fn();
    const retryError = new Error('service unavailable');
    const fn = vi.fn().mockRejectedValueOnce(retryError).mockResolvedValue('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), retryError);
  });

  it('throws CircuitBreakerError after maxConsecutiveFailures', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('service unavailable'));

    await expect(
      withRetry(fn, {
        maxAttempts: 10,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxConsecutiveFailures: 3,
      })
    ).rejects.toThrow(CircuitBreakerError);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('CircuitBreakerError has descriptive message', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('service unavailable'));

    await expect(
      withRetry(fn, {
        maxAttempts: 10,
        initialDelayMs: 1,
        maxDelayMs: 1,
        maxConsecutiveFailures: 5,
      })
    ).rejects.toThrow('Circuit breaker tripped after 5 consecutive failures');
  });

  it('respects increased default max delay of 60_000', async () => {
    vi.useFakeTimers();

    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100_000,
      onRetry,
    });

    // Advance past the capped delay
    await vi.advanceTimersByTimeAsync(60_000);

    await promise;

    // With initialDelayMs=100_000 and no explicit maxDelayMs,
    // delay should be capped at DEFAULT_MAX_DELAY_MS (60_000)
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [, delay] = onRetry.mock.calls[0] as [number, number, Error];
    expect(delay).toBeLessThanOrEqual(60_000);

    vi.useRealTimers();
  });
});

describe('isRetryableError', () => {
  it('identifies retryable errors by message text', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('service unavailable'))).toBe(true);
    expect(isRetryableError(new Error('Rate Limit: too many requests'))).toBe(true);
  });

  it('identifies retryable errors by numeric code property', () => {
    const err429 = Object.assign(new Error('too many requests'), { code: 429 });
    const err503 = Object.assign(new Error('unavailable'), { code: 503 });
    const err500 = Object.assign(new Error('server error'), { code: 500 });
    expect(isRetryableError(err429)).toBe(true);
    expect(isRetryableError(err503)).toBe(true);
    expect(isRetryableError(err500)).toBe(true);
  });

  it('identifies non-retryable errors', () => {
    expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
    expect(isRetryableError(new Error('404 Not Found'))).toBe(false);
    expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
    expect(isRetryableError(new Error('schema mismatch'))).toBe(false);
  });

  it('does not false-positive on ambiguous numeric messages', () => {
    expect(isRetryableError(new Error('Processed 500 rows'))).toBe(false);
    expect(isRetryableError(new Error('Column has 429 characters'))).toBe(false);
    expect(isRetryableError(new Error('internal error: unsupported type'))).toBe(false);
  });

  it('identifies network errors by code', () => {
    const econnreset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const etimedout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    expect(isRetryableError(econnreset)).toBe(true);
    expect(isRetryableError(etimedout)).toBe(true);
    expect(isRetryableError(epipe)).toBe(true);
  });

  it('returns false for non-Error values', () => {
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('identifies rateLimitExceeded and quotaExceeded as retryable', () => {
    expect(isRetryableError(new Error('rateLimitExceeded'))).toBe(true);
    expect(isRetryableError(new Error('quotaExceeded'))).toBe(true);
    expect(isRetryableError(new Error('API error: rateLimitExceeded for project'))).toBe(true);
    expect(isRetryableError(new Error('BigQuery quotaExceeded: concurrent queries'))).toBe(true);
  });
});
