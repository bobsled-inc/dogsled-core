import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponseBodyLimitError } from '../../src/framework/core/index.js';
import {
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  RateLimitTimeoutError,
  RequestRetryError,
  type RequestRetryEvent,
} from '../../src/runtime/rate-limiter.js';

const URL = 'https://example.com/items';

/** The shapes undici raises: the code sits on the cause of a TypeError. */
function networkFailure(code: string, message: string, summary = 'fetch failed'): TypeError {
  return new TypeError(summary, { cause: Object.assign(new Error(message), { code }) });
}
const reset = (): TypeError => networkFailure('ECONNRESET', 'read ECONNRESET');

/** A fetch that never answers. Like undici, it rejects with the abort reason. */
function hangUntilAborted(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

/** A 200 whose body fails halfway, as undici reports a dropped connection. */
function bodyThatDrops(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
        controller.error(networkFailure('UND_ERR_SOCKET', 'other side closed', 'terminated'));
      },
    })
  );
}

const readText = (sink: string[]) => async (response: Response) => {
  sink.push(await response.text());
};

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

describe('RateLimiter retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Full jitter at zero keeps every backoff wait at 0 ms unless a test sets it.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('attempt timeouts', () => {
    it('gives each attempt its own timeout', async () => {
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
        signals.push(init!.signal!);
        if (signals.length === 1) return hangUntilAborted(url, init);
        // 800 ms is less than a timeout but more than the 0 ms a shared 1000 ms deadline leaves.
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response('ok')), 800);
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter().fetchWithRetry(URL, {}, 1000);
      // The 0 ms wait that follows the timeout is set while time moves, so fake time puts it 1 ms later.
      await vi.advanceTimersByTimeAsync(1001);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals[0]!.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(800);
      const response = await result;

      expect(response.status).toBe(200);
      expect(signals[1]!.aborted).toBe(false);
    });

    it('retries a request whose attempt timed out', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(hangUntilAborted)
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);
      const events: RequestRetryEvent[] = [];

      const result = new RateLimiter().fetchWithRetry(URL, {}, 500, undefined, undefined, {
        onRetry: (event) => void events.push(event),
      });
      await vi.runAllTimersAsync();

      expect((await result).status).toBe(200);
      expect(events).toEqual([
        {
          attempt: 1,
          maxAttempts: 5,
          category: 'timeout',
          reason: 'timed out after 500ms',
          waitMs: 0,
        },
      ]);
    });

    it('stops the timer of an attempt whose body was read', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
      const texts: string[] = [];

      await new RateLimiter().fetchWithRetry(URL, {}, 500, undefined, undefined, {
        readBody: readText(texts),
      });

      expect(texts).toEqual(['ok']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a response body that is read later under the attempt timeout', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  init?.signal?.addEventListener('abort', () =>
                    controller.error(init.signal?.reason)
                  );
                },
              })
            )
        )
      );

      const response = await new RateLimiter().fetchWithRetry(URL, {}, 1000);
      const read = response.text().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);

      expect(await read).toMatchObject({ name: 'TimeoutError' });
    });
  });

  describe('connection failures', () => {
    it.each([
      ['ECONNRESET', 'read ECONNRESET'],
      ['EPIPE', 'write EPIPE'],
      ['ETIMEDOUT', 'connect ETIMEDOUT 203.0.113.9:443'],
      ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example.com'],
      ['UND_ERR_SOCKET', 'other side closed'],
      ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'],
      ['UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'],
      ['UND_ERR_BODY_TIMEOUT', 'Body Timeout Error'],
    ])('retries a connection that fails with %s before any response', async (code, message) => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(networkFailure(code, message))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter().fetchWithRetry(URL, {});
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('finds the code anywhere in the chain of causes', async () => {
      const failure = new TypeError('fetch failed', {
        cause: new Error('connect failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        }),
      });
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter().fetchWithRetry(URL, {});
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(200);
    });

    it.each([
      ['a network failure that carries no code', () => new TypeError('fetch failed')],
      [
        'a TLS certificate error',
        () => networkFailure('CERT_HAS_EXPIRED', 'certificate has expired'),
      ],
      [
        'an HTTP parser error',
        () => networkFailure('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size'),
      ],
      [
        'the refusal of a private address',
        () =>
          new TypeError('fetch failed', {
            cause: new Error(
              'Request URL hostname "internal.example" resolves to private address 10.0.0.5.'
            ),
          }),
      ],
      [
        'the refusal of a private host name',
        () => new Error('Request URL hostname "internal" is a private/internal host.'),
      ],
    ])('does not retry %s', async (_name, failure) => {
      const error = failure();
      const fetchMock = vi.fn().mockRejectedValue(error);
      vi.stubGlobal('fetch', fetchMock);

      await expect(new RateLimiter().fetchWithRetry(URL, {})).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('response bodies', () => {
    it('retries the whole request when reading the body fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(bodyThatDrops())
        .mockResolvedValueOnce(new Response('{"items":[]}'));
      vi.stubGlobal('fetch', fetchMock);
      const texts: string[] = [];
      const events: RequestRetryEvent[] = [];

      const result = new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
        readBody: readText(texts),
        onRetry: (event) => void events.push(event),
      });
      await vi.advanceTimersByTimeAsync(0);
      await result;

      expect(texts).toEqual(['{"items":[]}']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(events[0]).toMatchObject({
        category: 'response_body',
        reason: 'response body read failed: other side closed (UND_ERR_SOCKET)',
      });
    });

    it('does not retry a body that fails without a known network code', async () => {
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError('terminated'));
              },
            })
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
          readBody: async (response) => void (await response.text()),
        })
      ).rejects.toThrow('terminated');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a body that stalls until the attempt times out', async () => {
      const stalled = (_url: unknown, init?: RequestInit): Response =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            },
          })
        );
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(stalled)
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);
      const texts: string[] = [];

      const result = new RateLimiter().fetchWithRetry(URL, {}, 1000, undefined, undefined, {
        readBody: readText(texts),
      });
      await vi.runAllTimersAsync();
      await result;

      expect(texts).toEqual(['ok']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a size limit', () => new ResponseBodyLimitError('API response', 10)],
      ['an error that is not a network failure', () => new SyntaxError('Unexpected token')],
    ])('does not retry %s', async (_name, failure) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);
      const error = failure();

      await expect(
        new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
          readBody: async () => {
            throw error;
          },
        })
      ).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('statuses', () => {
    it.each([429, 502, 503, 504])('retries HTTP %i', async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter().fetchWithRetry(URL, {});
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('hands back a status that is not in the retry list', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);

      const response = await new RateLimiter().fetchWithRetry(URL, {});

      expect(response.status).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits as long as Retry-After says', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '7' } }))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);
      const events: RequestRetryEvent[] = [];

      const result = new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
        onRetry: (event) => void events.push(event),
      });
      await vi.advanceTimersByTimeAsync(6999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await result;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(events[0]).toMatchObject({
        attempt: 1,
        category: 'http_status',
        status: 429,
        reason: 'HTTP 429',
        waitMs: 7000,
      });
    });

    it('ignores Retry-After when the option turns it off', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '7' } }))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter({ retryAfterHeader: false }).fetchWithRetry(URL, {});
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(200);
    });
  });

  describe('giving up', () => {
    it('stops after five attempts and names them in the status error', async () => {
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response('', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Retry-After': '0' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      const outcome = new RateLimiter().fetchWithRetry(URL, {}).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await outcome;

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(error).toMatchObject({
        status: 503,
        message: 'HTTP 503: Service Unavailable (after 5 attempts)',
      });
    });

    it('keeps the plain status error when only one attempt runs', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('', { status: 503, statusText: 'Unavailable' }))
      );

      await expect(new RateLimiter({ maxRetries: 0 }).fetchWithRetry(URL, {})).rejects.toThrow(
        /^HTTP 503: Unavailable$/
      );
    });

    it('names the attempts when every attempt timed out', async () => {
      const fetchMock = vi.fn().mockImplementation(hangUntilAborted);
      vi.stubGlobal('fetch', fetchMock);

      const outcome = new RateLimiter({ maxRetries: 2 })
        .fetchWithRetry(URL, {}, 500)
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await outcome;

      expect(error).toBeInstanceOf(RateLimitTimeoutError);
      expect((error as Error).message).toBe(
        'Request failed after 3 attempts; last failure: timed out after 500ms: https://example.com/items'
      );
      expect((error as Error).cause).toMatchObject({ name: 'TimeoutError' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('names the attempts and the reason when the connection kept failing', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => Promise.reject(reset()));
      vi.stubGlobal('fetch', fetchMock);

      const outcome = new RateLimiter({ maxRetries: 2 })
        .fetchWithRetry(URL, {})
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await outcome;

      expect(error).toBeInstanceOf(RequestRetryError);
      expect(error).toMatchObject({ attempts: 3 });
      expect((error as Error).message).toBe(
        'Request failed after 3 attempts; last failure: read ECONNRESET: https://example.com/items'
      );
      expect((error as Error).cause).toBeInstanceOf(TypeError);
    });

    it('hides the query string of the request from the error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(hangUntilAborted));

      const outcome = new RateLimiter({ maxRetries: 1 })
        .fetchWithRetry(`${URL}?api_key=hunter2`, {}, 100)
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(((await outcome) as Error).message).not.toContain('hunter2');
    });

    it('throws the original error when a single attempt runs', async () => {
      const failure = reset();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

      await expect(new RateLimiter({ maxRetries: 0 }).fetchWithRetry(URL, {})).rejects.toBe(
        failure
      );
    });
  });

  describe('cancellation', () => {
    it('does not retry when the caller aborts during an attempt', async () => {
      const fetchMock = vi.fn().mockImplementation(hangUntilAborted);
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const reason = new Error('stop');

      const outcome = new RateLimiter()
        .fetchWithRetry(URL, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the caller aborts with a timeout reason', async () => {
      const fetchMock = vi.fn().mockImplementation(hangUntilAborted);
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const reason = new DOMException('The action timed out', 'TimeoutError');

      const outcome = new RateLimiter()
        .fetchWithRetry(URL, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops waiting between attempts when the caller aborts', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 503, headers: { 'Retry-After': '60' } }));
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const reason = new Error('stop');

      const outcome = new RateLimiter()
        .fetchWithRetry(URL, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('backoff', () => {
    async function waitsBeforeRetries(
      limiter: RateLimiter,
      random: number,
      failures: number
    ): Promise<number[]> {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => Promise.reject(reset()))
      );
      const events: RequestRetryEvent[] = [];
      const outcome = limiter
        .fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
          onRetry: (event) => void events.push(event),
        })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2 ** failures * 1000);
      await outcome;
      return events.map((event) => event.waitMs);
    }

    it('doubles the longest wait each retry and draws below it', async () => {
      expect(await waitsBeforeRetries(new RateLimiter(), 0.5, 5)).toEqual([500, 1000, 2000, 4000]);
    });

    it('stays within the bounds for any random draw', async () => {
      expect(await waitsBeforeRetries(new RateLimiter(), 0, 5)).toEqual([0, 0, 0, 0]);
      const highest = await waitsBeforeRetries(new RateLimiter(), 0.999999, 5);
      expect(highest).toEqual([999, 1999, 3999, 7999]);
    });

    it('caps the wait at 30 seconds', async () => {
      const waits = await waitsBeforeRetries(new RateLimiter({ maxRetries: 8 }), 0.999999, 9);
      expect(Math.max(...waits)).toBeLessThan(30_000);
      expect(waits.slice(-3).every((wait) => wait >= 15_000)).toBe(true);
    });

    it('waits one second between attempts when the backoff is fixed', async () => {
      const waits = await waitsBeforeRetries(new RateLimiter({ backoff: 'fixed' }), 0.3, 5);
      expect(waits).toEqual([1000, 1000, 1000, 1000]);
    });
  });

  describe('retry settings of a read', () => {
    it('makes only the retries the config asks for', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => Promise.reject(reset()));
      vi.stubGlobal('fetch', fetchMock);

      const outcome = new RateLimiter({ maxRetries: 3 })
        .fetchWithRetry(URL, {})
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await outcome).toBeInstanceOf(RequestRetryError);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('retries only the statuses the config lists', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 500, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter({ retryOn: [500] }).fetchWithRetry(URL, {});
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('reporting retries', () => {
    it('keeps retrying when the report fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      const result = new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
        onRetry: async () => {
          throw new Error('run log is closed');
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect((await result).status).toBe(200);
    });

    it('reports every retry in order', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(reset())
        .mockResolvedValueOnce(new Response('', { status: 504 }))
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);
      const events: RequestRetryEvent[] = [];

      const result = new RateLimiter().fetchWithRetry(URL, {}, 30_000, undefined, undefined, {
        onRetry: (event) => void events.push(event),
      });
      await vi.advanceTimersByTimeAsync(2000);
      await result;

      expect(events).toEqual([
        {
          attempt: 1,
          maxAttempts: 5,
          category: 'connection',
          reason: 'read ECONNRESET',
          waitMs: 500,
        },
        {
          attempt: 2,
          maxAttempts: 5,
          category: 'http_status',
          reason: 'HTTP 504',
          status: 504,
          waitMs: 1000,
        },
      ]);
    });
  });
});

describe('RateLimiter for a request that changes data', () => {
  const write = { idempotent: false } as const;
  const writeInit: RequestInit = { method: 'POST' };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the defaults it had before a read retried more', () => {
    expect(DEFAULT_RATE_LIMIT).toMatchObject({
      retryOn: [429, 503],
      maxRetries: 3,
      backoff: 'exponential',
      retryAfterHeader: true,
    });
  });

  it('makes four attempts and waits 1, 2 and 4 seconds between them', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response('', { status: 503, statusText: 'Service Unavailable' })
      );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = new RateLimiter()
      .fetchWithRetry(URL, writeInit, 30_000, undefined, undefined, write)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(await outcome).toMatchObject({ status: 503, message: 'HTTP 503: Service Unavailable' });
  });

  it('shares one deadline across every attempt and every wait', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = new RateLimiter()
      .fetchWithRetry(URL, writeInit, 5000, undefined, undefined, write)
      .catch((error: unknown) => error);
    // Attempts start at 0, 1000 and 3000 ms. The next wait, 4000 ms, would end after the 5000 ms deadline.
    await vi.advanceTimersByTimeAsync(3000);
    const error = await outcome;

    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    expect((error as Error).message).toBe(
      'Request timed out after 5000ms: https://example.com/items'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an attempt that timed out', async () => {
    const fetchMock = vi.fn().mockImplementation(hangUntilAborted);
    vi.stubGlobal('fetch', fetchMock);

    const error = await new RateLimiter()
      .fetchWithRetry(URL, writeInit, 20, undefined, undefined, write)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    expect((error as Error).message).toBe(
      'Request timed out after 20ms: https://example.com/items'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the body to the caller and keeps the deadline on it', async () => {
    const stalled = (_url: unknown, init?: RequestInit): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        })
      );
    vi.stubGlobal('fetch', vi.fn().mockImplementation(stalled));
    const readBody = vi.fn();
    const onRetry = vi.fn();

    const response = await new RateLimiter().fetchWithRetry(
      URL,
      writeInit,
      20,
      undefined,
      undefined,
      { ...write, readBody, onRetry }
    );

    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(readBody).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries any error before a response, whether or not it is a network failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket exploded'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const result = new RateLimiter().fetchWithRetry(
      URL,
      writeInit,
      30_000,
      undefined,
      undefined,
      write
    );
    await vi.advanceTimersByTimeAsync(3000);

    expect((await result).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws the last error as it was when the attempts run out', async () => {
    vi.useFakeTimers();
    const failure = reset();
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('fetch', fetchMock);

    const outcome = new RateLimiter({ maxRetries: 1, backoff: 'fixed' })
      .fetchWithRetry(URL, writeInit, 30_000, undefined, undefined, write)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await outcome).toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 504])(
    'hands back HTTP %i, which the default list does not retry',
    async (status) => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status }));
      vi.stubGlobal('fetch', fetchMock);

      const response = await new RateLimiter().fetchWithRetry(
        URL,
        writeInit,
        30_000,
        undefined,
        undefined,
        write
      );

      expect(response.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('retries the statuses that the config lists, and only those', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 502, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = new RateLimiter({ retryOn: [502] }).fetchWithRetry(
      URL,
      writeInit,
      30_000,
      undefined,
      undefined,
      write
    );
    await vi.advanceTimersByTimeAsync(0);

    expect((await result).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])('retries HTTP %i', async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const result = new RateLimiter().fetchWithRetry(
      URL,
      writeInit,
      30_000,
      undefined,
      undefined,
      write
    );
    await vi.advanceTimersByTimeAsync(0);

    expect((await result).status).toBe(200);
  });
});
