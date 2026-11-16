import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  createStdioTransport,
  createStreamableHttpTransport,
  resolveStdioEnv,
} from '../../../src/runtime/mcp-transport.js';
import { RESPONSE_BODY_LIMITS } from '../../../src/framework/core/response-body.js';
import { resetDnsLookupForTests, setDnsLookupForTests } from '../../../src/framework/core/ssrf.js';

import type { McpStdioTransportConfig } from '../../../src/framework/core/integration.js';

const baseTransport: McpStdioTransportConfig = {
  type: 'mcp_stdio',
  command: 'npx',
  args: [
    '-y',
    '@ergut/mcp-bigquery-server@1.0.4',
    '--project',
    '${{ env.BIGQUERY_PROJECT_ID }}',
    '--location',
    '${{ env.BIGQUERY_LOCATION }}',
  ],
};

afterEach(() => {
  resetDnsLookupForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MCP Stdio Sandbox', () => {
  describe('createStdioTransport() command-shape registry', () => {
    it('allows only the pinned BigQuery and Snowflake MCP launch shapes', () => {
      expect(() =>
        createStdioTransport(
          baseTransport,
          undefined,
          {
            BIGQUERY_PROJECT_ID: 'analytics-prod',
            BIGQUERY_LOCATION: 'us-central1',
          },
          new Set(['BIGQUERY_PROJECT_ID', 'BIGQUERY_LOCATION'])
        )
      ).not.toThrow();
      expect(() =>
        createStdioTransport(
          {
            type: 'mcp_stdio',
            command: 'npx',
            args: [
              '-y',
              '@ergut/mcp-bigquery-server@1.0.4',
              '--project',
              'analytics-prod',
              '--location',
              'us-central1',
            ],
          },
          undefined
        )
      ).not.toThrow();
      expect(() =>
        createStdioTransport(
          {
            type: 'mcp_stdio',
            command: 'uvx',
            args: ['mcp-snowflake-server==0.4.0'],
          },
          undefined
        )
      ).not.toThrow();
    });

    it('resolves only approved whole-template BigQuery option values before spawning', () => {
      const transport = createStdioTransport(
        baseTransport,
        undefined,
        {
          BIGQUERY_PROJECT_ID: 'analytics-prod',
          BIGQUERY_LOCATION: 'us-central1',
        },
        new Set(['BIGQUERY_PROJECT_ID', 'BIGQUERY_LOCATION'])
      );

      expect(
        (transport as unknown as { _serverParams: { args: string[] } })._serverParams.args
      ).toEqual([
        '-y',
        '@ergut/mcp-bigquery-server@1.0.4',
        '--project',
        'analytics-prod',
        '--location',
        'us-central1',
      ]);
    });

    it('fails closed when an approved argument template is missing or resolves unsafely', () => {
      expect(() =>
        createStdioTransport(
          baseTransport,
          undefined,
          {
            BIGQUERY_PROJECT_ID: 'analytics-prod',
          },
          new Set(['BIGQUERY_PROJECT_ID', 'BIGQUERY_LOCATION'])
        )
      ).toThrow(/BIGQUERY_LOCATION/);
      expect(() =>
        createStdioTransport(
          baseTransport,
          undefined,
          {
            BIGQUERY_PROJECT_ID: '--package=evil',
            BIGQUERY_LOCATION: 'us-central1',
          },
          new Set(['BIGQUERY_PROJECT_ID', 'BIGQUERY_LOCATION'])
        )
      ).toThrow(/--project value is not allowed/i);
    });

    it.each([
      ['node eval', 'node', ['-e', 'process.exit(0)']],
      ['node script', 'node', ['server.mjs']],
      ['python eval', 'python', ['-c', 'print(1)']],
      ['python3 eval', 'python3', ['-c', 'print(1)']],
      ['docker host mount', 'docker', ['run', '-v', '/:/host', 'evil']],
      ['generic uv', 'uv', ['run', 'evil.py']],
      ['shell', 'bash', ['-c', 'echo pwned']],
    ])('rejects the %s executable path', (_label, command, args) => {
      expect(() =>
        createStdioTransport(
          {
            type: 'mcp_stdio',
            command,
            args,
          },
          undefined
        )
      ).toThrow(/command .* is not allowed/i);
    });

    it.each([
      ['arbitrary package', ['-y', 'evil-package', '--project', 'p', '--location', 'us']],
      [
        'mutable unpinned package',
        ['-y', '@ergut/mcp-bigquery-server', '--project', 'p', '--location', 'us'],
      ],
      [
        'wrong package version',
        ['-y', '@ergut/mcp-bigquery-server@1.0.5', '--project', 'p', '--location', 'us'],
      ],
      [
        '--package injection',
        [
          '-y',
          '--package=evil-package',
          '@ergut/mcp-bigquery-server@1.0.4',
          '--project',
          'p',
          '--location',
          'us',
        ],
      ],
      [
        'extra npx option',
        [
          '-y',
          '--ignore-scripts',
          '@ergut/mcp-bigquery-server@1.0.4',
          '--project',
          'p',
          '--location',
          'us',
        ],
      ],
      [
        'extra executable option',
        [
          '-y',
          '@ergut/mcp-bigquery-server@1.0.4',
          '--project',
          'p',
          '--location',
          'us',
          '--config',
          '/tmp/evil',
        ],
      ],
      [
        'reordered flags',
        ['-y', '@ergut/mcp-bigquery-server@1.0.4', '--location', 'us', '--project', 'p'],
      ],
      [
        'flag-like project value',
        [
          '-y',
          '@ergut/mcp-bigquery-server@1.0.4',
          '--project',
          '--package=evil',
          '--location',
          'us',
        ],
      ],
      [
        'partial env interpolation',
        [
          '-y',
          '@ergut/mcp-bigquery-server@1.0.4',
          '--project',
          'prefix-${{ env.BIGQUERY_PROJECT_ID }}',
          '--location',
          'us',
        ],
      ],
    ])('rejects npx %s', (_label, args) => {
      expect(() =>
        createStdioTransport(
          {
            type: 'mcp_stdio',
            command: 'npx',
            args,
          },
          undefined
        )
      ).toThrow(/npx arguments|--project value/i);
    });

    it.each([
      ['arbitrary package', ['evil-package']],
      ['mutable unpinned package', ['mcp-snowflake-server']],
      ['wrong package version', ['mcp-snowflake-server==0.4.1']],
      ['uvx --from injection', ['--from', 'evil-package', 'mcp-snowflake-server==0.4.0']],
      ['extra executable option', ['mcp-snowflake-server==0.4.0', '--config', '/tmp/evil']],
    ])('rejects uvx %s', (_label, args) => {
      expect(() =>
        createStdioTransport(
          {
            type: 'mcp_stdio',
            command: 'uvx',
            args,
          },
          undefined
        )
      ).toThrow(/uvx arguments are not allowed/i);
    });

    it('rejects omitted arguments for both approved runners', () => {
      for (const command of ['npx', 'uvx']) {
        expect(() =>
          createStdioTransport(
            {
              type: 'mcp_stdio',
              command,
            },
            undefined
          )
        ).toThrow(/arguments are not allowed/i);
      }
    });

    it('rejects commands with path separators', () => {
      expect(() =>
        createStdioTransport({ ...baseTransport, command: '../npx' }, undefined)
      ).toThrow(/path separators/);

      expect(() =>
        createStdioTransport({ ...baseTransport, command: '/usr/bin/npx' }, undefined)
      ).toThrow(/path separators/);

      expect(() =>
        createStdioTransport({ ...baseTransport, command: 'path\\to\\npx' }, undefined)
      ).toThrow(/path separators/);
    });
  });

  describe('resolveStdioEnv() env var filtering', () => {
    it('includes allowed system env vars when present', () => {
      vi.stubEnv('PATH', '/usr/bin');
      vi.stubEnv('HOME', '/home/user');
      vi.stubEnv('SHELL', '/bin/bash');
      vi.stubEnv('SECRET_KEY', 'leaked');
      const env = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        SHELL: '/bin/bash',
        SECRET_KEY: 'leaked',
      };
      const result = resolveStdioEnv(baseTransport, env);
      expect(result['PATH']).toBe('/usr/bin');
      expect(result['HOME']).toBe('/home/user');
      expect(result['SHELL']).toBe('/bin/bash');
    });

    it('excludes BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', () => {
      vi.stubEnv('BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1');
      const env = { PATH: '/usr/bin', BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1' };
      const result = resolveStdioEnv(baseTransport, env);
      expect(result['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS']).toBeUndefined();
    });

    it('does not leak arbitrary env vars not in allowlist', () => {
      vi.stubEnv('MY_SECRET', 'leaked');
      vi.stubEnv('DATABASE_URL', 'postgres://...');
      vi.stubEnv('NODE_OPTIONS', '--require=/tmp/evil.cjs');
      vi.stubEnv('NODE_PATH', '/tmp/evil-modules');
      vi.stubEnv('npm_config_prefix', '/tmp/evil-prefix');
      const env = { PATH: '/usr/bin', MY_SECRET: 'leaked', DATABASE_URL: 'postgres://...' };
      const result = resolveStdioEnv(baseTransport, env);
      expect(result['MY_SECRET']).toBeUndefined();
      expect(result['DATABASE_URL']).toBeUndefined();
      expect(result['NODE_OPTIONS']).toBeUndefined();
      expect(result['NODE_PATH']).toBeUndefined();
      expect(result['npm_config_prefix']).toBeUndefined();
    });

    it('allows only the reviewed credential env keys for each pinned server', () => {
      const bigQuery = resolveStdioEnv(
        {
          ...baseTransport,
          env: {
            GOOGLE_APPLICATION_CREDENTIALS: '${{ env.BIGQUERY_CREDENTIALS_FILE }}',
          },
        },
        { BIGQUERY_CREDENTIALS_FILE: '/tmp/gcp.json' },
        new Set(['BIGQUERY_CREDENTIALS_FILE'])
      );
      expect(bigQuery['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/tmp/gcp.json');

      const snowflake = resolveStdioEnv(
        {
          type: 'mcp_stdio',
          command: 'uvx',
          args: ['mcp-snowflake-server==0.4.0'],
          env: {
            SNOWFLAKE_ACCOUNT: '${{ env.SNOWFLAKE_ACCOUNT }}',
            SNOWFLAKE_PASSWORD: '${{ env.SNOWFLAKE_PASSWORD }}',
          },
        },
        {
          SNOWFLAKE_ACCOUNT: 'acct',
          SNOWFLAKE_PASSWORD: 'secret',
        },
        new Set(['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_PASSWORD'])
      );
      expect(snowflake['SNOWFLAKE_ACCOUNT']).toBe('acct');
      expect(snowflake['SNOWFLAKE_PASSWORD']).toBe('secret');
    });

    it.each([
      ['PATH executable substitution', 'PATH', '/tmp/evil-bin'],
      ['Node preload', 'NODE_OPTIONS', '--require=/tmp/evil.cjs'],
      ['Node module injection', 'NODE_PATH', '/tmp/evil-modules'],
      ['npm registry substitution', 'npm_config_registry', 'https://evil.invalid'],
      ['arbitrary secret forwarding', 'DATABASE_URL', 'postgres://secret'],
    ])('rejects spec env %s', (_label, key, value) => {
      expect(() =>
        resolveStdioEnv(
          {
            ...baseTransport,
            env: { [key]: value },
          },
          {}
        )
      ).toThrow(/env key .* is not allowed/i);
    });
  });
});

describe('MCP HTTP transport headers', () => {
  it('passes auth headers through the SDK common header merger', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));

    const transport = await createStreamableHttpTransport(
      {
        type: 'mcp_http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          'X-Trace': '${{ env.TRACE_ID }}',
        },
        auth: {
          type: 'bearer',
          token: '${{ env.LINEAR_API_KEY }}',
        },
      },
      {
        LINEAR_API_KEY: 'linear-token',
        TRACE_ID: 'trace-1',
      },
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['TRACE_ID', 'LINEAR_API_KEY'])
    );

    const headers = await (
      transport as unknown as { _commonHeaders: () => Promise<Headers> }
    )._commonHeaders();

    expect(headers.get('Authorization')).toBe('Bearer linear-token');
    expect(headers.get('X-Trace')).toBe('trace-1');
    const transportFetch = (transport as unknown as { _fetch?: typeof fetch })._fetch;
    expect(transportFetch).toBeTypeOf('function');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(RESPONSE_BODY_LIMITS.mcpJson + 1),
          },
        })
      )
    );
    await expect(transportFetch!('https://mcp.example.com/mcp')).rejects.toThrow(
      'response body limit'
    );
  });

  it('rejects redirect responses even when a fetch double does not enforce redirect:error', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    const transport = await createStreamableHttpTransport(
      {
        type: 'mcp_http',
        url: 'https://mcp.example.com/mcp',
      },
      {}
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example/steal' },
        })
      )
    );

    const transportFetch = (transport as unknown as { _fetch: typeof fetch })._fetch;
    await expect(transportFetch('https://mcp.example.com/mcp')).rejects.toThrow(
      'MCP HTTP redirect blocked'
    );
  });
});

it('rejects undeclared stdio argument environment references', () => {
  expect(() =>
    createStdioTransport(baseTransport, undefined, {
      BIGQUERY_PROJECT_ID: 'synthetic',
      BIGQUERY_LOCATION: 'us-central1',
    })
  ).toThrow('Undeclared environment variable: BIGQUERY_PROJECT_ID');
});

it.each(['secrets', 'env'])(
  'scopes MCP host declarations to the supplied secrets map (%s)',
  async (namespace) => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    const host = { secrets: { HOST_TOKEN: 'host-canary' }, declaredSecretNames: ['HOST_TOKEN'] };
    const stdio = {
      ...baseTransport,
      env: { GOOGLE_APPLICATION_CREDENTIALS: '${{ ' + namespace + '.HOST_TOKEN }}' },
    };
    const http = {
      type: 'mcp_http' as const,
      url: 'https://example.com/mcp',
      headers: { 'X-Token': '${{ ' + namespace + '.HOST_TOKEN }}' },
    };
    expect(() => resolveStdioEnv(stdio, {}, new Set(), { secrets: host.secrets })).toThrow(
      'Undeclared'
    );
    if (namespace === 'secrets') {
      expect(resolveStdioEnv(stdio, {}, new Set(), host)).toMatchObject({
        GOOGLE_APPLICATION_CREDENTIALS: 'host-canary',
      });
      const transport = await createStreamableHttpTransport(
        http,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        new Set(),
        host
      );
      await transport.close();
    } else {
      expect(() => resolveStdioEnv(stdio, {}, new Set(), host)).toThrow('Undeclared');
      await expect(
        createStreamableHttpTransport(
          http,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          new Set(),
          host
        )
      ).rejects.toThrow('Undeclared');
    }
  }
);
