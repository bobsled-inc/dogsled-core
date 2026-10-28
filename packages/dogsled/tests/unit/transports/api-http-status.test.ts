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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    [403, 'auth_error', false],
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
    expect(result.error).toMatchObject({ code, retryable });
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

  it('keeps upstream details out of safe errors while reporting the status code', async () => {
    vi.stubGlobal('fetch', respondWith(404));

    const result = await executeApiAction(makeAction(), inputs, {
      resolvedIntegration: makeIntegration(),
      safeErrors: true,
    });

    expect(result.error).toEqual({
      code: 'not_found',
      message: 'The external target was not found.',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret.example');
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
