import { IntegrationSpecSchema } from '../../src/framework/extractor/resource.js';
import { WebhookActionSchema } from '../../src/framework/extractor/action.js';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceSchema } from '../../src/framework/core/source.js';
import { buildApiIntegrationSpec } from '../../src/runtime/api-integration-spec.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { loadIntegrationSpec } from '../../src/commands/common.js';
import { makeResource } from '../helpers/fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('integration environment declarations', () => {
  it.each(['env', 'secrets'])(
    'rejects undeclared %s credentials in custom API YAML before requests',
    async (namespace) => {
      const source = SourceSchema.parse(
        YAML.parse(`
spec_version: '2'
type: integration
source_type: custom_api
name: custom
transports:
  - id: api
    type: http
    base_url: https://api.example.com
    headers:
      X-Token: \${{ ${namespace}.SNOWFLAKE_PASSWORD }}
`)
      );
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      const integration = buildApiIntegrationSpec(
        source,
        source.transports[0]! as Parameters<typeof buildApiIntegrationSpec>[1]
      );
      const client = new ExtractorClient({
        integration,
        env: { SNOWFLAKE_PASSWORD: 'must-not-appear' },
        secrets: { SNOWFLAKE_PASSWORD: 'must-not-appear' },
      });
      const error = await client
        .request({ operation: makeResource() })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        cause: {
          message:
            'Undeclared environment variable: SNOWFLAKE_PASSWORD. Add SNOWFLAKE_PASSWORD to auth_env_vars.',
        },
      });
      expect(String(error)).not.toContain('must-not-appear');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it('carries v2 declarations through conversion', () => {
    const source = SourceSchema.parse({
      spec_version: '2',
      type: 'integration',
      name: 'custom',
      auth_env_vars: ['SERVICE_TOKEN'],
      transports: [{ id: 'api', type: 'http', base_url: 'https://api.example.com' }],
    });
    expect(
      buildApiIntegrationSpec(
        source,
        source.transports[0]! as Parameters<typeof buildApiIntegrationSpec>[1]
      ).auth_env_vars
    ).toEqual(['SERVICE_TOKEN']);
  });
  it.each(['1', '2'])('loads explicit metadata declarations for v%s', (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'declared-env-'));
    try {
      const sourceDir = join(directory, 'custom');
      mkdirSync(sourceDir);
      vi.stubEnv('BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR', directory);
      const file = join(sourceDir, 'source.yml');
      writeFileSync(
        file,
        YAML.stringify({
          spec_version: version,
          type: 'integration',
          name: 'custom',
          auth_env_vars: ['SERVICE_TOKEN'],
          ...(version === '1'
            ? { transport: { type: 'http', base_url: 'https://api.example.com' } }
            : { transports: [{ id: 'api', type: 'http', base_url: 'https://api.example.com' }] }),
        })
      );
      writeFileSync(
        join(sourceDir, 'meta.yml'),
        YAML.stringify({ auth_setup: [{ env: 'SERVICE_HOST' }] })
      );
      expect(loadIntegrationSpec(file)).toMatchObject({
        auth_env_vars: ['SERVICE_TOKEN', 'SERVICE_HOST'],
      });
      const aliasDir = join(directory, 'alias');
      mkdirSync(aliasDir);
      symlinkSync(file, join(aliasDir, 'source.yml'));
      writeFileSync(
        join(aliasDir, 'meta.yml'),
        YAML.stringify({ auth_setup: [{ env: 'OTHER_TOKEN' }] })
      );
      expect(loadIntegrationSpec(join(aliasDir, 'source.yml')).auth_env_vars).toEqual([
        'SERVICE_TOKEN',
        'SERVICE_HOST',
      ]);
      vi.stubEnv('BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR', '');
      expect(loadIntegrationSpec(file).auth_env_vars).toEqual(['SERVICE_TOKEN']);
      vi.stubEnv('BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR', directory);
      const flat = join(directory, 'custom.yml');
      writeFileSync(flat, YAML.stringify(loadIntegrationSpec(file)));
      writeFileSync(
        join(directory, 'meta.yml'),
        YAML.stringify({ auth_setup: [{ env: 'OTHER_TOKEN' }] })
      );
      expect(loadIntegrationSpec(flat).auth_env_vars).not.toContain('OTHER_TOKEN');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it.each(['secrets', 'env'])(
  'scopes host declarations to the secrets namespace (%s)',
  async (namespace) => {
    const integration = {
      spec_version: '1' as const,
      type: 'integration' as const,
      name: 'host_custom',
      transport: {
        type: 'http' as const,
        base_url: 'https://api.example.com',
        headers: { 'X-Token': '${{ ' + namespace + '.HOST_TOKEN }}' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ExtractorClient({
      integration,
      secrets: { HOST_TOKEN: 'host-canary' },
      declaredSecretNames: ['HOST_TOKEN'],
    });
    if (namespace === 'secrets') {
      await client.request({ operation: makeResource() });
      expect(fetchMock).toHaveBeenCalledOnce();
    } else {
      await expect(client.request({ operation: makeResource() })).rejects.toMatchObject({
        cause: { message: expect.stringContaining('Undeclared') },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  }
);

it.each(['BAD-NAME', 'BAD.NAME', '1TOKEN'])(
  'rejects invalid declaration name %s in integration and webhook schemas',
  (name) => {
    const source = {
      spec_version: '1',
      type: 'integration',
      name: 'test',
      auth_env_vars: [name],
      transport: { type: 'http', base_url: 'https://example.com' },
    };
    expect(IntegrationSpecSchema.safeParse({ ...source, auth_env_vars: ['TOKEN'] }).success).toBe(
      true
    );
    expect(IntegrationSpecSchema.safeParse(source).success).toBe(false);
    expect(
      SourceSchema.safeParse({
        spec_version: '2',
        type: 'integration',
        name: 'test',
        auth_env_vars: [name],
        transports: [{ id: 'api', type: 'http', base_url: 'https://example.com' }],
      }).success
    ).toBe(false);
    const action = {
      spec_version: '1',
      type: 'action',
      name: 'test',
      description: 'Test action',
      input: {},
      transport: 'webhook',
      auth_env_vars: [name],
      webhook: { url: 'https://example.com' },
    };
    expect(WebhookActionSchema.safeParse({ ...action, auth_env_vars: ['TOKEN'] }).success).toBe(
      true
    );
    expect(WebhookActionSchema.safeParse(action).success).toBe(false);
  }
);

it('treats an oauth2 resource env reference like the client_id and client_secret references', async () => {
  const outcome = async (
    authEnvVars: string[],
    resource: string,
    env: Record<string, string>
  ): Promise<{ error?: string; staticError?: string; tokenBody?: string; calls: number }> => {
    const source = SourceSchema.parse({
      spec_version: '2',
      type: 'integration',
      source_type: 'custom_api',
      name: 'custom',
      auth_env_vars: authEnvVars,
      transports: [
        {
          id: 'api',
          type: 'http',
          base_url: 'https://api.example.com',
          auth: {
            type: 'oauth2',
            grant_type: 'client_credentials',
            token_url: 'https://auth.example.com/oauth/token',
            client_id: '${{ env.CLIENT_ID }}',
            client_secret: '${{ env.CLIENT_SECRET }}',
            resource,
          },
        },
      ],
    });
    const integration = buildApiIntegrationSpec(
      source,
      source.transports[0]! as Parameters<typeof buildApiIntegrationSpec>[1]
    );
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          String(url).startsWith('https://auth.example.com/')
            ? new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }))
            : new Response('[]')
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    let staticError: string | undefined;
    try {
      assertDeclaredEnvironmentReferences(integration, integration.auth_env_vars);
    } catch (cause) {
      staticError = (cause as Error).message;
    }
    const error = await new ExtractorClient({ integration, env })
      .request({ operation: makeResource() })
      .then(
        () => undefined,
        (cause: { cause?: Error }) => cause.cause?.message
      );
    const tokenCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith('https://auth.example.com/')
    );
    return {
      ...(error === undefined ? {} : { error }),
      ...(staticError === undefined ? {} : { staticError }),
      ...(tokenCall === undefined ? {} : { tokenBody: tokenCall[1]?.body as string }),
      calls: fetchMock.mock.calls.length,
    };
  };
  const env = {
    CLIENT_ID: 'declared-id',
    CLIENT_SECRET: 'declared-secret',
    API_HOST: 'api.example.com',
  };
  const all = ['CLIENT_ID', 'CLIENT_SECRET', 'API_HOST'];
  const templated = 'https://${{ env.API_HOST }}/';

  const declared = await outcome(all, templated, env);
  expect(declared.error).toBeUndefined();
  expect(declared.staticError).toBeUndefined();
  expect(new URLSearchParams(declared.tokenBody).get('resource')).toBe('https://api.example.com/');
  expect(declared.calls).toBe(2);

  const undeclared = (name: string) =>
    outcome(
      all.filter((entry) => entry !== name),
      templated,
      { ...env, CLIENT_SECRET: `undeclared-${name}-secret` }
    );
  const normalize = (result: Awaited<ReturnType<typeof outcome>>, name: string) =>
    JSON.parse(JSON.stringify(result).replaceAll(name, '<NAME>'));
  const missingClientId = normalize(await undeclared('CLIENT_ID'), 'CLIENT_ID');
  const missingClientSecret = normalize(await undeclared('CLIENT_SECRET'), 'CLIENT_SECRET');
  const missingResource = normalize(await undeclared('API_HOST'), 'API_HOST');
  const message = 'Undeclared environment variable: <NAME>. Add <NAME> to auth_env_vars.';
  expect(missingClientId).toEqual({ error: message, staticError: message, calls: 0 });
  expect(missingClientSecret).toEqual(missingClientId);
  expect(missingResource).toEqual(missingClientId);

  const literal = await outcome(['CLIENT_ID', 'CLIENT_SECRET'], 'https://api.example.com/v2', {
    CLIENT_ID: 'declared-id',
    CLIENT_SECRET: 'literal-resource-secret',
  });
  expect(literal.error).toBeUndefined();
  expect(literal.staticError).toBeUndefined();
  expect(new URLSearchParams(literal.tokenBody).get('resource')).toBe('https://api.example.com/v2');
});
