import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetDnsLookupForTests, setDnsLookupForTests } from '../../../src/framework/core/index.js';
import {
  applyHttpAuth,
  clearRuntimeAuthCaches,
  mapOutput,
  mergeIntegrationOperation,
} from '../../../src/framework/runtime/index.js';

describe('mergeIntegrationOperation', () => {
  it('merges integration transport defaults into an operation', () => {
    const resolved = mergeIntegrationOperation(
      {
        spec_version: '1',
        type: 'integration',
        name: 'github',
        transport: {
          base_url: 'https://api.github.com',
          headers: {
            Accept: 'application/json',
          },
          auth: {
            type: 'bearer',
            token: 'secret',
          },
          timeout_ms: 15_000,
        },
      },
      {
        endpoint: '/issues',
        method: 'GET',
        headers: {
          'X-Resource': '1',
        },
      }
    );

    expect(resolved).toMatchObject({
      endpoint: '/issues',
      timeout_ms: 15_000,
      headers: {
        Accept: 'application/json',
        'X-Resource': '1',
      },
      auth: {
        type: 'bearer',
        token: 'secret',
      },
    });
  });

  it('merges Notion integration with versioned headers into a POST operation', () => {
    const resolved = mergeIntegrationOperation(
      {
        spec_version: '1',
        type: 'integration',
        name: 'notion',
        transport: {
          base_url: 'https://api.notion.com',
          headers: {
            'Notion-Version': '2022-06-28',
          },
          auth: {
            type: 'bearer',
            token: 'ntn_secret',
          },
        },
      },
      {
        endpoint: '/v1/databases/abc123/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    expect(resolved).toMatchObject({
      endpoint: '/v1/databases/abc123/query',
      headers: {
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      auth: {
        type: 'bearer',
        token: 'ntn_secret',
      },
    });
  });

  it('merges Linear integration api-key auth into a GraphQL operation', () => {
    const resolved = mergeIntegrationOperation(
      {
        spec_version: '1',
        type: 'integration',
        name: 'linear',
        transport: {
          base_url: 'https://api.linear.app',
          headers: {
            'Content-Type': 'application/json',
          },
          auth: {
            type: 'api-key',
            header: 'Authorization',
            key: 'lin_api_secret',
          },
        },
      },
      {
        endpoint: '/graphql',
        method: 'POST',
      }
    );

    expect(resolved).toMatchObject({
      endpoint: '/graphql',
      headers: {
        'Content-Type': 'application/json',
      },
      auth: {
        type: 'api-key',
        header: 'Authorization',
        key: 'lin_api_secret',
      },
    });
  });
});

describe('applyHttpAuth', () => {
  afterEach(() => {
    clearRuntimeAuthCaches();
    resetDnsLookupForTests();
    vi.restoreAllMocks();
  });

  it('applies api-key auth to both headers and query params', async () => {
    const request = await applyHttpAuth({
      url: 'https://api.example.com/issues',
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      timeout_ms: 30_000,
      auth: {
        type: 'api-key',
        header: 'X-API-Key',
        query_param: 'api_key',
        key: 'secret',
      },
    });

    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      'X-API-Key': 'secret',
    });
    expect(request.url).toBe('https://api.example.com/issues?api_key=secret');
  });

  it('interpolates ${{ env.X }} in bearer token', async () => {
    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'bearer',
        token: '${{ env.MY_TOKEN }}',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['MY_TOKEN']),
        env: { MY_TOKEN: 'resolved-bearer-token' },
      },
    });

    expect(request.headers['Authorization']).toBe('Bearer resolved-bearer-token');
  });

  it('interpolates ${{ env.X }} in api-key auth', async () => {
    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'api-key',
        header: 'Authorization',
        key: '${{ env.API_KEY }}',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['API_KEY']),
        env: { API_KEY: 'resolved-api-key' },
      },
    });

    expect(request.headers['Authorization']).toBe('resolved-api-key');
  });

  it('interpolates ${{ env.X }} in basic auth credentials', async () => {
    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'basic',
        username: '${{ env.USER }}',
        password: '${{ env.PASS }}',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['USER', 'PASS']),
        env: { USER: 'alice', PASS: 's3cret' },
      },
    });

    const expected = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`;
    expect(request.headers['Authorization']).toBe(expected);
  });

  it('interpolates ${{ env.X }} in oauth2 client credentials', async () => {
    const mockResponse = new Response(
      JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }),
      { status: 200 }
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'oauth2',
        grant_type: 'client_credentials',
        token_url: 'https://auth.example.com/token',
        client_id: '${{ env.CLIENT_ID }}',
        client_secret: '${{ env.CLIENT_SECRET }}',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['CLIENT_ID', 'CLIENT_SECRET']),
        env: { CLIENT_ID: 'my-id', CLIENT_SECRET: 'my-secret' },
      },
    });

    expect(request.headers['Authorization']).toBe('Bearer oauth-token');
    expect(request.resolvedSecrets).toEqual(['oauth-token']);

    // Verify interpolated values were sent to the token endpoint
    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    const body = fetchCall[1]?.body as string;
    expect(body).toContain('client_id=my-id');
    expect(body).toContain('client_secret=my-secret');
  });

  it('sends the configured RFC 8707 resource in the client credentials token request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }), {
          status: 200,
        })
      )
    );

    await applyHttpAuth({
      url: 'https://api.example.com/items',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'oauth2',
        grant_type: 'client_credentials',
        token_url: 'https://auth.example.com/oauth/token',
        client_id: 'my-id',
        client_secret: 'my-secret',
        scopes: ['api:read'],
        resource: 'https://${{ env.API_HOST }}/',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['API_HOST']),
        env: { API_HOST: 'api.example.com' },
      },
    });

    const body = new URLSearchParams(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.get('resource')).toBe('https://api.example.com/');
  });

  it('leaves the client credentials token request unchanged when no resource is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }), {
          status: 200,
        })
      )
    );

    await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'oauth2',
        grant_type: 'client_credentials',
        token_url: 'https://auth.example.com/token',
        client_id: 'my-id',
        client_secret: 'my-secret',
        scopes: ['api:read'],
      },
    });

    expect(vi.mocked(fetch).mock.calls[0]![1]?.body).toBe(
      'grant_type=client_credentials&client_id=my-id&client_secret=my-secret&scope=api%3Aread'
    );
  });

  it('keeps oauth2 cache entries distinct across resources', async () => {
    let issued = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      issued += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600 }), {
          status: 200,
        })
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const requestFor = (resource: string) =>
      applyHttpAuth({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {},
        timeout_ms: 30_000,
        auth: {
          type: 'oauth2',
          grant_type: 'client_credentials',
          token_url: 'https://auth.example.com/token',
          client_id: 'shared-client',
          client_secret: 'shared-secret',
          resource,
        },
      });

    const first = await requestFor('https://api.example.com/v1');
    const second = await requestFor('https://other.example.com/v1');
    const firstAgain = await requestFor('https://api.example.com/v1');

    expect(first.headers['Authorization']).toBe('Bearer tok-1');
    expect(second.headers['Authorization']).toBe('Bearer tok-2');
    expect(firstAgain.headers['Authorization']).toBe('Bearer tok-1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes oauth2 authorization_code tokens with refresh_token auth', async () => {
    const mockResponse = new Response(
      JSON.stringify({ access_token: 'oauth-refresh-token', expires_in: 3600 }),
      { status: 200 }
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'oauth2',
        grant_type: 'authorization_code',
        token_url: 'https://auth.example.com/token',
        client_id: '${{ env.CLIENT_ID }}',
        client_secret: '${{ env.CLIENT_SECRET }}',
        refresh_token: '${{ env.REFRESH_TOKEN }}',
        token_prefix: 'token',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']),
        env: {
          CLIENT_ID: 'my-id',
          CLIENT_SECRET: 'my-secret',
          REFRESH_TOKEN: 'my-refresh-token',
        },
      },
    });

    expect(request.headers['Authorization']).toBe('token oauth-refresh-token');

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    const body = fetchCall[1]?.body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=my-id');
    expect(body).toContain('client_secret=my-secret');
    expect(body).toContain('refresh_token=my-refresh-token');
  });

  it('preserves the configured custom-token prefix exactly', async () => {
    const mockResponse = new Response(JSON.stringify({ access_token: 'custom-token' }), {
      status: 200,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'custom-token',
        token_url: 'https://auth.example.com/token',
        token_prefix: 'Token',
        token_ttl_seconds: 0,
      },
    });

    expect(request.headers['Authorization']).toBe('Tokencustom-token');
    expect(request.resolvedSecrets).toEqual(['custom-token']);
  });

  it('keeps oauth2 cache entries distinct across refresh tokens', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
        )
      );
    vi.stubGlobal('fetch', mockFetch);

    const baseRequest = {
      url: 'https://api.example.com/data',
      method: 'GET' as const,
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'oauth2' as const,
        grant_type: 'authorization_code' as const,
        token_url: 'https://auth.example.com/token',
        client_id: 'shared-client',
        client_secret: 'shared-secret',
      },
    };

    await applyHttpAuth({
      ...baseRequest,
      auth: {
        ...baseRequest.auth,
        refresh_token: 'refresh-a',
      },
    });
    await applyHttpAuth({
      ...baseRequest,
      auth: {
        ...baseRequest.auth,
        refresh_token: 'refresh-a',
      },
    });
    await applyHttpAuth({
      ...baseRequest,
      auth: {
        ...baseRequest.auth,
        refresh_token: 'refresh-b',
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects oauth2 token URLs on private hosts', async () => {
    delete process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      applyHttpAuth({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {},
        timeout_ms: 30_000,
        auth: {
          type: 'oauth2',
          grant_type: 'authorization_code',
          token_url: 'https://127.0.0.1/token',
          client_id: 'client-id',
          client_secret: 'client-secret',
          refresh_token: 'refresh-token',
        },
      })
    ).rejects.toThrow('private/internal host');
  });

  it('rejects oauth2 token URLs that resolve to private hosts', async () => {
    delete process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    vi.stubGlobal('fetch', vi.fn());
    setDnsLookupForTests(async () => ({ address: '127.0.0.1', family: 4 }));

    await expect(
      applyHttpAuth({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {},
        timeout_ms: 30_000,
        auth: {
          type: 'oauth2',
          grant_type: 'authorization_code',
          token_url: 'https://auth.example.com/token',
          client_id: 'client-id',
          client_secret: 'client-secret',
          refresh_token: 'refresh-token',
        },
      })
    ).rejects.toThrow('resolves to private address');
  });

  it('rejects custom-token URLs that resolve to private hosts', async () => {
    delete process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    vi.stubGlobal('fetch', vi.fn());
    setDnsLookupForTests(async () => ({ address: '127.0.0.1', family: 4 }));

    await expect(
      applyHttpAuth({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {},
        timeout_ms: 30_000,
        auth: {
          type: 'custom-token',
          token_url: 'https://tokens.example.com/token',
          token_response_path: 'access_token',
        },
      })
    ).rejects.toThrow('resolves to private address');
  });

  it('interpolates ${{ env.X }} in aws-sigv4 credentials', async () => {
    const request = await applyHttpAuth({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
      timeout_ms: 30_000,
      auth: {
        type: 'aws-sigv4',
        region: 'us-east-1',
        service: 'execute-api',
        access_key_id: '${{ env.AWS_KEY }}',
        secret_access_key: '${{ env.AWS_SECRET }}',
      },
      interpolationContext: {
        declaredEnvVars: new Set(['AWS_KEY', 'AWS_SECRET']),
        env: {
          AWS_KEY: 'AKIAIOSFODNN7EXAMPLE',
          AWS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      },
    });

    // AWS SigV4 produces an Authorization header with the access key ID
    expect(request.headers['authorization'] ?? request.headers['Authorization']).toContain(
      'AKIAIOSFODNN7EXAMPLE'
    );
  });
});

describe('mapOutput', () => {
  it('maps nested objects, arrays, and defaults from JSONPath output definitions', () => {
    const record = mapOutput(
      {
        id: 42,
        user: {
          login: 'alice',
        },
        labels: [{ name: 'bug' }, { name: 'urgent' }],
      },
      {
        id: { type: 'integer', path: '$.id' },
        login: { type: 'string', path: '$.user.login' },
        labels: {
          type: 'array',
          path: '$.labels[*]',
          items: {
            type: 'object',
            path: '$',
            properties: {
              name: { type: 'string', path: '$.name' },
            },
          },
        },
        state: {
          type: 'string',
          path: '$.state',
          default: 'open',
        },
      }
    );

    expect(record).toEqual({
      id: 42,
      login: 'alice',
      labels: [{ name: 'bug' }, { name: 'urgent' }],
      state: 'open',
    });
  });

  it('maps Slack message fields with thread_ts default', () => {
    const record = mapOutput(
      {
        ts: '1678901234.567890',
        user: 'U12345',
        text: 'Hello world',
        // thread_ts is absent — should use default
      },
      {
        ts: { type: 'string', path: '$.ts' },
        user: { type: 'string', path: '$.user' },
        text: { type: 'string', path: '$.text' },
        thread_ts: { type: 'string', path: '$.thread_ts', default: '' },
      }
    );

    expect(record).toEqual({
      ts: '1678901234.567890',
      user: 'U12345',
      text: 'Hello world',
      thread_ts: '',
    });
  });

  it('maps Notion database row with deeply nested title path', () => {
    const record = mapOutput(
      {
        id: 'page-uuid-123',
        created_time: '2024-01-15T10:30:00.000Z',
        last_edited_time: '2024-03-20T14:22:00.000Z',
        url: 'https://notion.example/page-uuid-123',
        archived: false,
        properties: {
          Name: {
            title: [{ plain_text: 'My Page Title' }],
          },
        },
      },
      {
        id: { type: 'string', path: '$.id' },
        title: { type: 'string', path: '$.properties.Name.title[0].plain_text' },
        last_edited_time: { type: 'timestamp', path: '$.last_edited_time' },
        archived: { type: 'boolean', path: '$.archived' },
      }
    );

    expect(record).toEqual({
      id: 'page-uuid-123',
      title: 'My Page Title',
      last_edited_time: '2024-03-20T14:22:00.000Z',
      archived: false,
    });
  });

  it('maps Linear GraphQL issue with nested state and assignee', () => {
    const record = mapOutput(
      {
        id: 'LIN-123',
        title: 'Fix pagination bug',
        state: { name: 'In Progress' },
        assignee: { name: 'Alice', email: 'alice@example.com' },
        updatedAt: '2024-03-20T14:22:00.000Z',
      },
      {
        id: { type: 'string', path: '$.id' },
        title: { type: 'string', path: '$.title' },
        state_name: { type: 'string', path: '$.state.name' },
        assignee_name: { type: 'string', path: '$.assignee.name' },
        assignee_email: { type: 'string', path: '$.assignee.email' },
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      }
    );

    expect(record).toEqual({
      id: 'LIN-123',
      title: 'Fix pagination bug',
      state_name: 'In Progress',
      assignee_name: 'Alice',
      assignee_email: 'alice@example.com',
      updated_at: '2024-03-20T14:22:00.000Z',
    });
  });
});
