import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readProviderResponseBody,
  ResponseBodyLimitError,
} from '../../src/framework/core/index.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { ExtractorDataError } from '../../src/runtime/errors.js';
import { RateLimitTimeoutError } from '../../src/runtime/rate-limiter.js';
import { BobsledRuntimeError } from '@bobsled-inc/protocol';

import { makeProvider, makeResource } from '../helpers/fixtures.js';

async function expectBobsledCause(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.catch((value) => value as BobsledRuntimeError);
  expect(error).toBeInstanceOf(BobsledRuntimeError);
  expect((error as BobsledRuntimeError).cause?.message).toContain(message);
}

describe('ExtractorClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('merges integration defaults and templates request bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'bearer', token: 'secret' },
        headers: {
          Accept: 'application/json',
          'X-Shared': 'integration',
        },
      }),
      cliInputs: { repo: 'cli-repo', cursor: 'after-1' },
    });

    const resource = makeResource({
      api: {
        endpoint: '/repos/${{ input.repo }}/items',
        method: 'POST',
        headers: {
          'X-Shared': 'resource',
          'X-Repo': '${{ input.repo }}',
        },
        request_body: {
          query: 'query',
          variables: {
            after: '${{ input.cursor }}',
            repos: ['${{ input.repo }}'],
          },
        },
      },
      input: {
        repo: { type: 'string', required: true },
        cursor: { type: 'string', required: true },
      },
    });

    await client.request({
      operation: resource,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe('https://api.example.com/repos/cli-repo/items');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'X-Shared': 'resource',
      'X-Repo': 'cli-repo',
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      query: 'query',
      variables: {
        after: 'after-1',
        repos: ['cli-repo'],
      },
    });
  });

  it('supports mapped interpolation and empty successful responses for action-style writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const response = await client.request({
      operation: {
        api: {
          endpoint: '/contacts/${{ input.email }}',
          method: 'PATCH',
          request_body: {
            FirstName: '${{ mapped.first_name }}',
          },
        },
        input: {
          email: { type: 'string', required: true },
          first_name: { type: 'string' },
        },
      },
      input: {
        email: 'alice@example.com',
      },
      context: {
        mapped: {
          first_name: 'Alice',
        },
      },
    });

    expect(response.status).toBe(204);
    expect(response.data).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe('https://api.example.com/contacts/alice%40example.com');
    expect(requestInit).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      FirstName: 'Alice',
    });
  });

  it('classifies request construction failures as validation with the plain cause', async () => {
    const client = new ExtractorClient({ integration: makeProvider('https://api.example.com') });
    const error = await client
      .request({
        operation: makeResource({
          api: { endpoint: '/items/${{ input.id }}', method: 'GET' },
          input: { id: { type: 'string', required: true } },
        }),
      })
      .catch((value) => value as BobsledRuntimeError);

    expect(error).toMatchObject({
      kind: 'validation',
      code: 'EXTRACTOR_HTTP_VALIDATION_FAILURE',
    });
    expect(error.cause).toEqual(new Error('Missing required input input.id'));
  });

  it('classifies auth handler failures as auth with the plain cause', async () => {
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'api-key', key: 'private-key' },
      }),
    });
    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value as BobsledRuntimeError);

    expect(error).toMatchObject({ kind: 'auth', code: 'EXTRACTOR_HTTP_AUTH_FAILURE' });
    expect(error.cause).toEqual(
      new Error('api-key auth requires at least one of "header" or "query_param"')
    );
  });

  it('omits undefined mapped fields from serialized action request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    await client.request({
      operation: {
        api: {
          endpoint: '/contacts/${{ input.email }}',
          method: 'PATCH',
          request_body: {
            FirstName: '${{ mapped.first_name }}',
            LastName: '${{ mapped.last_name }}',
          },
        },
        input: {
          email: { type: 'string', required: true },
          first_name: { type: 'string' },
          last_name: { type: 'string', required: true },
        },
      },
      input: {
        email: 'alice@example.com',
        last_name: 'Doe',
      },
      context: {
        mapped: {
          first_name: undefined,
          last_name: 'Doe',
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      LastName: 'Doe',
    });
  });

  it('wraps invalid JSON as a validation error with the legacy cause', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    const error = await client.request({ operation: resource }).catch((value) => value);

    expect(error).toMatchObject({
      kind: 'validation',
      code: 'EXTRACTOR_HTTP_VALIDATION_FAILURE',
      operation: 'extractor.http.request',
    });
    expect((error as BobsledRuntimeError).cause).toBeInstanceOf(ExtractorDataError);
    expect((error as BobsledRuntimeError).cause?.cause).toBeInstanceOf(SyntaxError);
  });

  it('throws ExtractorDataError when a non-empty non-JSON response is returned', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>login</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    await expectBobsledCause(
      client.request({ operation: resource }),
      'Failed to parse JSON response'
    );
  });

  it('parses opt-in JSONL responses as an array of records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"id":"charge-1"}\n{"id":"charge-2"}\n', {
        status: 200,
        headers: { 'Content-Type': 'application/jsonl' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const response = await client.request({
      operation: makeResource({
        api: { endpoint: '/charges', method: 'GET', response_format: 'jsonl' },
      }),
    });

    expect(response.data).toEqual([{ id: 'charge-1' }, { id: 'charge-2' }]);
  });

  it('rejects malformed JSONL with the record line number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"id":"charge-1"}\nnot-json\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    await expectBobsledCause(
      client.request({
        operation: makeResource({
          api: { endpoint: '/charges', method: 'GET', response_format: 'jsonl' },
        }),
      }),
      'JSONL response at line 2'
    );
  });

  it('returns a structured provider error for a final HTTP status failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('private provider diagnostic', { status: 502, statusText: 'Bad Gateway' })
        )
    );
    const client = new ExtractorClient({ integration: makeProvider('https://api.example.com') });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value);

    expect(error).toBeInstanceOf(BobsledRuntimeError);
    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
      operation: 'extractor.http.request',
      retryable: false,
      providerStatus: 502,
      message: 'The provider could not complete the operation.',
    });
    expect((error as BobsledRuntimeError).cause).toBeInstanceOf(Error);
    expect((error as BobsledRuntimeError).cause?.message).toContain('private provider diagnostic');
  });

  it('retains the exhausted retry status for structural provider classification', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response('', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', { retry: { max_retries: 1 } }),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value as BobsledRuntimeError);

    expect(error).toMatchObject({ kind: 'provider', providerStatus: 429 });
    expect(error.cause).toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])(
    'preserves a bounded, redacted final provider body after default retries (%s)',
    async (status) => {
      const token = 'retry-provider-secret';
      const finalBody = JSON.stringify({
        message: `${token} ${'provider detail '.repeat(100)}`,
      });
      const fetchMock = vi.fn(
        async () =>
          new Response(finalBody, {
            status,
            statusText: status === 429 ? 'Too Many Requests' : 'Service Unavailable',
            headers: { 'Retry-After': '0' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new ExtractorClient({
        integration: makeProvider('https://api.example.com', {
          auth: { type: 'bearer', token },
        }),
      });

      const error = await client
        .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
        .catch((value) => value as BobsledRuntimeError);

      expect(error).toMatchObject({ kind: 'provider', providerStatus: status });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(error.cause?.message).toContain('provider detail');
      expect(error.cause?.message).toContain('[REDACTED]');
      expect(error.cause?.message).not.toContain(token);
      expect(error.cause?.message.length).toBeLessThan(700);
    }
  );

  it.each([
    [
      'network',
      undefined,
      new TypeError('fetch failed'),
      'provider',
      'EXTRACTOR_HTTP_NETWORK_FAILURE',
    ],
    [
      'cancellation',
      AbortSignal.abort(new DOMException('private cancellation', 'AbortError')),
      new DOMException('private cancellation', 'AbortError'),
      'cancellation',
      'EXTRACTOR_HTTP_CANCELLED',
    ],
  ] as const)(
    'preserves the native %s cause in a structured HTTP error',
    async (_scenario, signal, cause, kind, code) => {
      const expectedCause = signal?.reason ?? cause;
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(expectedCause));
      const client = new ExtractorClient({
        integration: makeProvider('https://api.example.com', { retry: { max_retries: 0 } }),
      });

      const error = await client
        .request({
          operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }),
          signal,
        })
        .catch((value) => value);

      expect(error).toMatchObject({ kind, code, operation: 'extractor.http.request' });
      expect((error as BobsledRuntimeError).cause).toBe(expectedCause);
    }
  );

  it('rejects a response whose declared body exceeds the API cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value);

    expect(error).toMatchObject({
      kind: 'validation',
      code: 'EXTRACTOR_HTTP_RESPONSE_BODY_LIMIT',
    });
    expect((error as BobsledRuntimeError).cause).toBeInstanceOf(ResponseBodyLimitError);
    expect((error as BobsledRuntimeError).cause).toMatchObject({ maxBytes: 64 * 1024 * 1024 });
  });

  it('applies a smaller response body limit for one request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-length': '11' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    await expectBobsledCause(
      client.request({
        operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }),
        responseBodyLimitBytes: 10,
      }),
      '10-byte response body limit'
    );
  });

  it('keeps the request deadline active while reading the response body', async () => {
    const fetchMock = vi.fn().mockImplementation(
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
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', { timeout_ms: 20 }),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value);

    expect(error).toMatchObject({ kind: 'timeout', code: 'EXTRACTOR_HTTP_TIMEOUT' });
    expect((error as BobsledRuntimeError).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it('wraps an exhausted retry deadline with its exact timeout cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 429, statusText: 'Too Many Requests' }))
    );
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        timeout_ms: 20,
        retry: { max_retries: 1, backoff: 'fixed' },
      }),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value);

    expect(error).toMatchObject({ kind: 'timeout', code: 'EXTRACTOR_HTTP_TIMEOUT' });
    expect((error as BobsledRuntimeError).cause).toBeInstanceOf(RateLimitTimeoutError);
  });

  it('appends query params after input templating and rejects cross-origin overrides', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
      cliInputs: { repo: 'my repo' },
    });

    const resource = makeResource({
      api: {
        endpoint: '/repos/${{ input.repo }}/items',
        method: 'GET',
      },
      input: {
        repo: { type: 'string', required: true },
      },
    });

    await client.request({
      operation: resource,
      queryParams: {
        q: 'name = "my repo"',
        limit: 10,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/repos/my%20repo/items?q=name+%3D+%22my+repo%22&limit=10',
      expect.any(Object)
    );

    await expectBobsledCause(
      client.request({
        operation: resource,
        url: 'https://evil.example.com/items',
      }),
      'does not match integration origin'
    );
  });

  it('routes declared request parameters through path, headers, query, and body metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({ integration: makeProvider('https://api.example.com') });
    const resource = makeResource({
      api: {
        endpoint: '/pages/${{ input.path_cursor }}',
        method: 'POST',
        headers: { 'X-Page-Cursor': '${{ input.header_cursor }}' },
        query_params: { cursor: '${{ input.query_cursor }}' },
        request_body: { cursor: '${{ input.body_cursor }}' },
      },
      input: {
        path_cursor: { type: 'string' },
        header_cursor: { type: 'string' },
        query_cursor: { type: 'string' },
        body_cursor: { type: 'string' },
      },
    });

    await client.request({
      operation: resource,
      queryParams: {
        path_cursor: 'path/2',
        header_cursor: 'header-2',
        query_cursor: 'query-2',
        body_cursor: 'body-2',
      },
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe('https://api.example.com/pages/path%2F2?cursor=query-2');
    expect(requestInit.headers).toMatchObject({ 'X-Page-Cursor': 'header-2' });
    expect(JSON.parse(String(requestInit.body))).toEqual({ cursor: 'body-2' });
  });

  it('follows same-origin redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: 'https://api.example.com/items/moved' },
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    const result = await client.request({ operation: resource });
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.example.com/items/moved');
  });

  it('blocks cross-origin redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example.com/steal' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    await expectBobsledCause(client.request({ operation: resource }), 'cross-origin redirect');
  });

  it('blocks private-host redirects inside the redirect loop', async () => {
    const originalAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    try {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://127.0.0.1/items/moved' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const client = new ExtractorClient({
        integration: makeProvider('https://127.0.0.1'),
      });

      const doFetch = (
        client as unknown as {
          doFetch: (
            request: {
              url: string;
              method: string;
              headers: Record<string, string>;
              body?: string;
              timeout_ms: number;
            },
            resolvedBaseUrl: string
          ) => Promise<Response>;
        }
      ).doFetch.bind(client);

      await expect(
        doFetch(
          {
            url: 'https://127.0.0.1/items',
            method: 'GET',
            headers: {},
            timeout_ms: 30_000,
          },
          'https://127.0.0.1'
        )
      ).rejects.toThrow('private/internal host');
    } finally {
      if (originalAllowPrivateHosts !== undefined) {
        process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalAllowPrivateHosts;
      }
    }
  });

  it('uses env-templated integration base URLs for requests and same-origin checks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://${{ env.SUBDOMAIN }}.example.com/api/v1', {
        auth_env_vars: ['SUBDOMAIN'],
      }),
      env: {
        SUBDOMAIN: 'tenant-1',
      },
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    await client.request({ operation: resource });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tenant-1.example.com/api/v1/items',
      expect.any(Object)
    );

    await expectBobsledCause(
      client.request({
        operation: resource,
        url: 'https://evil.example.com/items',
      }),
      'Request URL origin "https://evil.example.com" does not match integration origin "https://tenant-1.example.com"'
    );
  });

  it('throws after too many redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { Location: 'https://api.example.com/loop' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com'),
    });

    const resource = makeResource({
      api: { endpoint: '/items', method: 'GET' },
    });

    await expectBobsledCause(client.request({ operation: resource }), 'Too many redirects');
  });

  it('redacts query-string credentials in request errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://business-api.tiktok.com/open_api/v1.3'),
    });

    const resource = makeResource({
      api: {
        endpoint: '/oauth/advertiser/get',
        method: 'GET',
        query_params: {
          app_id: 'public-app-id',
          secret: 'super-secret',
        },
      },
    });

    const error = await client.request({ operation: resource }).catch((err) => err as Error);

    expect(error.message).toBe('The provider could not complete the operation.');
    expect((error as BobsledRuntimeError).cause?.message).toContain(
      'https://business-api.tiktok.com/open_api/v1.3/oauth/advertiser/get?[redacted]'
    );
    expect((error as BobsledRuntimeError).cause?.message).not.toContain('public-app-id');
    expect((error as BobsledRuntimeError).cause?.message).not.toContain('super-secret');
  });

  it('surfaces the API response body in request errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid API Key' }), {
        status: 401,
        statusText: 'Unauthorized',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({ integration: makeProvider('https://api.example.com') });
    const resource = makeResource({ api: { endpoint: '/campaigns', method: 'GET' } });

    const error = await client.request({ operation: resource }).catch((err) => err as Error);

    expect(error.message).toBe('The provider could not complete the operation.');
    expect((error as BobsledRuntimeError).cause?.message).toContain('401 Unauthorized');
    expect((error as BobsledRuntimeError).cause?.message).toContain('Invalid API Key');
  });

  it('redacts reflected outbound credentials from API error bodies', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            authorization: 'Bearer reflected-bearer-secret',
            api_key: 'reflected-header-key',
            query_secret: 'reflected-query-secret',
          }),
          {
            status: 401,
            statusText: 'Unauthorized',
          }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'bearer', token: 'reflected-bearer-secret' },
      }),
    });
    const resource = makeResource({
      api: {
        endpoint: '/campaigns',
        method: 'GET',
        query_params: { secret: 'reflected-query-secret' },
      },
    });

    const error = await client
      .request({
        operation: resource,
        headers: { 'X-Api-Key': 'reflected-header-key' },
      })
      .catch((err) => err as Error);

    expect(error.message).toBe('The provider could not complete the operation.');
    expect((error as BobsledRuntimeError).cause?.message).toContain('[REDACTED]');
    expect((error as BobsledRuntimeError).cause?.message).not.toContain('reflected-bearer-secret');
    expect((error as BobsledRuntimeError).cause?.message).not.toContain('reflected-header-key');
    expect((error as BobsledRuntimeError).cause?.message).not.toContain('reflected-query-secret');
  });

  it('attaches the redacted provider body to a failed response without enumerating it', async () => {
    const body = {
      error: { code: 'AutomationIsActive', message: 'Pause the automation first.' },
      echoed: 'Bearer reflected-bearer-secret',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(body), { status: 403, statusText: 'Forbidden' })
      )
    );
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'bearer', token: 'reflected-bearer-secret' },
      }),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'PUT' } }) })
      .catch((value) => value as BobsledRuntimeError);

    expect(error).toMatchObject({ kind: 'provider', providerStatus: 403 });
    const attached = readProviderResponseBody(error);
    expect(JSON.parse(attached!)).toEqual({ ...body, echoed: '[REDACTED]' });
    expect(Object.keys(error.cause!)).not.toContain('providerResponseBody');
    expect(JSON.stringify(error.cause)).not.toContain('AutomationIsActive');
  });

  it('attaches the redacted final body when retries are exhausted', async () => {
    const token = 'retry-provider-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: `Slow down ${token}` }), {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'Retry-After': '0' },
          })
      )
    );
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'bearer', token },
        retry: { max_retries: 1 },
      }),
    });

    const error = await client
      .request({ operation: makeResource({ api: { endpoint: '/items', method: 'GET' } }) })
      .catch((value) => value as BobsledRuntimeError);

    expect(error).toMatchObject({ kind: 'provider', providerStatus: 429 });
    expect(JSON.parse(readProviderResponseBody(error)!)).toEqual({
      message: 'Slow down [REDACTED]',
    });
  });

  it('truncates oversized error response bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('x'.repeat(2000), { status: 500, statusText: 'Internal Server Error' })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ExtractorClient({ integration: makeProvider('https://api.example.com') });
    const resource = makeResource({ api: { endpoint: '/boom', method: 'GET' } });

    const error = await client.request({ operation: resource }).catch((err) => err as Error);

    expect(error.message).toBe('The provider could not complete the operation.');
    expect((error as BobsledRuntimeError).cause?.message).toContain('500 Internal Server Error');
    expect((error as BobsledRuntimeError).cause?.message).toContain('…');
    // Body capped at 500 chars, so the whole message stays well under the 2000-char body.
    expect((error as BobsledRuntimeError).cause?.message.length).toBeLessThan(700);
  });
});
