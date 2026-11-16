import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { IntegrationSpecSchema, ResourceSpecSchema } from '@bobsled-inc/extractor/extractor';
import type { LoadedProject } from '@bobsled-inc/model-spec/project';
import type { AgentAssignment } from '@bobsled-inc/model-spec/agentic';
import { createAgenticHost, type AgenticResourceSpecLoader } from '../../../src/agentic.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => vi.stubEnv('BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1'));

const request = {
  source: 'research.custom_search',
  operation: 'search',
  arguments: { search: 'sample document', limit: 1 },
};
const context = {
  assignment: { allowed_sources: [request.source] } as AgentAssignment,
  signal: new AbortController().signal,
};

function host(integrationSpecLoader: AgenticResourceSpecLoader, paid = true) {
  return createAgenticHost({
    project: {
      integrations: new Map(),
      models: [],
      sourceEntries: new Map([
        [
          request.source,
          {
            kind: 'api_resource',
            integration: 'custom_provider',
            resource: 'custom_search',
            connection: 'research',
          },
        ],
      ]),
    } as LoadedProject,
    executeAgent: vi.fn(),
    platform: {},
    secretResolver: { resolve: async () => 'synthetic-host-key' },
    tokensPerAssignment: 1024,
    allowBillableSources: paid ? [request.source] : [],
    integrationSpecLoader,
  });
}

describe('host supplied agent resource definitions', () => {
  it('reads a custom resource through its selected source transport', async () => {
    const integration = IntegrationSpecSchema.parse({
      auth_env_vars: ['DOCUMENT_TOKEN'],
      spec_version: '2',
      type: 'source',
      name: 'custom_provider',
      transports: [
        {
          id: 'rest',
          base_url: 'https://example.com',
          auth: { type: 'bearer', token: '${{ env.DOCUMENT_TOKEN }}' },
        },
      ],
      default_transport: 'rest',
    });
    const resource = ResourceSpecSchema.parse({
      type: 'resource',
      name: 'custom_search',
      description: 'Read a document by its ID.',
      via: 'rest',
      api: { endpoint: '/documents/${{ input.document_id }}/content', method: 'GET' },
      input: { document_id: { type: 'string' } },
      query: { search: { dialect: 'provider_search', bind: { input: 'document_id' } } },
      output: {
        id: { type: 'string', path: '$.id' },
        content: { type: 'object', path: '$.content' },
      },
      extract: { record_path: '$.results' },
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ id: 'block-1', content: { text: 'A document.' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const result = await host(() => ({ integration, resource }), false).sources!(
      {
        ...request,
        arguments: { search: 'document-1', limit: 1 },
      },
      context
    );
    expect(result).toMatchObject({ rows: [{ id: 'block-1', content: { text: 'A document.' } }] });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://example.com/documents/document-1/content'
    );
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer synthetic-host-key'
    );
  });

  it('queries a resource outside the bundled catalog with host credentials and bounds', async () => {
    const specs = loadQueryableResourceSpecs('exa', 'search', { includeBillable: true })!;
    const loader = vi.fn(() => ({
      ...specs,
      resource: { ...specs.resource, name: 'custom_search' },
    }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ id: '1', title: 'Document', url: 'https://example.com/doc' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const result = await host(loader).sources!(request, context);
    expect(loader).toHaveBeenCalledWith('custom_provider', 'custom_search', {
      includeBillable: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.exa.ai/search');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-host-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: 'sample document' });
    expect(result).toMatchObject({
      rows: [{ title: 'Document' }],
      retrieved_at: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-host-key');
  });

  it('keeps paid source approval in Dogsled when the host supplies the resource', async () => {
    const specs = loadQueryableResourceSpecs('exa', 'search', { includeBillable: true });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const loader = vi.fn(() => specs);
    await expect(host(loader, false).sources!(request, context)).rejects.toThrow('source policy');
    expect(loader).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not call the loader for an undeclared source', async () => {
    const loader = vi.fn();
    await expect(
      host(loader).sources!({ ...request, source: 'private.data' }, context)
    ).rejects.toThrow('not allowed');
    expect(loader).not.toHaveBeenCalled();
  });

  it('preserves a loader failure privately without falling back to the catalog', async () => {
    const cause = new Error('private-provider-detail');
    const loader = vi.fn(() => {
      throw cause;
    });
    const error = await host(loader).sources!(request, context).catch(
      (failure: unknown) => failure
    );
    expect(error).toMatchObject({ cause });
    expect(JSON.stringify(error)).not.toContain('private-provider-detail');
  });

  it('stops when the supplied loader cannot resolve the resource', async () => {
    const loader = vi.fn(() => undefined);
    const error = await host(loader).sources!(request, context).catch(
      (failure: unknown) => failure
    );
    expect(error).toMatchObject({ cause: { message: 'Agent source has no query interface' } });
    expect(loader).toHaveBeenCalledOnce();
  });
});
