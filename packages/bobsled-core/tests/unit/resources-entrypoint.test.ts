import { getResource, getSource } from '@bobsled-inc/integrations';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getResourceCapabilities,
  isLookupOnlyApiResource,
  lookupResource,
  planQueryFanOut,
  queryResource,
  queryResourceFanOut,
} from '../../src/resources/index.js';

describe('@bobsled-inc/bobsled-core/resources', () => {
  const originalAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAllowPrivateHosts === undefined) {
      delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalAllowPrivateHosts;
    }
  });

  it('exposes the Resource operations needed by server hosts', () => {
    expect(typeof lookupResource).toBe('function');
    expect(typeof queryResource).toBe('function');
    expect(typeof planQueryFanOut).toBe('function');
    expect(typeof queryResourceFanOut).toBe('function');
    expect(typeof getResourceCapabilities).toBe('function');
    expect(typeof isLookupOnlyApiResource).toBe('function');
  });

  it('queries a bundled Notion REST resource through HTTP', async () => {
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'page-123',
              object: 'page',
              url: 'https://notion.example/page-123',
              parent: { type: 'workspace' },
              created_by: { id: 'user-1' },
              last_edited_by: { id: 'user-2' },
              archived: false,
              in_trash: false,
              created_time: '2026-08-01T00:00:00.000Z',
              last_edited_time: '2026-08-02T00:00:00.000Z',
            },
          ],
          next_cursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const source = getSource('notion');
    const resource = getResource('notion', 'pages_rest');
    const result = await queryResource({
      integration: source.spec,
      resource: resource.resource,
      search: 'roadmap',
      limit: 1,
      secrets: { NOTION_API_TOKEN: 'test-token' },
    });

    expect(result).toMatchObject({
      records: [
        {
          id: 'page-123',
          object: 'page',
          url: 'https://notion.example/page-123',
          parent_type: 'workspace',
        },
      ],
      requestCount: 1,
    });
  });
});
