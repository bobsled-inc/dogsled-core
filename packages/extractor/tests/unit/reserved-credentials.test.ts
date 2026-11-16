import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExtractCommand } from '../../src/commands/extract.js';
import { setDnsLookupForTests } from '../../src/framework/core/index.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { McpExtractorClient } from '../../src/runtime/mcp-client.js';
import { clearOAuth2TokenCache, fetchOAuth2Token } from '../../src/runtime/mcp-oauth2.js';
import { makeProvider, makeResource } from '../helpers/fixtures.js';

const BUNDLED_DIR = fileURLToPath(new URL('../../../integrations/sources', import.meta.url));
const CANARY = 'synthetic-reserved-canary';
const RESERVED = 'Reserved credential name';

const fetch = vi.fn(
  async () =>
    new Response(JSON.stringify([{ id: 1, name: 'one' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
);

function sentAuthorization(): string | null {
  const init = fetch.mock.calls[0]?.at(1) as RequestInit | undefined;
  return new Headers(init?.headers).get('authorization');
}

function projectIntegration(token: string, authEnvVars: string[]) {
  return YAML.stringify({
    spec_version: '1',
    type: 'integration',
    name: 'custom',
    auth_env_vars: authEnvVars,
    transport: {
      type: 'http',
      base_url: 'https://api.example.com',
      auth: { type: 'bearer', token },
    },
  });
}

describe('reserved credentials through extract run', () => {
  let root: string;
  let output: string;
  const cwd = process.cwd();
  const exitCode = process.exitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reserved-credentials-'));
    mkdirSync(join(root, 'integrations'));
    mkdirSync(join(root, 'resources'));
    output = '';
    fetch.mockClear();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('BOBSLED_CORE_BUNDLED_INTEGRATIONS_DIR', BUNDLED_DIR);
    vi.stubEnv('SLACK_BOT_TOKEN', CANARY);
    vi.stubEnv('GITHUB_TOKEN', CANARY);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', CANARY);
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((value) => {
        output += String(value);
        return true;
      });
    }
    process.chdir(root);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = exitCode;
    setDnsLookupForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function extract(integration: string, resource: string, ...flags: string[]) {
    const program = new Command();
    registerExtractCommand(program);
    await program
      .parseAsync(['run', resource, '--integration', integration, '--no-state-write', ...flags], {
        from: 'user',
      })
      .catch((error: unknown) => {
        output += String(error);
      });
  }

  function writeProjectResource(integration: string, overrides: Record<string, unknown> = {}) {
    writeFileSync(
      join(root, 'resources/items.yml'),
      YAML.stringify({ ...makeResource(), name: 'items', integration, ...overrides })
    );
  }

  function expectBlocked(reference: string) {
    expect(fetch).not.toHaveBeenCalled();
    expect(output).toContain(`${RESERVED} ${reference}`);
    expect(output).not.toContain('Missing env');
    expect(output).not.toContain(CANARY);
  }

  describe.each([
    ['slack', 'users', 'SLACK_BOT_TOKEN'],
    ['github', 'repos', 'GITHUB_TOKEN'],
  ])('built-in %s source', (integration, resource, name) => {
    it('sends the token a host declared for the run', async () => {
      await extract(integration, resource, '--host-env-names-json', JSON.stringify([name]));
      expect(sentAuthorization()).toBe(`Bearer ${CANARY}`);
    });

    it('sends the token from a local shell with no host', async () => {
      await extract(integration, resource);
      expect(sentAuthorization()).toBe(`Bearer ${CANARY}`);
    });

    it('ignores the ambient token when a host owns the run and did not declare it', async () => {
      await extract(integration, resource, '--host-env-names-json', '[]');
      expectBlocked(`env.${name}`);
    });
  });

  it('grants a host-declared name to a Project copy of the source', async () => {
    writeFileSync(
      join(root, 'integrations/custom.yml'),
      projectIntegration('${{ env.SLACK_BOT_TOKEN }}', [])
    );
    writeProjectResource('custom');
    await extract('custom', 'items', '--host-env-names-json', '["SLACK_BOT_TOKEN"]');
    expect(sentAuthorization()).toBe(`Bearer ${CANARY}`);
  });

  it.each([
    ['env', 'SLACK_BOT_TOKEN'],
    ['secrets', 'SLACK_BOT_TOKEN'],
    ['env', 'AWS_SECRET_ACCESS_KEY'],
    ['secrets', 'AWS_SECRET_ACCESS_KEY'],
  ])('blocks a Project integration opting in to %s.%s', async (namespace, name) => {
    writeFileSync(
      join(root, 'integrations/custom.yml'),
      projectIntegration('${{ ' + namespace + '.' + name + ' }}', [name])
    );
    writeProjectResource('custom');
    await extract('custom', 'items');
    expectBlocked(`${namespace}.${name}`);
  });

  it('keeps other reserved names blocked when the host declared a different one', async () => {
    writeFileSync(
      join(root, 'integrations/custom.yml'),
      projectIntegration('${{ env.AWS_SECRET_ACCESS_KEY }}', ['AWS_SECRET_ACCESS_KEY'])
    );
    writeProjectResource('custom');
    await extract('custom', 'items', '--host-env-names-json', '["SLACK_BOT_TOKEN"]');
    expectBlocked('env.AWS_SECRET_ACCESS_KEY');
  });

  it.each(['SLACK_BOT_TOKEN', 'AWS_SECRET_ACCESS_KEY'])(
    'blocks a Project resource reading %s through a built-in source',
    async (name) => {
      writeProjectResource('slack', {
        api: {
          endpoint: '/users.list',
          method: 'GET',
          headers: { 'X-Copy': '${{ env.' + name + ' }}' },
        },
      });
      await extract('slack', 'items');
      expectBlocked(`env.${name}`);
    }
  );

  it('blocks built-in auth for a Project resource on a built-in source', async () => {
    writeProjectResource('slack', { api: { endpoint: '/users.list', method: 'GET' } });
    await extract('slack', 'items');
    expectBlocked('env.SLACK_BOT_TOKEN');
  });
});

describe('reserved credentials through MCP OAuth2', () => {
  const auth = {
    type: 'oauth2' as const,
    token_url: 'https://example.com/token',
    client_id: 'client',
    client_secret: '${{ env.SLACK_BOT_TOKEN }}',
  };
  const env = { SLACK_BOT_TOKEN: CANARY };
  const declared = new Set(['SLACK_BOT_TOKEN']);

  afterEach(() => {
    clearOAuth2TokenCache();
    setDnsLookupForTests(undefined);
    vi.unstubAllGlobals();
  });

  it('blocks a declared name and resolves a trusted one', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'token', expires_in: 60 })))
    );
    await expect(
      fetchOAuth2Token(auth, env, undefined, undefined, undefined, declared)
    ).rejects.toThrow(RESERVED);
    await expect(
      fetchOAuth2Token(auth, env, undefined, undefined, undefined, declared, {
        trustedCredentialNames: declared,
      })
    ).resolves.toBe('token');
  });
});

describe('reserved credentials on host-injected clients', () => {
  const secrets = { SLACK_BOT_TOKEN: CANARY };

  afterEach(() => {
    setDnsLookupForTests(undefined);
    vi.unstubAllGlobals();
  });

  it.each([
    ['declared by the host', ['SLACK_BOT_TOKEN'], 1],
    ['only present in the injected map', undefined, 0],
  ])('sends an HTTP credential %s only when declared', async (_case, names, sent) => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    const hostFetch = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', hostFetch);
    const client = new ExtractorClient({
      integration: makeProvider('https://api.example.com', {
        auth_env_vars: ['SLACK_BOT_TOKEN'],
        auth: { type: 'bearer', token: '${{ env.SLACK_BOT_TOKEN }}' },
      }),
      secrets,
      env: secrets,
      declaredSecretNames: names,
    });
    const failure = await client
      .request({ operation: { api: { endpoint: '/items', method: 'GET' }, input: {} } })
      .then(
        () => undefined,
        (error: Error) => error
      );
    expect(hostFetch).toHaveBeenCalledTimes(sent);
    expect((failure?.cause as Error | undefined)?.message ?? '').toContain(sent ? '' : RESERVED);
  });

  it('applies the same rule to an MCP stdio environment', () => {
    const integration = {
      ...makeProvider('https://api.example.com'),
      auth_env_vars: ['SLACK_BOT_TOKEN'],
      transport: {
        type: 'mcp_stdio',
        command: 'uvx',
        args: ['mcp-snowflake-server==0.4.0'],
        env: { SNOWFLAKE_PASSWORD: '${{ env.SLACK_BOT_TOKEN }}' },
      },
    } as never;
    expect(() => new McpExtractorClient({ integration, env: secrets })).toThrow(RESERVED);
    expect(
      () =>
        new McpExtractorClient({
          integration,
          env: secrets,
          trustedCredentialNames: ['SLACK_BOT_TOKEN'],
        })
    ).not.toThrow();
  });
});
