import { describe, expect, it, vi } from 'vitest';
import {
  classifyHttpStatus,
  computeBackoffMs,
  isRetryable,
  withRetry,
} from '../../src/runtime/activate/retry.js';

describe('classifyHttpStatus', () => {
  it('classifies 429 as rate_limited', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limited');
  });

  it('classifies 503 as server_error', () => {
    expect(classifyHttpStatus(503)).toBe('server_error');
  });

  it('classifies 401 as auth_error', () => {
    expect(classifyHttpStatus(401)).toBe('auth_error');
  });

  it('classifies 404 as not_found', () => {
    expect(classifyHttpStatus(404)).toBe('not_found');
  });

  it('classifies 409 as conflict', () => {
    expect(classifyHttpStatus(409)).toBe('conflict');
  });

  it('classifies 408 as timeout', () => {
    expect(classifyHttpStatus(408)).toBe('timeout');
  });

  it('classifies 422 as validation_error', () => {
    expect(classifyHttpStatus(422)).toBe('validation_error');
  });

  it('classifies 500 as server_error', () => {
    expect(classifyHttpStatus(500)).toBe('server_error');
  });
});

describe('isRetryable', () => {
  it('rate_limited is retryable', () => expect(isRetryable('rate_limited')).toBe(true));
  it('server_error is retryable', () => expect(isRetryable('server_error')).toBe(true));
  it('timeout is retryable', () => expect(isRetryable('timeout')).toBe(true));
  it('network_error is retryable', () => expect(isRetryable('network_error')).toBe(true));
  it('auth_error is not retryable', () => expect(isRetryable('auth_error')).toBe(false));
  it('not_found is not retryable', () => expect(isRetryable('not_found')).toBe(false));
  it('validation_error is not retryable', () =>
    expect(isRetryable('validation_error')).toBe(false));
  it('conflict is not retryable', () => expect(isRetryable('conflict')).toBe(false));
});

describe('computeBackoffMs', () => {
  it('returns baseDelayMs on attempt 0', () => {
    expect(computeBackoffMs(0, 500)).toBe(500);
  });

  it('doubles delay each attempt', () => {
    expect(computeBackoffMs(1, 500)).toBe(1000);
    expect(computeBackoffMs(2, 500)).toBe(2000);
    expect(computeBackoffMs(3, 500)).toBe(4000);
  });
});

describe('withRetry', () => {
  it('resolves immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValueOnce('ok');
    const result = await withRetry(fn, () => false, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and eventually succeeds', async () => {
    const err = new Error('temporary');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    const result = await withRetry(fn, () => true, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after maxRetries with non-retryable error', async () => {
    const err = new Error('permanent');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, () => false, { maxRetries: 3, baseDelayMs: 0 })).rejects.toThrow(
      'permanent'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries for persistent retryable errors', async () => {
    const err = new Error('transient');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, () => true, { maxRetries: 2, baseDelayMs: 0 })).rejects.toThrow(
      'transient'
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const err = new Error('fail');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, () => true, { maxRetries: 0, baseDelayMs: 0 })).rejects.toThrow(
      'fail'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid maxRetries before any attempts', async () => {
    const fn = vi.fn();
    await expect(withRetry(fn, () => true, { maxRetries: -1, baseDelayMs: 0 })).rejects.toThrow(
      TypeError
    );
    await expect(
      withRetry(fn, () => true, { maxRetries: Infinity, baseDelayMs: 0 })
    ).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects invalid baseDelayMs before any attempts', async () => {
    const fn = vi.fn();
    await expect(withRetry(fn, () => true, { maxRetries: 1, baseDelayMs: -1 })).rejects.toThrow(
      TypeError
    );
    await expect(
      withRetry(fn, () => true, { maxRetries: 1, baseDelayMs: Infinity })
    ).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws an Error when the operation rejects with undefined', async () => {
    const fn = vi.fn().mockRejectedValue(undefined);
    await expect(withRetry(fn, () => false, { maxRetries: 1, baseDelayMs: 0 })).rejects.toThrow(
      'retry failed: no error captured'
    );
  });

  it('wraps string rejections in an Error', async () => {
    const fn = vi.fn().mockRejectedValue('temporary outage');
    await expect(withRetry(fn, () => false, { maxRetries: 1, baseDelayMs: 0 })).rejects.toThrow(
      'temporary outage'
    );
  });
});
