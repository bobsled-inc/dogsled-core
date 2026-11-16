import { CustomRunnerRegistry, type ResolveRunnerOptions } from '@bobsled-inc/connections';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  resolveRunner: vi.fn(),
  queryResource: vi.fn(),
  load: vi.fn(),
}));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  interpolateSecrets: vi.fn(async (value) => value),
  resolveRunner: mocks.resolveRunner,
}));
vi.mock('@bobsled-inc/extractor', () => ({ queryResource: mocks.queryResource }));
vi.mock('@bobsled-inc/integrations', () => ({ loadQueryableResourceSpecs: mocks.load }));
import { createAgenticSources } from '../../../src/runtime/agentic-sources.js';
import type { AgentAssignment } from '@bobsled-inc/model-spec/agentic';

function fixture(allowBillableSources: string[] = [], runnerOptions?: ResolveRunnerOptions) {
  return createAgenticSources({
    runnerOptions,
    inputs: { people: [{ name: 'id', type: 'string', nullable: false }] },
    project: {
      models: [{ name: 'people', integration: 'local' }],
      sourceEntries: new Map([
        [
          'web.search',
          {
            kind: 'api_resource',
            integration: 'exa',
            resource: 'search',
            filter: { tenant: 'owned' },
            connection: 'web',
          },
        ],
      ]),
    },
    contexts: [
      {
        integration: { handle: 'local', integration: {} },
        dialect: 'duckdb',
        registry: new Map(),
        modelReg: new Map([['people', '"main"."people"']]),
      },
    ],
    secretResolver: {},
    allowBillableSources,
  } as unknown as Parameters<typeof createAgenticSources>[0]);
}
function context(signal = new AbortController().signal) {
  return { assignment: { allowed_sources: ['people', 'web.search'] } as AgentAssignment, signal };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([{ id: '1' }]);
  mocks.resolveRunner.mockResolvedValue({ query: mocks.query, close: mocks.close });
  mocks.load.mockReturnValue({ integration: {}, resource: {} });
  mocks.queryResource.mockImplementation(async (options) => {
    if (!(await options.authorizeBillable())) throw new Error('Paid query denied');
    options.onMappedRecord({ title: 'A' });
    return { records: [{ title: 'A' }] };
  });
});
describe('scoped agent source adapter', () => {
  it('uses the supplied SQL runner registry for scoped warehouse reads', async () => {
    const customRunners = new CustomRunnerRegistry();
    await fixture([], { customRunners })(
      { source: 'people', operation: 'read', arguments: {} },
      context()
    );
    expect(mocks.resolveRunner).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ customRunners })
    );
  });
  it('returns an empty first-run self source without reading a missing target', async () => {
    mocks.query.mockResolvedValue([]);
    const ctx = context();
    ctx.assignment.model_name = 'people';
    expect(
      await fixture()({ source: 'people', operation: 'read', arguments: {} }, ctx)
    ).toMatchObject({ rows: [] });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]![0]).toContain('information_schema.TABLES');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('reads existing self output and rejects metadata errors', async () => {
    const ctx = context();
    ctx.assignment.model_name = 'people';
    mocks.query
      .mockResolvedValueOnce([{ table_type: 'BASE TABLE' }])
      .mockResolvedValueOnce([{ id: '1' }]);
    expect(
      await fixture()({ source: 'people', operation: 'read', arguments: {} }, ctx)
    ).toMatchObject({ rows: [{ id: '1' }] });
    mocks.query.mockRejectedValueOnce(new Error('metadata access denied'));
    await expect(
      fixture()({ source: 'people', operation: 'read', arguments: {} }, ctx)
    ).rejects.toThrow('source policy');
  });

  it('keeps the driver cause private while preserving host diagnostics', async () => {
    const cause = Object.assign(new Error('private-password and private-row'), {
      code: '001138',
    });
    mocks.query.mockRejectedValueOnce(cause);
    const error = await fixture()(
      { source: 'people', operation: 'read', arguments: {} },
      context()
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Agent source request failed or was rejected by source policy',
      exitCode: 1,
      cause,
    });
    expect((error as Error).cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain('private-');
    expect(String(error)).not.toContain('private-');
    expect(Object.keys(error as object)).not.toContain('cause');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('preserves argument validation causes before database dispatch', async () => {
    const error = await fixture()(
      { source: 'people', operation: 'read', arguments: { filter: 'private-filter' } },
      context()
    ).catch((failure: unknown) => failure);
    // The agent learns which field to fix, never the value it sent.
    expect(error).toMatchObject({
      message: 'Agent source arguments are invalid: remove unknown filter',
    });
    expect(String(error)).not.toContain('private-filter');
    expect(JSON.stringify(error)).not.toContain('private-filter');
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
  });

  it('reads a mapped table with quoted columns and a bounded limit', async () => {
    const result = await fixture()(
      { source: 'people', operation: 'read', arguments: { columns: ['id'], limit: 2 } },
      context()
    );
    expect(result).toEqual({ rows: [{ id: '1' }], retrieved_at: expect.stringMatching(/^\d{4}-/) });
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT "id" FROM "main"."people" LIMIT 2',
      undefined,
      { signal: expect.any(AbortSignal) }
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    { source: 'private', operation: 'read', arguments: {} },
    { source: 'people', operation: 'read', arguments: { columns: ['password'] } },
    { source: 'people', operation: 'read', arguments: { columns: ['id; DROP TABLE people'] } },
    { source: 'people', operation: 'read', arguments: { sql: 'DELETE FROM people' } },
    { source: 'people', operation: 'read', arguments: { limit: 101 } },
    { source: 'people', operation: 'search', arguments: { search: 'name' } },
    {
      source: 'web.search',
      operation: 'search',
      arguments: { search: 'name', url: 'http://localhost' },
    },
  ])('rejects out of policy requests before dispatch', async (request) => {
    await expect(fixture()(request, context())).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.queryResource).not.toHaveBeenCalled();
  });
  it('refuses search on a source with a pinned filter instead of widening it', async () => {
    const error = await fixture(['web.search'])(
      { source: 'web.search', operation: 'search', arguments: { search: 'Acme' } },
      context()
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: 'This source has a pinned filter, so it supports read but not search',
    });
    expect(mocks.queryResource).not.toHaveBeenCalled();
  });
  it('requires explicit paid source authorization and forwards cancellation', async () => {
    const request = {
      source: 'web.search',
      operation: 'read',
      arguments: { limit: 3, filter: { tenant: 'other' } },
    };
    await expect(fixture()(request, context())).rejects.toThrow('source policy');
    const ctx = context();
    const result = await fixture(['web.search'])(request, ctx);
    expect(result).toMatchObject({ rows: [{ title: 'A' }] });
    expect(mocks.queryResource).toHaveBeenLastCalledWith(
      expect.objectContaining({
        limit: 3,
        signal: ctx.signal,
        filter: { tenant: 'owned' },
      })
    );
  });
  it('rejects oversized provider output while collecting records', async () => {
    mocks.queryResource.mockImplementation(async (options) => {
      options.onMappedRecord({ text: 'x'.repeat(65536) });
      return { records: [] };
    });
    await expect(
      fixture(['web.search'])({ source: 'web.search', operation: 'read', arguments: {} }, context())
    ).rejects.toThrow('Agent source result exceeds byte limit');
  });
  it('does not dispatch cancelled requests and redacts provider errors', async () => {
    await expect(
      fixture()(
        { source: 'people', operation: 'read', arguments: {} },
        context(AbortSignal.abort())
      )
    ).rejects.toThrow();
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
    mocks.query.mockRejectedValue(new Error('secret-password'));
    await expect(
      fixture()({ source: 'people', operation: 'read', arguments: {} }, context())
    ).rejects.toThrow('source policy');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
