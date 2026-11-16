import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSecretResolver, withDeclaredSecretNames } from '@bobsled-inc/connections';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import type { AgentAssignment } from '@bobsled-inc/model-spec/agentic';
import { createAgenticSources } from '../../../src/runtime/agentic-sources.js';

// Use the real catalog, query mapper, authorization check, and HTTP transport.
// Only the network response and a synthetic environment credential are supplied.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => vi.stubEnv('BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1'));
describe('agent source Exa catalog bridge', () => {
  it('denies unpaid requests and maps an authorized bounded search without exposing credentials', async () => {
    vi.stubEnv('EXA_API_KEY', 'synthetic-exa-test-key');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: '1', title: 'Acme', url: 'https://example.com/acme', summary: 'A business.' },
            { id: '2', title: 'Other', url: 'https://example.com/other' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const options = {
      inputs: {},
      project: {
        models: [],
        sourceEntries: new Map([
          [
            'web.search',
            { kind: 'api_resource', integration: 'exa', resource: 'search', connection: 'web' },
          ],
        ]),
      },
      contexts: [],
      secretResolver: new EnvSecretResolver(),
    } as unknown as Parameters<typeof createAgenticSources>[0];
    const context = {
      assignment: { allowed_sources: ['web.search'] } as AgentAssignment,
      signal: new AbortController().signal,
    };
    const request = {
      source: 'web.search',
      operation: 'search',
      arguments: { search: 'Acme business', limit: 1 },
    };
    await expect(createAgenticSources(options)(request, context)).rejects.toThrow('source policy');
    expect(fetch).not.toHaveBeenCalled();
    const result = await createAgenticSources({ ...options, allowBillableSources: ['web.search'] })(
      request,
      context
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.exa.ai/search');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: 'Acme business' });
    expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-exa-test-key');
    expect(result).toMatchObject({
      rows: [{ title: 'Acme', url: 'https://example.com/acme' }],
      retrieved_at: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-exa-test-key');
  });
});

describe('agent source credential names', () => {
  it.each(['HOST_SOURCE_KEY', 'GITHUB_TOKEN'])(
    'checks %s before invoking the host resolver',
    async (name) => {
      const loaded = loadQueryableResourceSpecs('exa', 'search', { includeBillable: true });
      expect(loaded).toBeDefined();
      const specs = JSON.parse(JSON.stringify(loaded).replaceAll('EXA_API_KEY', name));
      specs.integration.auth_env_vars = [];
      const resolve = vi.fn(async () => 'host-canary');
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const options = {
        inputs: {},
        project: {
          models: [],
          sourceEntries: new Map([
            [
              'web.search',
              { kind: 'api_resource', integration: 'exa', resource: 'search', connection: 'web' },
            ],
          ]),
        },
        contexts: [],
        secretResolver: withDeclaredSecretNames({ resolve }, [name]),
        integrationSpecLoader: () => specs,
        allowBillableSources: ['web.search'],
      } as unknown as Parameters<typeof createAgenticSources>[0];
      const context = {
        assignment: { allowed_sources: ['web.search'] } as AgentAssignment,
        signal: new AbortController().signal,
      };
      const request = {
        source: 'web.search',
        operation: 'search',
        arguments: { search: 'example', limit: 1 },
      };
      const pending = createAgenticSources(options)(request, context);
      if (name === 'GITHUB_TOKEN') {
        await expect(pending).rejects.toThrow('source policy');
        expect(resolve).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ rows: [] });
        expect(resolve).toHaveBeenCalledWith(name);
        expect(fetch).toHaveBeenCalledOnce();
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe('host-canary');
      }
    }
  );
});
