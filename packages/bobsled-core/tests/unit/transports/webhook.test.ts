import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeWebhookAction } from '../../../src/lib/transports/webhook.js';

import type { Action } from '../../../src/lib/action-registry.js';

function makeWebhookAction(): Action {
  return {
    name: 'notify_complete',
    qualifiedName: 'notify_complete',
    integration: undefined,
    transport: 'webhook',
    tags: ['notifications'],
    description: 'Notify an external system',
    inputs: {
      entity_id: { type: 'string', required: true },
      completed_at: { type: 'string' },
    },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'webhook',
      auth_env_vars: ['WEBHOOK_HOST', 'WEBHOOK_TOKEN'],
      name: 'notify_complete',
      tags: ['notifications'],
      description: 'Notify an external system',
      webhook: {
        url: 'https://${{ env.WEBHOOK_HOST }}/notify',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ${{ env.WEBHOOK_TOKEN }}',
        },
        request_body: {
          id: '${{ input.entity_id }}',
          completed_at: '${{ input.completed_at }}',
        },
      },
      input: {
        entity_id: { type: 'string', required: true },
        completed_at: { type: 'string' },
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/notify_complete.yml',
  };
}

describe('executeWebhookAction', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends webhook requests after interpolation and SSRF checks', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));

    const result = await executeWebhookAction(
      makeWebhookAction(),
      {
        entity_id: 'ent_123',
        completed_at: '2026-04-23T12:00:00Z',
      },
      undefined,
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
      })
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      id: 'ent_123',
      completed_at: '2026-04-23T12:00:00Z',
    });
    expect(result.status).toBe('success');
  });

  it('skips network execution during dry-run', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');
    const fetch = vi.fn();
    const resolveHost = vi.fn();

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      { dryRun: true },
      {
        fetch,
        checkHost: () => false,
        resolveHost,
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHost).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.preview).toEqual({
      action: 'notify_complete',
      operation: 'POST',
      target_host: 'hooks.example.com',
      input_fields: ['entity_id'],
      effect: 'Notify an external system',
      request: {
        method: 'POST',
        input_locations: { entity_id: ['body'] },
        whole_input_locations: [],
      },
    });
    expect(JSON.stringify(result.preview)).not.toContain('secret-token');
    expect(JSON.stringify(result.preview)).not.toContain('ent_123');
  });

  it('reports URL path and query inputs separately without changing the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('expected a webhook action');
    action.spec = {
      ...action.spec,
      webhook: {
        ...action.spec.webhook,
        url: 'https://hooks.example.com/items/${{ input.entity_id }}?at=${{ input.completed_at }}',
        headers: { 'X-Entity': '${{ input.entity_id }}' },
      },
    };
    const inputs = { entity_id: 'ent-1', completed_at: '2026-10-11' };

    const preview = await executeWebhookAction(
      action,
      inputs,
      { dryRun: true, secrets: {} },
      {
        checkHost: () => false,
      }
    );
    await executeWebhookAction(
      action,
      inputs,
      { secrets: {} },
      {
        fetch,
        checkHost: () => false,
        resolveHost: vi.fn(),
      }
    );

    expect(preview.preview?.request).toEqual({
      method: 'POST',
      input_locations: { entity_id: ['path', 'header', 'body'], completed_at: ['query', 'body'] },
      whole_input_locations: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://hooks.example.com/items/ent-1?at=2026-10-11');
  });

  it('drops inputs that a delimiter-carrying value moves into the fragment', async () => {
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('expected a webhook action');
    action.spec = {
      ...action.spec,
      webhook: {
        ...action.spec.webhook,
        url: 'https://hooks.example.com/items/${{ input.entity_id }}/${{ input.completed_at }}',
        headers: {},
        request_body: undefined,
      },
    };

    const preview = await executeWebhookAction(
      action,
      { entity_id: '#', completed_at: 'token' },
      { dryRun: true, secrets: {} },
      { checkHost: () => false }
    );

    expect(preview.preview?.request?.input_locations).toEqual({});
  });

  it('reports an input that chooses the webhook host as origin and ignores the fragment', async () => {
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('expected a webhook action');
    action.spec = {
      ...action.spec,
      webhook: {
        ...action.spec.webhook,
        url: 'https://${{ input.completed_at }}.example.com/items/${{ input.entity_id }}#${{ input.entity_id }}',
        headers: {},
        request_body: undefined,
      },
    };

    const preview = await executeWebhookAction(
      action,
      { entity_id: 'ent-1', completed_at: 'tenant' },
      { dryRun: true, secrets: {} },
      { checkHost: () => false }
    );

    expect(preview.preview?.request).toEqual({
      method: 'POST',
      input_locations: { completed_at: ['origin'], entity_id: ['path'] },
      whole_input_locations: [],
    });
  });

  it.each([
    ['a plain id', 'ent-1', ['path']],
    ['an id that starts a query string', '?token=x', ['query']],
    ['an id that is split by a fragment', 'a#b', ['other']],
  ])('classifies %s in the webhook path by where it lands', async (_case, id, locations) => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('expected a webhook action');
    action.spec = {
      ...action.spec,
      webhook: {
        ...action.spec.webhook,
        url: 'https://hooks.example.com/items/${{ input.entity_id }}',
        headers: {},
        request_body: undefined,
      },
    };

    const preview = await executeWebhookAction(
      action,
      { entity_id: id },
      { dryRun: true, secrets: {} },
      { checkHost: () => false }
    );
    await executeWebhookAction(
      action,
      { entity_id: id },
      { secrets: {} },
      { fetch, checkHost: () => false, resolveHost: vi.fn() }
    );

    expect(preview.preview?.request?.input_locations).toEqual({ entity_id: locations });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://hooks.example.com/items/${id}`);
  });

  it('uses request-scoped secrets without changing process.env', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      {
        secrets: {
          WEBHOOK_HOST: 'hooks.example.com',
          WEBHOOK_TOKEN: 'request-only-token',
        },
      },
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer request-only-token' }),
      })
    );
    expect(process.env.WEBHOOK_TOKEN).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('returns cancelled when the caller aborts the request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      {
        secrets: {
          WEBHOOK_HOST: 'hooks.example.com',
          WEBHOOK_TOKEN: 'request-only-token',
        },
        signal: controller.signal,
      },
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('rejects an invalid timeout before sending the webhook', async () => {
    const fetch = vi.fn();

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      {
        secrets: {
          WEBHOOK_HOST: 'hooks.example.com',
          WEBHOOK_TOKEN: 'request-only-token',
        },
        limits: { timeoutMs: 60_001 },
      },
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ code: 'validation_error', retryable: false });
    expect(result.error?.message).toContain('timeoutMs');
  });

  it('omits sparse optional payload fields during network execution', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      undefined,
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      id: 'ent_123',
    });
    expect(result.status).toBe('success');
  });

  it('omits the request body entirely when sparse containers collapse to empty', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const action = makeWebhookAction();
    action.spec.webhook.request_body = {
      metadata: {
        completed_at: '${{ input.completed_at }}',
      },
    };

    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    const result = await executeWebhookAction(action, { entity_id: 'ent_123' }, undefined, {
      fetch,
      checkHost: () => false,
      resolveHost: async () => undefined,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
        },
        body: undefined,
      })
    );
    expect(result.status).toBe('success');
  });

  it('maps non-2xx responses to action errors', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      undefined,
      {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response('', { status: 429, statusText: 'Too Many Requests' })),
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      provider_status: 429,
    });
  });

  it.each([
    [401, 'auth_error', 'The external service rejected authentication.'],
    [403, 'permission_denied', 'The external service refused the Action.'],
  ] as const)(
    'maps a %i response to %s with the provider status and message',
    async (status, code, message) => {
      vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
      vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

      const result = await executeWebhookAction(
        makeWebhookAction(),
        { entity_id: 'ent_123' },
        { safeErrors: true },
        {
          fetch: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'Pause the automation first.' } }), {
              status,
              headers: { 'Content-Type': 'application/json' },
            })
          ),
          checkHost: () => false,
          resolveHost: async () => undefined,
        }
      );

      expect(result.error).toEqual({
        code,
        message,
        retryable: false,
        provider_status: status,
        provider_message: 'Pause the automation first.',
      });
    }
  );

  it('redacts interpolated credentials reflected in a webhook provider message', async () => {
    const token = 'hook"tok/en+1';
    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      {
        secrets: { WEBHOOK_HOST: 'hooks.example.com', WEBHOOK_TOKEN: token },
        safeErrors: true,
      },
      {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              message: `Token ${token} / ${encodeURIComponent(token)} lacks scope.`,
            }),
            { status: 403 }
          )
        ),
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(result.error).toMatchObject({
      code: 'permission_denied',
      provider_status: 403,
      provider_message: 'Token [REDACTED] / [REDACTED] lacks scope.',
    });
    expect(JSON.stringify(result)).not.toContain('tok/en');
  });

  it.each([
    ['a 5xx JSON body', 500, JSON.stringify({ message: 'Database host db-7 is down.' })],
    ['an HTML 4xx body', 403, '<html><body>Forbidden</body></html>'],
  ])('returns no provider message for %s', async (_label, status, body) => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      { safeErrors: true },
      {
        fetch: vi.fn().mockResolvedValue(new Response(body, { status })),
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(result.error).toMatchObject({ provider_status: status });
    expect(result.error).not.toHaveProperty('provider_message');
    expect(JSON.stringify(result)).not.toContain('db-7');
  });

  it('hides webhook transport details in safe server mode', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      { safeErrors: true },
      {
        fetch: vi
          .fn()
          .mockRejectedValue(
            new Error('connect failed for https://hooks.example.com/secret-token')
          ),
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(result.error).toMatchObject({ code: 'unknown', message: 'The Action failed.' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('hooks.example.com');
  });

  it('fails fast when a webhook body references missing mapped values', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const action = makeWebhookAction();
    action.spec.webhook.request_body = {
      copied_value: '${{ mapped.first_name }}',
    };

    const fetch = vi.fn();
    const result = await executeWebhookAction(action, { entity_id: 'ent_123' }, undefined, {
      fetch,
      checkHost: () => false,
      resolveHost: async () => undefined,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('validation_error');
    expect(result.error?.message).toContain('mapped.first_name');
  });

  it('rejects non-https webhook URLs after interpolation', async () => {
    vi.stubEnv('WEBHOOK_URL', 'http://hooks.example.com/notify');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const action = makeWebhookAction();
    action.spec.auth_env_vars = ['WEBHOOK_URL', 'WEBHOOK_TOKEN'];
    action.spec.webhook.url = '${{ env.WEBHOOK_URL }}';

    const fetch = vi.fn();
    const result = await executeWebhookAction(action, { entity_id: 'ent_123' }, undefined, {
      fetch,
      checkHost: () => false,
      resolveHost: async () => undefined,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('validation_error');
    expect(result.error?.message).toContain('Webhook URL must use HTTPS');
  });

  it('classifies private-host webhook targets as validation errors', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const fetch = vi.fn();
    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      undefined,
      {
        fetch,
        checkHost: () => true,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      retryable: false,
    });
  });

  it('classifies invalid interpolated header values as validation errors', async () => {
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'bad\ntoken');

    const fetch = vi.fn();
    const result = await executeWebhookAction(
      makeWebhookAction(),
      { entity_id: 'ent_123' },
      undefined,
      {
        fetch,
        checkHost: () => false,
        resolveHost: async () => undefined,
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      retryable: false,
    });
    expect(result.error?.message).toContain('Header values must not contain control characters');
  });

  it('aborts hanging webhook requests when the timeout elapses', async () => {
    vi.useFakeTimers();
    vi.stubEnv('WEBHOOK_HOST', 'hooks.example.com');
    vi.stubEnv('WEBHOOK_TOKEN', 'secret-token');

    const fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      });
    });

    const pending = executeWebhookAction(makeWebhookAction(), { entity_id: 'ent_123' }, undefined, {
      fetch,
      checkHost: () => false,
      resolveHost: async () => undefined,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    const result = await pending;
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });
});

it.each(['env', 'secrets'])(
  'rejects undeclared webhook %s names before any network request',
  async (namespace) => {
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('Expected webhook action');
    action.spec.auth_env_vars = [];
    action.spec.webhook.url = 'https://hooks.example.com/notify';
    action.spec.webhook.headers = { Authorization: '${{ ' + namespace + '.UNRELATED_SECRET }}' };
    const fetch = vi.fn();
    const resolveHost = vi.fn();
    const result = await executeWebhookAction(
      action,
      { entity_id: 'test' },
      { secrets: { UNRELATED_SECRET: 'must-not-appear' } },
      { fetch, resolveHost, checkHost: () => false }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'validation_error',
        message:
          'Undeclared environment variable: UNRELATED_SECRET. Add UNRELATED_SECRET to auth_env_vars.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHost).not.toHaveBeenCalled();
  }
);

it.each(['secrets', 'env'])(
  'scopes webhook host declarations to the secrets map (%s)',
  async (namespace) => {
    const action = makeWebhookAction();
    if (action.spec.transport !== 'webhook') throw new Error('Expected webhook action');
    action.spec.auth_env_vars = [];
    action.spec.webhook.url = 'https://hooks.example.com/notify';
    action.spec.webhook.headers = { Authorization: '${{ ' + namespace + '.HOST_TOKEN }}' };
    const fetch = vi.fn(async () => new Response('{}'));
    const result = await executeWebhookAction(
      action,
      { entity_id: 'test' },
      { secrets: { HOST_TOKEN: 'host-canary' }, declaredSecretNames: ['HOST_TOKEN'] },
      { fetch, resolveHost: async () => undefined, checkHost: () => false }
    );
    expect(result.status).toBe(namespace === 'secrets' ? 'success' : 'failed');
    expect(fetch).toHaveBeenCalledTimes(namespace === 'secrets' ? 1 : 0);
  }
);

it.each([
  ['a declared host name', ['GITHUB_TOKEN'], 'success', 1],
  ['an undeclared name', [], 'failed', 0],
])('resolves a reserved webhook secret only for %s', async (_case, names, status, sent) => {
  const action = makeWebhookAction();
  if (action.spec.transport !== 'webhook') throw new Error('Expected webhook action');
  action.spec.auth_env_vars = ['GITHUB_TOKEN'];
  action.spec.webhook.url = 'https://hooks.example.com/notify';
  action.spec.webhook.headers = { Authorization: '${{ secrets.GITHUB_TOKEN }}' };
  const fetch = vi.fn(async () => new Response('{}'));
  const result = await executeWebhookAction(
    action,
    { entity_id: 'test' },
    { secrets: { GITHUB_TOKEN: 'host-canary' }, declaredSecretNames: names },
    { fetch, resolveHost: async () => undefined, checkHost: () => false }
  );
  expect(result.status).toBe(status);
  expect(fetch).toHaveBeenCalledTimes(sent);
  expect(JSON.stringify(result)).not.toContain('host-canary');
});
