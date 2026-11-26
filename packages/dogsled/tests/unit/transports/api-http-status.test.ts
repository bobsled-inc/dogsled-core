import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeApiAction } from '../../../src/lib/transports/api.js';

import type { HttpTransportConfig } from '@bobsled-inc/extractor/core';
import type { IntegrationSpec } from '@bobsled-inc/extractor/extractor';
import type { Action } from '../../../src/lib/action-registry.js';

const inputs = { id: '42', name: 'Alice' };

function makeAction(): Action {
  return {
    name: 'update_contact',
    qualifiedName: 'crm/update_contact',
    integration: 'crm',
    transport: 'api',
    tags: [],
    description: 'Update a contact',
    inputs: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'update_contact',
      integration: 'crm',
      tags: [],
      description: 'Update a contact',
      api: {
        endpoint: '/contacts/${{ input.id }}',
        method: 'PATCH',
        request_body: { name: '${{ mapped.name }}' },
      },
      input: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      field_mapping: {
        fields: { id: 'id', name: 'name' },
        unmapped_fields: 'ignore',
      },
      activate: {
        operation: 'update',
        identity: { fields: ['id'], strategy: 'external_id' },
        result_path: '$',
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/update_contact.yml',
  };
}

function makeIntegration(transport: Partial<HttpTransportConfig> = {}): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'crm',
    transport: {
      type: 'http',
      base_url: 'https://api.example.com',
      auth: { type: 'none' },
      retry: { max_retries: 0 },
      ...transport,
    },
  };
}

function respondWith(status: number, headers: Record<string, string> = {}) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'upstream detail https://secret.example/token' }), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
  );
}

function respondJson(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

function hangUntilAborted() {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
}

describe('executeApiAction through the real ExtractorClient', () => {
  beforeEach(() => {
    vi.stubEnv('DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['declared', { secrets: undefined }],
    ['host-supplied', { secrets: { ACME_TOKEN: 'acme-planner-value' } }],
  ])('redacts a %s credential from a request planning error', async (_label, { secrets }) => {
    const credential = 'acme-planner-value';
    vi.stubEnv('ACME_TOKEN', credential);

    const result = await executeApiAction(
      makeAction(),
      inputs,
      {
        resolvedIntegration: { ...makeIntegration(), auth_env_vars: ['ACME_TOKEN'] },
        ...(secrets ? { secrets } : {}),
      },
      {
        buildRequest: async () => {
          throw new Error(`Cannot plan ${credential} here`);
        },
      }
    );

    expect(result.error).toEqual({
      code: 'validation_error',
      message: 'Cannot plan [REDACTED] here',
      retryable: false,
    });
  });

  it('sends the request and succeeds on a 2xx response', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: '42' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
    });

    expect(result).toMatchObject({ status: 'success', target_record_id: '42' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/contacts/42');
  });

  it.each([
    [400, 'validation_error', false],
    [401, 'auth_error', false],
    [403, 'permission_denied', false],
    [404, 'not_found', false],
    [408, 'timeout', true],
    [409, 'conflict', false],
    [422, 'validation_error', false],
    [429, 'rate_limited', true],
    [500, 'server_error', true],
    [502, 'server_error', true],
    [503, 'server_error', true],
  ] as const)('classifies an HTTP %i response as %s', async (status, code, retryable) => {
    const fetchMock = respondWith(status);
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code, retryable, provider_status: status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies a status that exhausts the client retry budget by that status', async () => {
    const fetchMock = respondWith(503, { 'Retry-After': '0' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ retry: { max_retries: 2 } }),
    });

    expect(result.error).toMatchObject({ code: 'server_error', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps upstream details out of the safe message while reporting the status code', async () => {
    vi.stubGlobal('fetch', respondWith(404));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'not_found',
      message: 'The external target was not found.',
      retryable: false,
      provider_status: 404,
      provider_message: 'upstream detail https://secret.example/token',
    });
    expect(JSON.stringify(result)).not.toContain('api.example.com');
  });

  it('keeps every upstream detail out of a safe server error', async () => {
    vi.stubGlobal('fetch', respondWith(503));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'server_error',
      message: 'The external service failed.',
      retryable: true,
      provider_status: 503,
    });
    expect(JSON.stringify(result)).not.toContain('secret.example');
  });

  it('reports a rejected credential as a non-retryable auth error with its status', async () => {
    vi.stubGlobal('fetch', respondJson(401, { error: { message: 'Invalid API key.' } }));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'auth_error',
      message: 'The external service rejected authentication.',
      retryable: false,
      provider_status: 401,
      provider_message: 'Invalid API key.',
    });
  });

  it("separates a refused Action from a credential failure and keeps the provider's reason", async () => {
    vi.stubGlobal(
      'fetch',
      respondJson(403, {
        error: {
          code: 'AutomationIsActive',
          message: 'AutomationIsActive: pause the automation, update it, and resume',
        },
      })
    );

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.error).toEqual({
      code: 'permission_denied',
      message: 'The external service refused the Action.',
      retryable: false,
      provider_status: 403,
      provider_message: 'AutomationIsActive: pause the automation, update it, and resume',
    });
  });

  it.each([
    ['request-scoped secret', 'secrets'],
    ['declared environment variable', 'env'],
  ] as const)('redacts a %s reflected in the provider message', async (_label, namespace) => {
    const token = 'acme"tok/en+1';
    const fetchMock = respondJson(403, {
      error: {
        message: `Token ${token} (${encodeURIComponent(token)}) cannot update an active automation.`,
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    if (namespace === 'env') vi.stubEnv('ACME_TOKEN', token);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: {
        ...makeIntegration({
          auth: { type: 'bearer', token: `\${{ ${namespace}.ACME_TOKEN }}` },
        }),
        ...(namespace === 'env' ? { auth_env_vars: ['ACME_TOKEN'] } : {}),
      } as IntegrationSpec,
      ...(namespace === 'secrets'
        ? { secrets: { ACME_TOKEN: token }, declaredSecretNames: ['ACME_TOKEN'] }
        : {}),
      safeErrors: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.error).toMatchObject({
      code: 'permission_denied',
      provider_status: 403,
      provider_message: 'Token [REDACTED] ([REDACTED]) cannot update an active automation.',
    });
    expect(JSON.stringify(result)).not.toContain('tok/en');
    expect(JSON.stringify(result)).not.toContain('tok%2Fen');
  });

  it('caps an oversized provider message', async () => {
    vi.stubGlobal('fetch', respondJson(409, { message: `Conflict ${'detail '.repeat(200)}` }));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error?.code).toBe('conflict');
    expect(Array.from(result.error?.provider_message ?? '')).toHaveLength(300);
    expect(result.error?.provider_message?.endsWith('…')).toBe(true);
  });

  it.each([
    ['an HTML body', 'text/html', '<html><body><h1>403 Forbidden</h1></body></html>'],
    ['a plain-text body', 'text/plain', 'Forbidden'],
    ['an empty body', 'application/json', ''],
  ])('returns no provider message for %s', async (_label, contentType, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(body, { status: 403, headers: { 'Content-Type': contentType } })
      )
    );

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'permission_denied',
      message: 'The external service refused the Action.',
      retryable: false,
      provider_status: 403,
    });
  });

  it('returns no provider message for a 5xx JSON body', async () => {
    vi.stubGlobal('fetch', respondJson(500, { error: { message: 'Database host db-7 is down.' } }));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'server_error',
      message: 'The external service failed.',
      retryable: true,
      provider_status: 500,
    });
  });

  it('adds the provider message without changing the detailed message outside safe mode', async () => {
    vi.stubGlobal('fetch', respondJson(403, { message: 'Pause the automation first.' }));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
    });

    expect(result.error).toMatchObject({
      code: 'permission_denied',
      message: 'The provider could not complete the operation.',
      provider_status: 403,
      provider_message: 'Pause the automation first.',
    });
  });

  it('previews a dry run without sending a request that the provider would refuse', async () => {
    const fetchMock = respondJson(403, { message: 'Pause the automation first.' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      dryRun: true,
      safeErrors: true,
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'custom-token',
      {
        type: 'custom-token',
        token_url: 'https://auth.example.com/custom-token-mint-failure',
      },
    ],
    [
      'oauth2',
      {
        type: 'oauth2',
        grant_type: 'client_credentials',
        token_url: 'https://auth.example.com/oauth2-mint-failure',
        client_id: 'client',
        client_secret: 'secret',
      },
    ],
  ] as const)(
    'classifies a %s token-mint failure as a non-retryable auth error',
    async (_type, auth) => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url).startsWith('https://auth.example.com/')) {
          return new Response('{"error":"invalid_client"}', { status: 401 });
        }
        return new Response('{}', { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await executeApiAction(makeAction(), inputs, {
        resolvedIntegration: makeIntegration({ auth }),
        safeErrors: true,
      });

      expect(result.error).toEqual({
        code: 'auth_error',
        message: 'The external service rejected authentication.',
        retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(auth.token_url);
    }
  );

  it('classifies an exhausted throttled custom-token mint as a retryable rate limit', async () => {
    const tokenUrl = 'https://auth.example.com/custom-token-throttled';
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === tokenUrl) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({
        auth: { type: 'custom-token', token_url: tokenUrl },
        retry: { max_retries: 2 },
      }),
      safeErrors: true,
    });

    expect(result.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      provider_status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === tokenUrl)).toBe(true);
  });

  it('classifies an integration request deadline as a retryable timeout', async () => {
    vi.stubGlobal('fetch', hangUntilAborted());

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ timeout_ms: 20 }),
    });

    expect(result.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('classifies the Action timeout limit as a retryable timeout', async () => {
    vi.stubGlobal('fetch', hangUntilAborted());

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      limits: { timeoutMs: 20 },
    });

    expect(result.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('does not retry an Action attempt that timed out', async () => {
    const fetchMock = hangUntilAborted();
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ timeout_ms: 20, retry: { max_retries: 2 } }),
    });

    expect(result.error).toMatchObject({ code: 'timeout', retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry an Action on HTTP 504 unless the integration lists it', async () => {
    const fetchMock = respondWith(504);
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ retry: { max_retries: 2 } }),
    });

    expect(result.error).toMatchObject({
      code: 'server_error',
      retryable: true,
      provider_status: 504,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries an Action when the provider throttles it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '42' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ retry: { max_retries: 2 } }),
    });

    expect(result).toMatchObject({ status: 'success', target_record_id: '42' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a connection that kept resetting as a retryable network error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration({ retry: { max_retries: 1 } }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.error).toMatchObject({ code: 'network_error', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a caller abort as a cancellation', async () => {
    const controller = new AbortController();
    const hang = hangUntilAborted();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const pending = hang(url, init);
        controller.abort();
        return pending;
      })
    );

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      signal: controller.signal,
    });

    expect(result.error).toMatchObject({ code: 'cancelled', retryable: false });
  });
});
