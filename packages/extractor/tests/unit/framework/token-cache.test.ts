import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenCache } from '../../../src/framework/runtime/auth-handlers/token-cache.js';

describe('TokenCache', () => {
  let cache: TokenCache<string>;

  beforeEach(() => {
    cache = new TokenCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached token within TTL', async () => {
    const fetch = vi.fn().mockResolvedValue({ value: 'tok-1', expiresIn: 3600 });

    const first = await cache.get('key', fetch);
    const second = await cache.get('key', fetch);

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches fresh token after expiry', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ value: 'tok-1', expiresIn: 600 })
      .mockResolvedValueOnce({ value: 'tok-2', expiresIn: 600 });

    await cache.get('key', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Advance past expiry + buffer (5 min buffer)
    vi.advanceTimersByTime(600 * 1000 + 1);

    const result = await cache.get('key', fetch);
    expect(result).toBe('tok-2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent fetches for the same key', async () => {
    let resolveFirst: ((val: { value: string; expiresIn: number }) => void) | undefined;
    const fetch = vi.fn().mockReturnValue(
      new Promise<{ value: string; expiresIn: number }>((resolve) => {
        resolveFirst = resolve;
      })
    );

    const p1 = cache.get('key', fetch);
    const p2 = cache.get('key', fetch);

    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFirst!({ value: 'shared', expiresIn: 3600 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('shared');
    expect(r2).toBe('shared');
  });

  it('lets the first waiter cancel without cancelling the shared producer', async () => {
    let resolveFetch: ((val: { value: string; expiresIn: number }) => void) | undefined;
    const fetch = vi.fn().mockReturnValue(
      new Promise<{ value: string; expiresIn: number }>((resolve) => {
        resolveFetch = resolve;
      })
    );
    const first = new AbortController();
    const second = new AbortController();

    const p1 = cache.get('key', fetch, first.signal);
    const p2 = cache.get('key', fetch, second.signal);
    first.abort();

    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    resolveFetch!({ value: 'shared', expiresIn: 3600 });
    await expect(p2).resolves.toBe('shared');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lets a later waiter cancel promptly while the original waiter continues', async () => {
    let resolveFetch: ((val: { value: string; expiresIn: number }) => void) | undefined;
    const fetch = vi.fn().mockReturnValue(
      new Promise<{ value: string; expiresIn: number }>((resolve) => {
        resolveFetch = resolve;
      })
    );
    const first = new AbortController();
    const second = new AbortController();

    const p1 = cache.get('key', fetch, first.signal);
    const p2 = cache.get('key', fetch, second.signal);
    second.abort();

    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    resolveFetch!({ value: 'shared', expiresIn: 3600 });
    await expect(p1).resolves.toBe('shared');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('observes a shared producer rejection after every waiter aborts', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetch = vi.fn().mockReturnValue(
      new Promise<{ value: string; expiresIn: number }>((_resolve, reject) => {
        rejectFetch = reject;
      })
    );
    const controller = new AbortController();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const waiting = cache.get('key', fetch, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

      rejectFetch!(new Error('token endpoint failed'));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('clears all entries', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ value: 'tok-1', expiresIn: 3600 })
      .mockResolvedValueOnce({ value: 'tok-2', expiresIn: 3600 });

    await cache.get('key', fetch);
    cache.clear();

    const result = await cache.get('key', fetch);
    expect(result).toBe('tok-2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('removes expired entries from the cache map on access', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ value: 'old', expiresIn: 10 })
      .mockResolvedValueOnce({ value: 'new', expiresIn: 3600 });

    await cache.get('key', fetch);

    // Advance past expiry
    vi.advanceTimersByTime(10 * 1000 + 1);

    const result = await cache.get('key', fetch);
    expect(result).toBe('new');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
