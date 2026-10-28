import { queryResourceFanOut } from '@bobsled-inc/extractor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getResource, getSource } from '../src/index.js';

function makeNotionPage(id: string) {
  return {
    object: 'page',
    id,
    url: `https://notion.example/${id}`,
    archived: false,
    in_trash: false,
    created_time: '2026-08-01T00:00:00.000Z',
    last_edited_time: '2026-08-01T00:00:00.000Z',
    parent: { type: 'workspace' },
    created_by: { id: 'user-1' },
    last_edited_by: { id: 'user-1' },
  };
}

const notionPage = makeNotionPage('page-1');

const notionBlock = {
  object: 'block',
  id: 'block-1',
  type: 'paragraph',
  has_children: false,
  archived: false,
  in_trash: false,
  created_time: '2026-08-01T00:00:00.000Z',
  last_edited_time: '2026-08-01T00:00:00.000Z',
  parent: { type: 'page_id', page_id: 'page-1' },
  created_by: { id: 'user-1' },
  last_edited_by: { id: 'user-1' },
};

function listResponse(results: unknown[], nextCursor: string | null = null): Response {
  return Response.json({
    object: 'list',
    results,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
  });
}

describe('Notion pages-to-blocks live fan-out', () => {
  beforeEach(() => vi.stubEnv('DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('omits an unbound search query and fans out page blocks with a row limit', async () => {
    const requestBodies: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/search') {
        requestBodies.push(JSON.parse(String(init?.body)) as unknown);
        return listResponse([notionPage]);
      }
      if (path === '/v1/blocks/page-1/children') {
        return listResponse([notionBlock]);
      }
      throw new Error(`Unexpected Notion path: ${path}`);
    });

    const source = getSource('notion');
    const pages = getResource('notion', 'pages_rest');
    const blocks = getResource('notion', 'blocks');
    const result = await queryResourceFanOut({
      integration: source.spec,
      resources: [pages.resource, blocks.resource],
      target: 'blocks',
      mode: 'fan_out',
      limit: 10,
      secrets: { NOTION_API_TOKEN: 'test-token' },
    });

    expect(requestBodies).toEqual([
      {
        filter: { property: 'object', value: 'page' },
        page_size: 100,
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
      },
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 'block-1' });
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('/v1/blocks/page-1/children');
    expect(result.counts.providerAttempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('includes a non-empty search query in the root request', async () => {
    const requestBodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path !== '/v1/search') {
        throw new Error(`Unexpected Notion path: ${path}`);
      }
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return listResponse([notionPage]);
    });

    const source = getSource('notion');
    const pages = getResource('notion', 'pages_rest');
    const result = await queryResourceFanOut({
      integration: source.spec,
      resources: [pages.resource],
      target: 'pages_rest',
      mode: 'fan_out',
      search: 'Roadmap',
      limit: 10,
      secrets: { NOTION_API_TOKEN: 'test-token' },
    });

    expect(requestBodies).toEqual([
      {
        query: 'Roadmap',
        filter: { property: 'object', value: 'page' },
        page_size: 100,
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
      },
    ]);
    expect(result.records[0]).toMatchObject({ id: 'page-1' });
  });

  it('streams paginated POST parents into paginated children until target demand is met', async () => {
    const requests: Array<{ path: string; cursor: string | null; body: unknown }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      requests.push({ path: url.pathname, cursor: url.searchParams.get('start_cursor'), body });

      if (url.pathname === '/v1/search') {
        const startCursor = (body as { start_cursor?: unknown } | undefined)?.start_cursor;
        if (startCursor === undefined) {
          return listResponse(
            [makeNotionPage('page-empty-1'), makeNotionPage('page-empty-2')],
            'cursor-2'
          );
        }
        if (startCursor === 'cursor-2') {
          return listResponse([makeNotionPage('page-full'), makeNotionPage('page-unused')]);
        }
      }

      if (
        url.pathname === '/v1/blocks/page-empty-1/children' ||
        url.pathname === '/v1/blocks/page-empty-2/children'
      ) {
        return listResponse([]);
      }
      if (url.pathname === '/v1/blocks/page-full/children') {
        const blockCursor = url.searchParams.get('start_cursor');
        const start = blockCursor === null ? 0 : 6;
        const count = blockCursor === null ? 6 : 6;
        const blocks = Array.from({ length: count }, (_, index) => ({
          ...notionBlock,
          id: `block-${start + index + 1}`,
          parent: { type: 'page_id', page_id: 'page-full' },
        }));
        return listResponse(blocks, blockCursor === null ? 'child-cursor-2' : null);
      }

      throw new Error(`Unexpected Notion request: ${url.pathname}${url.search}`);
    });

    const source = getSource('notion');
    const pages = getResource('notion', 'pages_rest');
    const blocks = getResource('notion', 'blocks');
    const result = await queryResourceFanOut({
      integration: source.spec,
      resources: [pages.resource, blocks.resource],
      target: 'blocks',
      mode: 'fan_out',
      limit: 10,
      secrets: { NOTION_API_TOKEN: 'test-token' },
    });

    expect(result.records).toHaveLength(10);
    expect(result.limitReached).toBe(true);
    expect(result.counts).toMatchObject({
      parentWorkItems: 3,
      targetRows: 10,
      providerAttempts: 6,
      requestCount: 6,
      maxConcurrency: 1,
    });
    expect(requests.map(({ path }) => path)).toEqual([
      '/v1/search',
      '/v1/blocks/page-empty-1/children',
      '/v1/blocks/page-empty-2/children',
      '/v1/search',
      '/v1/blocks/page-full/children',
      '/v1/blocks/page-full/children',
    ]);
    expect(requests[3]).toMatchObject({
      path: '/v1/search',
      cursor: null,
      body: expect.objectContaining({ start_cursor: 'cursor-2' }),
    });
    expect(requests[5]).toMatchObject({
      path: '/v1/blocks/page-full/children',
      cursor: 'child-cursor-2',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('traverses every Notion POST page without a limit and keeps the cursor in JSON', async () => {
    const requests: Array<{ cursor: string | null; body: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ cursor: url.searchParams.get('start_cursor'), body });
      return body.start_cursor === undefined
        ? listResponse([makeNotionPage('page-1')], 'cursor-2')
        : listResponse([makeNotionPage('page-2')]);
    });

    const source = getSource('notion');
    const pages = getResource('notion', 'pages_rest');
    const result = await queryResourceFanOut({
      integration: source.spec,
      resources: [pages.resource],
      target: 'pages_rest',
      mode: 'fan_out',
      secrets: { NOTION_API_TOKEN: 'test-token' },
    });

    expect(result.records.map((record) => record.id)).toEqual(['page-1', 'page-2']);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      cursor: null,
      body: expect.objectContaining({ start_cursor: 'cursor-2' }),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
