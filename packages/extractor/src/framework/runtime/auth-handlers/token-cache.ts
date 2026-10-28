/**
 * Shared token cache with inflight deduplication.
 *
 * Used by oauth2 and custom-token auth handlers to avoid
 * redundant token fetches and thundering herd on concurrent requests.
 */

import { waitForCaller } from '../../../runtime/wait-for-caller.js';

interface CachedToken<T> {
  value: T;
  expiresAt: number;
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class TokenCache<T = string> {
  private readonly cache = new Map<string, CachedToken<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  async get(
    key: string,
    fetch: () => Promise<{ value: T; expiresIn: number }>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        return cached.value;
      }
      this.cache.delete(key);
    }

    const existing = this.inflight.get(key);
    if (existing) return waitForCaller(existing, signal);

    const promise = fetch()
      .then(({ value, expiresIn }) => {
        this.cache.set(key, {
          value,
          expiresAt: Date.now() + expiresIn * 1000,
        });
        this.inflight.delete(key);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    // The producer is deliberately independent from every waiter's signal.
    // Keep one rejection observer attached even if all waiters abort before
    // their own `then` handlers are installed or before the producer settles.
    void promise.catch(() => undefined);
    this.inflight.set(key, promise);
    return waitForCaller(promise, signal);
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  delete(key: string): void {
    this.cache.delete(key);
    this.inflight.delete(key);
  }
}
