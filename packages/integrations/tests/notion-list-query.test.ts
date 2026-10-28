import { queryResource } from '@bobsled-inc/extractor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getResource, getSource } from '../src/index.js';

describe('Notion users list query', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists users through the bounded resource API without provider-side filters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          results: [
            {
              object: 'user',
              id: 'user-1',
              type: 'person',
              name: 'Test User',
              avatar_url: null,
              person: { email: 'test@example.invalid' },
            },
          ],
          next_cursor: null,
          has_more: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const source = getSource('notion');
    const users = getResource('notion', 'users_rest');

    const result = await queryResource({
      integration: source.spec,
      resource: users.resource,
      secrets: { NOTION_API_TOKEN: 'test-token' },
      limit: 5,
    });

    expect(result.records).toEqual([
      expect.objectContaining({ id: 'user-1', type: 'person', name: 'Test User' }),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/v1/users?page_size=100');
  });
});
