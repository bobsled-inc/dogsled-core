import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  ExtractorConfigError,
  ExtractorDataError,
  ExtractorTransientError,
} from '../../src/runtime/errors.js';
import { FileStateStore } from '../../src/runtime/state.js';
import {
  HttpStateStore,
  createStateStore,
  parseStateBackendUrl,
  resolveStateStore,
} from '../../src/runtime/state-backend.js';

describe('parseStateBackendUrl', () => {
  it('classifies file:// URL as file kind', () => {
    expect(parseStateBackendUrl('file:///tmp/state')).toEqual({
      kind: 'file',
      path: '/tmp/state',
    });
  });

  it('classifies https:// URL as http kind', () => {
    expect(parseStateBackendUrl('https://example.com/api/dogsled/state')).toEqual({
      kind: 'http',
      url: 'https://example.com/api/dogsled/state',
    });
  });

  it('classifies http:// URL as http kind', () => {
    expect(parseStateBackendUrl('http://localhost:3000/state')).toEqual({
      kind: 'http',
      url: 'http://localhost:3000/state',
    });
  });

  it('treats bare paths (no scheme) as file', () => {
    expect(parseStateBackendUrl('./state')).toEqual({
      kind: 'file',
      path: './state',
    });
  });

  it('treats absolute bare paths as file', () => {
    expect(parseStateBackendUrl('/var/lib/state')).toEqual({
      kind: 'file',
      path: '/var/lib/state',
    });
  });

  it('throws on unsupported scheme', () => {
    expect(() => parseStateBackendUrl('s3://bucket/state')).toThrow(/unsupported/i);
  });

  it('throws ExtractorConfigError on unsupported scheme', () => {
    expect(() => parseStateBackendUrl('ftp://host/state')).toThrow(ExtractorConfigError);
  });
});

describe('createStateStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backend-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a FileStateStore for file:// URLs', () => {
    const store = createStateStore(`file://${tmpDir}`);
    expect(store).toBeInstanceOf(FileStateStore);
  });

  it('returns a FileStateStore for bare paths', () => {
    const store = createStateStore(tmpDir);
    expect(store).toBeInstanceOf(FileStateStore);
  });

  it('file backend reads and writes through the factory', async () => {
    const store = createStateStore(`file://${tmpDir}`);
    const state = {
      streams: {
        'linear/issues': {
          cursor_field: 'updated_at',
          cursor_type: 'timestamp' as const,
          cursor_value: '2026-01-01T00:00:00Z',
          last_run_at: '2026-04-18T10:00:00Z',
          record_count: 3,
        },
      },
    };
    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
  });

  it('returns an HttpStateStore for https:// URLs', () => {
    const store = createStateStore('https://example.com/state');
    expect(store).toBeInstanceOf(HttpStateStore);
  });

  it('returns an HttpStateStore for http:// URLs (private host allowed via env)', () => {
    process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS = '1';
    try {
      const store = createStateStore('http://localhost:3000/state');
      expect(store).toBeInstanceOf(HttpStateStore);
    } finally {
      delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    }
  });

  it('rejects http://localhost URLs by default (SSRF guard)', () => {
    delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    expect(() => createStateStore('http://localhost:3000/state')).toThrow(
      /private host|DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS/i
    );
  });

  it('throws ExtractorConfigError (not plain Error) for private host rejection', () => {
    delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    expect(() => createStateStore('http://localhost:3000/state')).toThrow(ExtractorConfigError);
  });

  it('throws ExtractorConfigError for cleartext HTTP bearer rejection', () => {
    const envVar = 'TEST_CLEARTEXT_CLASS';
    process.env[envVar] = 'secret';
    try {
      expect(() =>
        createStateStore('http://public.example.com/state', { authTokenEnv: envVar })
      ).toThrow(ExtractorConfigError);
    } finally {
      delete process.env[envVar];
    }
  });

  it('rejects auth env var that is set to empty string', () => {
    const envVar = 'TEST_EMPTY_AUTH';
    process.env[envVar] = '';
    try {
      expect(() => createStateStore('https://example.com/state', { authTokenEnv: envVar })).toThrow(
        ExtractorConfigError
      );
      expect(() => createStateStore('https://example.com/state', { authTokenEnv: envVar })).toThrow(
        /set but empty/
      );
    } finally {
      delete process.env[envVar];
    }
  });

  it('rejects http://127.0.0.1 URLs by default (SSRF guard)', () => {
    delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    expect(() => createStateStore('http://127.0.0.1/state')).toThrow(/private host/i);
  });

  it('refuses to send bearer token over cleartext http to a public host', () => {
    const envVar = 'TEST_CLEARTEXT_TOKEN';
    process.env[envVar] = 'secret';
    try {
      expect(() =>
        createStateStore('http://public.example.com/state', { authTokenEnv: envVar })
      ).toThrow(/cleartext HTTP|https:\/\//i);
    } finally {
      delete process.env[envVar];
    }
  });

  it('does not misclassify public hostnames starting with fd/fc/fe80 as loopback (opt-in path)', () => {
    // Regression: `fd.example.com` is a public DNS name, not an IPv6 ULA prefix. When the
    // operator has opted in to private hosts via DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1
    // (so the SSRF guard is relaxed), the cleartext-http-bearer check must still fire —
    // isLoopbackOrPrivate treats only IP literals as private.
    process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS = '1';
    const envVar = 'TEST_FDNAME_TOKEN';
    process.env[envVar] = 'secret';
    try {
      for (const host of ['http://fd.example.com/state', 'http://fe80.example.com/state']) {
        expect(() => createStateStore(host, { authTokenEnv: envVar })).toThrow(
          /cleartext HTTP|https:\/\//i
        );
      }
    } finally {
      delete process.env[envVar];
      delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    }
  });

  it('allows bearer token over http to a private host (opt-in)', () => {
    process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS = '1';
    const envVar = 'TEST_PRIVATE_TOKEN';
    process.env[envVar] = 'secret';
    try {
      expect(() =>
        createStateStore('http://localhost:3000/state', { authTokenEnv: envVar })
      ).not.toThrow();
    } finally {
      delete process.env[envVar];
      delete process.env.DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS;
    }
  });

  it('resolves auth token from env var named by authTokenEnv', async () => {
    const envVar = 'TEST_STATE_BACKEND_TOKEN';
    process.env[envVar] = 'resolved-from-env';
    try {
      const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
      const store = createStateStore('https://example.com/state', {
        authTokenEnv: envVar,
        fetch: fakeFetch,
      });
      await store.load();
      const init = fakeFetch.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer resolved-from-env');
    } finally {
      delete process.env[envVar];
    }
  });

  it('omits auth header when authTokenEnv points to an unset variable', async () => {
    const envVar = 'TEST_STATE_BACKEND_TOKEN_UNSET';
    delete process.env[envVar];
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const store = createStateStore('https://example.com/state', {
      authTokenEnv: envVar,
      fetch: fakeFetch,
    });
    await store.load();
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });
});

describe('HttpStateStore.load', () => {
  const sampleState = {
    streams: {
      'linear/issues': {
        cursor_field: 'updated_at',
        cursor_type: 'timestamp' as const,
        cursor_value: '2026-01-01T00:00:00Z',
        last_run_at: '2026-04-18T10:00:00Z',
        record_count: 3,
      },
    },
  };

  it('returns empty state when the server returns 404', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.load()).resolves.toEqual({ streams: {} });
  });

  it('parses and returns state on 200', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sampleState), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.load()).resolves.toEqual(sampleState);
  });

  it('sends GET to the configured URL', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await store.load();
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://example.com/state',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('sends Authorization header when authToken is provided', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const store = new HttpStateStore({
      url: 'https://example.com/state',
      fetch: fakeFetch,
      authToken: 'secret-token',
    });
    await store.load();
    const call = fakeFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
  });

  it('omits Authorization header when authToken is not provided', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await store.load();
    const call = fakeFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('throws ExtractorTransientError when fetch rejects (DNS/network failure)', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.load()).rejects.toBeInstanceOf(ExtractorTransientError);
    await expect(store.load()).rejects.toThrow(/load failed/i);
  });

  it('throws ExtractorDataError when response body is malformed JSON', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('not-json{{{', { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.load()).rejects.toBeInstanceOf(ExtractorDataError);
    await expect(store.load()).rejects.toThrow(/invalid JSON/i);
  });

  it('rejects state response bodies larger than the configured safety cap', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
      })
    );
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.load()).rejects.toBeInstanceOf(ExtractorDataError);
    await expect(store.load()).rejects.toThrow('response body limit');
  });

  it('keeps the deadline active through state response body consumption', async () => {
    const fakeFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { status: 200 }
        )
    );
    const store = new HttpStateStore({
      url: 'https://example.com/state',
      fetch: fakeFetch,
      timeoutMs: 20,
    });

    await expect(store.load()).rejects.toThrow(/timeout/i);
  });
});

describe('HttpStateStore.save', () => {
  const sampleState = {
    streams: {
      'linear/issues': {
        cursor_field: 'updated_at',
        cursor_type: 'timestamp' as const,
        cursor_value: '2026-01-01T00:00:00Z',
        last_run_at: '2026-04-18T10:00:00Z',
        record_count: 3,
      },
    },
  };

  it('sends PUT with JSON body on save', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await store.save(sampleState);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://example.com/state');
    expect(init.method).toBe('PUT');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(sampleState);
  });

  it('sends Authorization header on save when authToken is provided', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const store = new HttpStateStore({
      url: 'https://example.com/state',
      fetch: fakeFetch,
      authToken: 'secret-token',
    });
    await store.save(sampleState);
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
  });

  it('throws on non-2xx response', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.save(sampleState)).rejects.toThrow();
  });

  it('throws ExtractorTransientError when fetch rejects on save (network failure)', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.save(sampleState)).rejects.toBeInstanceOf(ExtractorTransientError);
    await expect(store.save(sampleState)).rejects.toThrow(/save failed/i);
  });
});

describe('HttpStateStore error classification', () => {
  const sampleState = {
    streams: {
      'linear/issues': {
        cursor_field: 'updated_at',
        cursor_type: 'timestamp' as const,
        cursor_value: '2026-01-01T00:00:00Z',
        last_run_at: '2026-04-18T10:00:00Z',
        record_count: 3,
      },
    },
  };

  function storeWithResponse(status: number): HttpStateStore {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    return new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
  }

  it('maps 5xx on load to ExtractorTransientError', async () => {
    await expect(storeWithResponse(500).load()).rejects.toBeInstanceOf(ExtractorTransientError);
    await expect(storeWithResponse(503).load()).rejects.toBeInstanceOf(ExtractorTransientError);
  });

  it('maps 429 on load to ExtractorTransientError', async () => {
    await expect(storeWithResponse(429).load()).rejects.toBeInstanceOf(ExtractorTransientError);
  });

  it('maps 401/403 on load to ExtractorConfigError', async () => {
    await expect(storeWithResponse(401).load()).rejects.toBeInstanceOf(ExtractorConfigError);
    await expect(storeWithResponse(403).load()).rejects.toBeInstanceOf(ExtractorConfigError);
  });

  it('maps other 4xx on load to ExtractorDataError', async () => {
    await expect(storeWithResponse(400).load()).rejects.toBeInstanceOf(ExtractorDataError);
    await expect(storeWithResponse(422).load()).rejects.toBeInstanceOf(ExtractorDataError);
  });

  it('maps 5xx on save to ExtractorTransientError', async () => {
    await expect(storeWithResponse(502).save(sampleState)).rejects.toBeInstanceOf(
      ExtractorTransientError
    );
  });

  it('maps 401 on save to ExtractorConfigError', async () => {
    await expect(storeWithResponse(401).save(sampleState)).rejects.toBeInstanceOf(
      ExtractorConfigError
    );
  });

  it('maps 400 on save to ExtractorDataError', async () => {
    await expect(storeWithResponse(400).save(sampleState)).rejects.toBeInstanceOf(
      ExtractorDataError
    );
  });
});

describe('HttpStateStore etag round-trip', () => {
  const sampleState = {
    streams: {
      'linear/issues': {
        cursor_field: 'updated_at',
        cursor_type: 'timestamp' as const,
        cursor_value: '2026-01-01T00:00:00Z',
        last_run_at: '2026-04-18T10:00:00Z',
        record_count: 3,
      },
    },
  };

  it('sends If-Match on save using etag captured from prior load', async () => {
    const loadedBody = JSON.stringify({ streams: {} });
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(loadedBody, {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"abc123"' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });

    await store.load();
    await store.save(sampleState);

    const putInit = fakeFetch.mock.calls[1]![1] as RequestInit;
    const headers = new Headers(putInit.headers);
    expect(headers.get('If-Match')).toBe('"abc123"');
  });

  it('omits If-Match on save when no prior load returned an etag', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await store.save(sampleState);
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('If-Match')).toBeNull();
  });

  it('updates etag from save response for subsequent saves', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streams: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: '"v2"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });

    await store.load();
    await store.save(sampleState); // PUT uses v1; server returns v2
    await store.save(sampleState); // PUT should now use v2

    const secondPutHeaders = new Headers((fakeFetch.mock.calls[2]![1] as RequestInit).headers);
    expect(secondPutHeaders.get('If-Match')).toBe('"v2"');
  });

  it('maps 412 precondition failed on save to ExtractorTransientError', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 412 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });
    await expect(store.save(sampleState)).rejects.toBeInstanceOf(ExtractorTransientError);
  });

  it('clears stale etag when save response omits ETag', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streams: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        })
      )
      // Second response: 2xx but no etag → should clear lastEtag.
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const store = new HttpStateStore({ url: 'https://example.com/state', fetch: fakeFetch });

    await store.load(); // captures v1
    await store.save(sampleState); // sends v1, captures nothing → lastEtag cleared
    await store.save(sampleState); // should NOT send stale v1

    const thirdPutHeaders = new Headers((fakeFetch.mock.calls[2]![1] as RequestInit).headers);
    expect(thirdPutHeaders.get('If-Match')).toBeNull();
  });
});

describe('resolveStateStore', () => {
  it('defaults to FileStateStore at the given state dir when no flag or env is set', () => {
    delete process.env.DOGSLED_STATE_BACKEND;
    delete process.env.DOGSLED_STATE_AUTH_ENV;
    const store = resolveStateStore({ defaultStateDir: '/tmp/state' });
    expect(store).toBeInstanceOf(FileStateStore);
  });

  it('prefers CLI flag over env variable', () => {
    process.env.DOGSLED_STATE_BACKEND = 'https://env-backend.example.com/state';
    try {
      const store = resolveStateStore({
        defaultStateDir: '/tmp/state',
        stateBackend: 'file:///tmp/flag-dir',
      });
      expect(store).toBeInstanceOf(FileStateStore);
    } finally {
      delete process.env.DOGSLED_STATE_BACKEND;
    }
  });

  it('uses DOGSLED_STATE_BACKEND when no flag is passed', () => {
    process.env.DOGSLED_STATE_BACKEND = 'https://env-backend.example.com/state';
    try {
      const store = resolveStateStore({ defaultStateDir: '/tmp/state' });
      expect(store).toBeInstanceOf(HttpStateStore);
    } finally {
      delete process.env.DOGSLED_STATE_BACKEND;
    }
  });

  it('uses stateAuthEnv from flag for HTTP backend', async () => {
    process.env.TEST_RESOLVE_AUTH = 'auth-from-resolve';
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    try {
      const store = resolveStateStore({
        defaultStateDir: '/tmp/state',
        stateBackend: 'https://example.com/state',
        stateAuthEnv: 'TEST_RESOLVE_AUTH',
        fetch: fakeFetch,
      });
      await store.load();
      const init = fakeFetch.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer auth-from-resolve');
    } finally {
      delete process.env.TEST_RESOLVE_AUTH;
    }
  });

  it('rejects file-backed state paths that escape projectRoot', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-root-'));
    try {
      expect(() =>
        resolveStateStore({
          defaultStateDir: path.join(projectRoot, '.extractor'),
          stateBackend: 'file:///etc/passwd',
          projectRoot,
        })
      ).toThrow(/state backend path|outside of/i);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts file-backed state paths that stay inside projectRoot', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-root-'));
    try {
      expect(() =>
        resolveStateStore({
          defaultStateDir: path.join(projectRoot, '.extractor'),
          stateBackend: `file://${path.join(projectRoot, '.extractor')}`,
          projectRoot,
        })
      ).not.toThrow();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to DOGSLED_STATE_AUTH_ENV when stateAuthEnv flag is absent', async () => {
    process.env.DOGSLED_STATE_AUTH_ENV = 'TEST_ENV_AUTH';
    process.env.TEST_ENV_AUTH = 'auth-from-env';
    const fakeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    try {
      const store = resolveStateStore({
        defaultStateDir: '/tmp/state',
        stateBackend: 'https://example.com/state',
        fetch: fakeFetch,
      });
      await store.load();
      const init = fakeFetch.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer auth-from-env');
    } finally {
      delete process.env.DOGSLED_STATE_AUTH_ENV;
      delete process.env.TEST_ENV_AUTH;
    }
  });
});
