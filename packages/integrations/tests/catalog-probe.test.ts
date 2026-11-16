import { describe, expect, it, vi } from 'vitest';

import {
  buildCatalogManifest,
  probeApiResource,
  type CatalogProbeResource,
  type CatalogProbeSource,
  type CatalogProbeTransport,
  type ProbeApiResourceExecutorRequest,
} from '../src/catalog/index.js';

const notionSecrets = { NOTION_API_TOKEN: 'notion-secret-canary' };

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function externalSource(baseUrl = 'https://api.example.test/v1'): CatalogProbeSource {
  return {
    name: 'example',
    default_transport: 'rest',
    transports: {
      rest: {
        id: 'rest',
        type: 'http',
        base_url: baseUrl,
        headers: { 'User-Agent': 'probe-test' },
        auth: { type: 'none' },
      },
    },
  };
}

function externalResource(endpoint = '/items/${{ input.id }}'): CatalogProbeResource {
  return {
    name: 'items',
    via: 'rest',
    input: {
      id: { type: 'string', required: true },
      q: { type: 'string', required: true },
    },
    api: {
      endpoint,
      method: 'GET',
      query_params: { q: '${{ input.q }}' },
    },
  };
}

function requestSnapshot(request: ProbeApiResourceExecutorRequest): unknown {
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    timeout_ms: request.timeout_ms,
    phase: request.phase,
  };
}

describe('catalog-only API resource probe', () => {
  it('plans the Notion REST POST with catalog headers and body', async () => {
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      expect(request.method).toBe('POST');
      expect(request.headers['Notion-Version']).toBe('2022-06-28');
      expect(request.headers['User-Agent']).toBe('bobsled-core-extractor');
      expect(request.headers['Content-Type']).toBe('application/json');
      expect(request.headers.Authorization).toBe(`Bearer ${notionSecrets.NOTION_API_TOKEN}`);
      expect(JSON.parse(request.body ?? '')).toEqual({
        filter: { property: 'object', value: 'page' },
        page_size: 100,
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
      });
      return response('{"results":[],"next_cursor":"ignored"}');
    });

    const result = await probeApiResource({
      source: 'notion',
      resource: 'pages',
      transport: 'rest',
      secrets: notionSecrets,
      executor,
    });

    expect(result).toMatchObject({ ok: true, response: { status: 200, truncated: false } });
    expect(
      new TextDecoder().decode(result.ok ? result.response.responseBytes : new Uint8Array())
    ).toContain('next_cursor');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('requires the injected executor and passes one effective request to it', async () => {
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      expect(request.url).toBe('https://api.example.test/v1/items/a?q=x');
      expect(request.method).toBe('GET');
      expect(request.body).toBeUndefined();
      expect(request.phase).toBe('resource');
      return response('{}');
    });

    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'bearer',
      { type: 'bearer', token: 'bearer-canary' },
      (request: ProbeApiResourceExecutorRequest) => {
        expect(request.headers.Authorization).toBe('Bearer bearer-canary');
      },
    ],
    [
      'basic',
      { type: 'basic', username: 'user', password: 'pass' },
      (request: ProbeApiResourceExecutorRequest) => {
        expect(request.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
      },
    ],
    [
      'api-key header and query',
      { type: 'api-key', header: 'X-Api-Key', query_param: 'api_key', key: 'key-canary' },
      (request: ProbeApiResourceExecutorRequest) => {
        expect(request.headers['X-Api-Key']).toBe('key-canary');
        expect(request.url).toBe('https://api.example.test/v1/items/a?q=x&api_key=key-canary');
      },
    ],
  ])(
    'applies %s authentication before the resource executor',
    async (_label, auth, assertRequest) => {
      const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
        assertRequest(request);
        return response('{}');
      });
      const source = externalSource();
      source.transports.rest = { ...source.transports.rest, auth };

      const result = await probeApiResource({
        source,
        resource: externalResource(),
        input: { id: 'a', q: 'x' },
        executor,
      });

      expect(result).toMatchObject({ ok: true });
      expect(executor).toHaveBeenCalledTimes(1);
    }
  );

  it('applies deterministic SigV4 authentication without a second resource request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-02T03:04:05.000Z'));
    try {
      const source = externalSource();
      source.transports.rest = {
        ...source.transports.rest,
        auth: {
          type: 'aws-sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          access_key_id: 'AKIAEXAMPLE',
          secret_access_key: 'test-secret',
        },
      };
      const requests: ProbeApiResourceExecutorRequest[] = [];
      const signatures: string[] = [];
      const execute = () =>
        probeApiResource({
          source,
          resource: externalResource(),
          input: { id: 'a', q: 'x' },
          executor: async (request) => {
            requests.push(request);
            const authorization = request.headers.authorization;
            const signature = authorization?.match(/Signature=([^\s,]+)/)?.[1];
            expect(signature).toBeDefined();
            signatures.push(signature ?? '');
            return response(signature ?? '');
          },
        });

      const first = await execute();
      const second = await execute();
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.headers).toEqual(requests[1]?.headers);
      expect(requests[0]?.headers.authorization).toContain('AWS4-HMAC-SHA256');
      expect(signatures).toHaveLength(2);
      if (first.ok && second.ok) {
        expect(new TextDecoder().decode(first.response.responseBytes)).not.toContain(
          signatures[0] as string
        );
        expect(new TextDecoder().decode(second.response.responseBytes)).not.toContain(
          signatures[1] as string
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts the derived Basic credential payload from an echoed response', async () => {
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      auth: { type: 'basic', username: 'user', password: 'pass' },
    };
    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor: async (request) => {
        expect(request.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
        return response('dXNlcjpwYXNz');
      },
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(new TextDecoder().decode(result.response.responseBytes)).not.toContain('dXNlcjpwYXNz');
    }
  });

  it('uses exactly one OAuth token exchange and one authenticated resource request', async () => {
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      auth: {
        type: 'oauth2',
        grant_type: 'client_credentials',
        token_url: 'https://auth.example.test/oauth/token',
        client_id: 'client-id-canary',
        client_secret: 'client-secret-canary',
      },
    };
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      if (request.phase === 'token') {
        expect(request.url).toBe('https://auth.example.test/oauth/token');
        expect(request.method).toBe('POST');
        expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(request.body).toContain('grant_type=client_credentials');
        return response('{"access_token":"oauth-token-canary","token_type":"Bearer"}');
      }
      expect(request.headers.Authorization).toBe('Bearer oauth-token-canary');
      return response('echo:oauth-token-canary');
    });

    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(new TextDecoder().decode(result.response.responseBytes)).not.toContain(
        'oauth-token-canary'
      );
    }
  });

  it('uses the configured OAuth authorization-code prefix before provider token_type', async () => {
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      auth: {
        type: 'oauth2',
        grant_type: 'authorization_code',
        token_url: 'https://auth.example.test/oauth/token',
        client_id: 'client-id-canary',
        client_secret: 'client-secret-canary',
        refresh_token: 'refresh-token-canary',
        token_prefix: 'token',
      },
    };
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      if (request.phase === 'token') {
        expect(request.body).toContain('grant_type=refresh_token');
        expect(request.body).toContain('refresh_token=refresh-token-canary');
        return response('{"access_token":"oauth-refresh-token","token_type":"Bearer"}');
      }
      expect(request.headers.Authorization).toBe('token oauth-refresh-token');
      return response('{}');
    });

    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('uses exactly one custom-token exchange and one authenticated resource request', async () => {
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      auth: {
        type: 'custom-token',
        token_url: 'https://auth.example.test/custom-token',
        token_request: {
          headers: { 'X-Custom': 'custom-header-canary' },
          body: { value: 'custom-body-canary' },
        },
        token_response_path: 'data.token',
        token_prefix: 'Token',
      },
    };
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      if (request.phase === 'token') {
        expect(request.method).toBe('POST');
        expect(request.headers['X-Custom']).toBe('custom-header-canary');
        expect(JSON.parse(request.body ?? '')).toEqual({ value: 'custom-body-canary' });
        return response('{"data":{"token":"custom-token-canary"}}');
      }
      expect(request.headers.Authorization).toBe('Tokencustom-token-canary');
      return response(
        'echo:custom-token-canary custom-header-canary custom-body-canary ordinary-value'
      );
    });

    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(new TextDecoder().decode(result.response.responseBytes)).not.toContain(
        'custom-token-canary'
      );
      expect(new TextDecoder().decode(result.response.responseBytes)).not.toContain(
        'custom-header-canary'
      );
      expect(new TextDecoder().decode(result.response.responseBytes)).not.toContain(
        'custom-body-canary'
      );
    }
  });

  it('encodes GET path values as one segment and interpolates query values', async () => {
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      expect(request.url).toBe('https://api.example.test/v1/items/..%2Fa%2Fb?q=hello+world');
      return response('{}');
    });

    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: '../a/b', q: 'hello world' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('keeps dot-only path values out of URL path normalization', async () => {
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      expect(request.url).toBe('https://api.example.test/v1/items/%252E%252E?q=x');
      return response('{}');
    });

    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: '..', q: 'x' },
      executor,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('uses the same planner for built-in and equivalent validated external definitions', async () => {
    const notion = buildCatalogManifest().sources.find((source) => source.name === 'notion');
    const pages = notion?.resources.find((resource) => resource.name === 'pages');
    const rest = pages?.variants.find((variant) => variant.via === 'rest');
    if (!notion || !pages || !rest?.api) {
      throw new Error('Notion REST catalog metadata is missing');
    }

    const transports: CatalogProbeSource['transports'] = {};
    for (const config of notion.transport_configs) {
      if (!config.base_url) continue;
      const transport: CatalogProbeTransport = {
        id: config.id,
        type: 'http',
        base_url: config.base_url,
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.auth ? { auth: config.auth } : {}),
        ...(config.timeout_ms !== undefined ? { timeout_ms: config.timeout_ms } : {}),
      };
      transports[config.id] = transport;
    }
    const externalSourceDefinition: CatalogProbeSource = {
      name: notion.name,
      auth_env_vars: notion.auth_setup.map((entry) => entry.env),
      default_transport: notion.default_transport,
      transports,
    };
    const externalResourceDefinition: CatalogProbeResource = {
      name: pages.name,
      via: rest.via,
      ...(pages.description ? { description: pages.description } : {}),
      input: rest.input ?? pages.input ?? {},
      api: rest.api,
    };

    const builtInRequests: ProbeApiResourceExecutorRequest[] = [];
    const externalRequests: ProbeApiResourceExecutorRequest[] = [];
    const builtIn = await probeApiResource({
      source: 'notion',
      resource: 'pages',
      transport: 'rest',
      secrets: notionSecrets,
      executor: async (request) => {
        builtInRequests.push(request);
        return response('{}');
      },
    });
    const external = await probeApiResource({
      source: externalSourceDefinition,
      resource: externalResourceDefinition,
      transport: 'rest',
      secrets: notionSecrets,
      executor: async (request) => {
        externalRequests.push(request);
        return response('{}');
      },
    });

    expect(builtIn).toMatchObject({ ok: true });
    expect(external).toMatchObject({ ok: true });
    expect(builtInRequests).toHaveLength(1);
    expect(externalRequests).toHaveLength(1);
    expect(requestSnapshot(builtInRequests[0] as ProbeApiResourceExecutorRequest)).toEqual(
      requestSnapshot(externalRequests[0] as ProbeApiResourceExecutorRequest)
    );
  });

  it.each([
    ['missing', undefined, { id: 'a', q: undefined }],
    ['extra', { id: 'a', q: 'x', extra: 'nope' }, undefined],
    ['wrong type', { id: 42, q: 'x' }, undefined],
  ])('rejects %s input before the executor', async (_label, input, expected) => {
    const executor = vi.fn(async () => response('{}'));
    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: (input ?? expected) as Record<string, unknown>,
      executor,
    });

    expect(result).toEqual({ ok: false, code: 'invalid_input' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('makes one request even when the response looks paginated or retryable', async () => {
    const executor = vi.fn(async () => response('{"next_cursor":"more","status":429}', 429));
    const result = await probeApiResource({
      source: 'notion',
      resource: 'pages',
      transport: 'rest',
      secrets: notionSecrets,
      executor,
    });

    expect(result).toMatchObject({ ok: false, code: 'http_status', response: { status: 429 } });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('passes the exact AbortSignal through and propagates its abort reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const executor = vi.fn(async (request: ProbeApiResourceExecutorRequest) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort(reason);
      throw reason;
    });

    await expect(
      probeApiResource({
        source: externalSource(),
        resource: externalResource(),
        input: { id: 'a', q: 'x' },
        signal: controller.signal,
        executor,
      })
    ).rejects.toBe(reason);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('bounds response bytes and reports truncation without returning request diagnostics', async () => {
    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      maxResponseBytes: 5,
      executor: async () => response('abcdef'),
    });

    expect(result).toMatchObject({
      ok: true,
      response: { status: 200, contentType: 'application/json', truncated: true },
    });
    if (result.ok) expect(new TextDecoder().decode(result.response.responseBytes)).toBe('abcde');
    expect(result).not.toHaveProperty('request');
    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('headers');
    expect(result).not.toHaveProperty('body');
  });

  it('redacts a secret before applying the response byte limit', async () => {
    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      secrets: { TOKEN: 'abcdef' },
      maxResponseBytes: 5,
      executor: async () => response('abcdef'),
    });

    expect(result).toMatchObject({ ok: true, response: { truncated: true } });
    if (result.ok) expect(new TextDecoder().decode(result.response.responseBytes)).toBe('*****');
  });

  it('does not redact a complete response that only contains a credential prefix', async () => {
    const result = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      secrets: { TOKEN: 'abcdef' },
      maxResponseBytes: 5,
      executor: async () => response('abc'),
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(new TextDecoder().decode(result.response.responseBytes)).toBe('abc');
  });

  it('redacts literal auth and header credentials from external definitions', async () => {
    const authCanary = 'literal-auth-canary';
    const headerCanary = 'literal-header-canary';
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      headers: { 'X-Provider-Secret': headerCanary },
      auth: { type: 'bearer', token: authCanary },
    };

    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      executor: async () => response(`echo:${authCanary}:${headerCanary}`),
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const body = new TextDecoder().decode(result.response.responseBytes);
      expect(body).not.toContain(authCanary);
      expect(body).not.toContain(headerCanary);
    }
  });

  it('redacts credential-like query and body fields while preserving ordinary echoes', async () => {
    const authCanary = 'literal-auth-canary';
    const headerCanary = 'literal-header-canary';
    const queryCanary = 'literal-query-canary';
    const bodyCanary = 'literal-body-canary';
    const source = externalSource();
    source.transports.rest = {
      ...source.transports.rest,
      headers: {
        'X-Provider-Version': 'provider-v1',
        'X-Provider-Secret': headerCanary,
      },
      auth: { type: 'bearer', token: authCanary },
    };

    const result = await probeApiResource({
      source,
      resource: {
        ...externalResource(),
        input: {
          id: { type: 'string', required: true },
          q: { type: 'string', required: true },
        },
        api: {
          endpoint: '/items/${{ input.id }}',
          method: 'POST',
          query_params: {
            q: '${{ input.q }}',
            filter: 'ordinary-query',
            api_key: queryCanary,
          },
          request_body: {
            query: 'ordinary-body',
            password: bodyCanary,
          },
        },
      },
      input: { id: 'a', q: 'ordinary-input' },
      executor: async () =>
        response(
          `provider-v1 ordinary-input ordinary-query ordinary-body ${authCanary} ${headerCanary} ${queryCanary} ${bodyCanary}`
        ),
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const body = new TextDecoder().decode(result.response.responseBytes);
      expect(body).toContain('provider-v1');
      expect(body).toContain('ordinary-input');
      expect(body).toContain('ordinary-query');
      expect(body).toContain('ordinary-body');
      expect(body).not.toContain(authCanary);
      expect(body).not.toContain(headerCanary);
      expect(body).not.toContain(queryCanary);
      expect(body).not.toContain(bodyCanary);
    }
  });

  it.each([
    [
      'value count',
      Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`secret_${index}`, `credential-${index}`])
      ),
    ],
    ['single value bytes', { password: 'x'.repeat(4 * 1024 + 1) }],
    [
      'total value bytes',
      Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `password_${index}`,
          `${'x'.repeat(4 * 1024 - 2)}${index.toString().padStart(2, '0')}`,
        ])
      ),
    ],
  ])(
    'rejects an external definition over the redaction %s limit before execution',
    async (_label, requestBody) => {
      const executor = vi.fn(async () => response('{}'));
      const result = await probeApiResource({
        source: externalSource(),
        resource: {
          ...externalResource(),
          api: {
            ...externalResource().api,
            method: 'POST',
            request_body: requestBody,
          },
        },
        input: { id: 'a', q: 'x' },
        executor,
      });

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(executor).not.toHaveBeenCalled();
    }
  );

  it('scans a maximum-size response with bounded credential redaction', async () => {
    const requestBody = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `password_${index}`,
        `credential-${index}-${'x'.repeat(64)}`,
      ])
    );
    const executor = vi.fn(
      async () =>
        new Response(new Uint8Array(1024 * 1024), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
    );
    const result = await probeApiResource({
      source: externalSource(),
      resource: {
        ...externalResource(),
        api: {
          ...externalResource().api,
          method: 'POST',
          request_body: requestBody,
        },
      },
      input: { id: 'a', q: 'x' },
      maxResponseBytes: 1024 * 1024,
      executor,
    });

    expect(result).toMatchObject({
      ok: true,
      response: { responseBytes: expect.any(Uint8Array), truncated: false },
    });
    if (result.ok) expect(result.response.responseBytes).toHaveLength(1024 * 1024);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('does not expose secret canaries from executor errors or response bytes', async () => {
    const canary = 'secret-canary-value';
    const failed = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      secrets: { TOKEN: canary },
      executor: async (request) => {
        throw new Error(`${request.url} ${request.body ?? ''} ${canary}`);
      },
    });
    expect(failed).toEqual({ ok: false, code: 'executor_failed' });
    expect(JSON.stringify(failed)).not.toContain(canary);

    const echoed = await probeApiResource({
      source: externalSource(),
      resource: externalResource(),
      input: { id: 'a', q: 'x' },
      secrets: { TOKEN: canary },
      executor: async () => response(`echo:${canary}`),
    });
    expect(echoed).toMatchObject({ ok: true });
    if (echoed.ok) {
      expect(new TextDecoder().decode(echoed.response.responseBytes)).not.toContain(canary);
    }
  });

  it('rejects CR/LF header interpolation and unresolved templates before execution', async () => {
    const headerExecutor = vi.fn(async () => response('{}'));
    const headerResult = await probeApiResource({
      source: externalSource(),
      resource: {
        ...externalResource(),
        input: { id: { type: 'string' }, q: { type: 'string' }, header: { type: 'string' } },
        api: {
          ...externalResource().api,
          headers: { 'X-Probe': '${{ input.header }}' },
        },
      },
      input: { id: 'a', q: 'x', header: 'ok\r\nInjected: yes' },
      executor: headerExecutor,
    });
    expect(headerResult).toEqual({ ok: false, code: 'invalid_request' });
    expect(headerExecutor).not.toHaveBeenCalled();

    const templateExecutor = vi.fn(async () => response('{}'));
    const templateResult = await probeApiResource({
      source: externalSource(),
      resource: {
        ...externalResource('/items/${{ unknown.value }}'),
        input: { q: { type: 'string' } },
      },
      input: { q: 'x' },
      executor: templateExecutor,
    });
    expect(templateResult).toEqual({ ok: false, code: 'invalid_request' });
    expect(templateExecutor).not.toHaveBeenCalled();
  });
});

it.each(['env', 'secrets'])(
  'rejects undeclared %s references before executing a probe',
  async (namespace) => {
    const executor = vi.fn(async () => response('{}'));
    const source = externalSource();
    source.transports.rest!.headers = { 'X-Token': '${{ ' + namespace + '.SNOWFLAKE_PASSWORD }}' };
    const result = await probeApiResource({
      source,
      resource: externalResource(),
      input: { id: 'test', q: 'test' },
      env: { SNOWFLAKE_PASSWORD: 'synthetic-secret' },
      secrets: { SNOWFLAKE_PASSWORD: 'synthetic-secret' },
      executor,
    });
    expect(result).toEqual({ ok: false, code: 'invalid_request' });
    expect(executor).not.toHaveBeenCalled();
  }
);

it.each(['secrets', 'env'])(
  'scopes probe host declarations to the secrets map (%s)',
  async (namespace) => {
    const executor = vi.fn(async () => response('{}'));
    const source = externalSource();
    source.transports.rest!.headers = { 'X-Token': '${{ ' + namespace + '.HOST_TOKEN }}' };
    const options = {
      source,
      resource: externalResource(),
      input: { id: 'test', q: 'test' },
      secrets: { HOST_TOKEN: 'host-canary' },
      executor,
    };
    expect(await probeApiResource(options)).toEqual({ ok: false, code: 'invalid_request' });
    expect(executor).not.toHaveBeenCalled();
    const result = await probeApiResource({ ...options, declaredSecretNames: ['HOST_TOKEN'] });
    expect(result.ok).toBe(namespace === 'secrets');
    expect(executor).toHaveBeenCalledTimes(namespace === 'secrets' ? 1 : 0);
  }
);
