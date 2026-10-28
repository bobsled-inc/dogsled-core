import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../src/runtime/rate-limiter.js';

describe('RateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires tokens without delay when burst available', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 100, burst: 10 });
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('retries on configured status codes', async () => {
    let callCount = 0;
    const limiter = new RateLimiter({
      requestsPerSecond: 100,
      burst: 10,
      retryOn: [429],
      maxRetries: 2,
      backoff: 'fixed',
    });

    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount < 3) {
        return new Response('', { status: 429, statusText: 'Too Many Requests' });
      }
      return new Response('ok', { status: 200 });
    });

    const response = await limiter.fetchWithRetry('https://example.com', {});
    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
  });

  it('throws after max retries exceeded', async () => {
    const limiter = new RateLimiter({
      requestsPerSecond: 100,
      burst: 10,
      retryOn: [429],
      maxRetries: 1,
      backoff: 'fixed',
    });

    vi.stubGlobal(
      'fetch',
      async () => new Response('', { status: 429, statusText: 'Too Many Requests' })
    );

    await expect(limiter.fetchWithRetry('https://example.com', {})).rejects.toThrow('HTTP 429');
  });

  it('does not start a retry after the caller request budget is spent', async () => {
    const limiter = new RateLimiter({
      requestsPerSecond: 100,
      burst: 10,
      retryOn: [429],
      maxRetries: 3,
      backoff: 'fixed',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response('', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    let attempts = 0;

    await expect(
      limiter.fetchWithRetry('https://example.com', {}, 30_000, () => {
        if (attempts >= 2) throw new Error('network request budget spent');
        attempts += 1;
      })
    ).rejects.toThrow('network request budget spent');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
