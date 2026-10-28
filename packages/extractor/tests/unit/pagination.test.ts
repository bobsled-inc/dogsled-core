import { describe, expect, it, vi } from 'vitest';

import { paginate } from '../../src/runtime/pagination.js';
import {
  makeProvider as makeBaseProvider,
  makeResource as makeBaseResource,
} from '../helpers/fixtures.js';

const warn = vi.fn(async () => undefined);

describe('paginate', () => {
  it('yields a single page when pagination is disabled', async () => {
    const headers = new Headers();
    const fetcher = vi.fn().mockResolvedValue({
      data: [{ id: 1 }],
      headers,
      status: 200,
    });

    const pages = [];
    for await (const page of paginate(makeProvider(), makeResource(), fetcher, warn)) {
      pages.push(page);
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([{ data: [{ id: 1 }], headers, status: 200 }]);
  });

  it('follows cursor pagination until the cursor disappears', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [{ id: 1 }], next_cursor: 'abc' },
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: 2 }], next_cursor: null },
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        extract: {
          record_path: '$.items',
          pagination: {
            type: 'cursor',
            cursor_path: '$.next_cursor',
            cursor_param: 'cursor',
          },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1);
    expect(fetcher).toHaveBeenNthCalledWith(2, { cursor: 'abc' });
    expect(pages).toEqual([
      { items: [{ id: 1 }], next_cursor: 'abc' },
      { items: [{ id: 2 }], next_cursor: null },
    ]);
  });

  it('follows link_header pagination until no next link', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }],
        headers: new Headers({
          link: '<https://api.example.com/items?page=2>; rel="next"',
        }),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [{ id: 2 }],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        extract: {
          record_path: '$',
          pagination: { type: 'link_header' },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, undefined, 'https://api.example.com/items?page=2');
    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  });

  it('rejects link_header URLs with different origin (SSRF)', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      data: [{ id: 1 }],
      headers: new Headers({
        link: '<https://evil.com/steal>; rel="next"',
      }),
      status: 200,
    });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        extract: {
          record_path: '$',
          pagination: { type: 'link_header' },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    // Should only yield the first page, rejecting the cross-origin next link
    expect(pages).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('follows offset pagination until records are exhausted', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }, { id: 2 }],
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [{ id: 3 }],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        api: {
          endpoint: '/issues',
          method: 'GET',
          query_params: { limit: '2' },
        },
        extract: {
          record_path: '$',
          pagination: { type: 'offset', offset_param: 'offset', limit_param: 'limit' },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, { offset: 0, limit: 2 });
    expect(fetcher).toHaveBeenNthCalledWith(2, { offset: 2, limit: 2 });
    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  it('bounds offset page size by the remaining record limit', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }, { id: 2 }],
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [{ id: 3 }],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        api: {
          endpoint: '/issues',
          method: 'GET',
          query_params: { limit: '2' },
        },
        extract: {
          record_path: '$',
          pagination: { type: 'offset', offset_param: 'offset', limit_param: 'limit' },
        },
      }),
      fetcher,
      warn,
      { recordLimit: 3 }
    )) {
      pages.push(page.records);
    }

    expect(fetcher).toHaveBeenNthCalledWith(1, { offset: 0, limit: 2 });
    expect(fetcher).toHaveBeenNthCalledWith(2, { offset: 2, limit: 1 });
    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  it('follows page_number pagination until records are exhausted', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }, { id: 2 }],
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [{ id: 3 }],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        api: {
          endpoint: '/issues',
          method: 'GET',
          query_params: { per_page: '2' },
        },
        extract: {
          record_path: '$',
          pagination: { type: 'page_number', page_param: 'page', per_page_param: 'per_page' },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, { page: 1, per_page: 2 });
    expect(fetcher).toHaveBeenNthCalledWith(2, { page: 2, per_page: 2 });
    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  it('bounds page-number page size by the remaining record limit', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }, { id: 2 }],
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [{ id: 3 }],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        api: {
          endpoint: '/issues',
          method: 'GET',
          query_params: { per_page: '2' },
        },
        extract: {
          record_path: '$',
          pagination: { type: 'page_number', page_param: 'page', per_page_param: 'per_page' },
        },
      }),
      fetcher,
      warn,
      { recordLimit: 3 }
    )) {
      pages.push(page.records);
    }

    expect(fetcher).toHaveBeenNthCalledWith(1, { page: 1, per_page: 2 });
    expect(fetcher).toHaveBeenNthCalledWith(2, { page: 2, per_page: 1 });
    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  it('stops offset pagination when empty page returned', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }],
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [],
        headers: new Headers(),
        status: 200,
      });

    const pages = [];
    for await (const page of paginate(
      makeProvider(),
      makeResource({
        api: {
          endpoint: '/issues',
          method: 'GET',
          query_params: { limit: '100' },
        },
        extract: {
          record_path: '$',
          pagination: { type: 'offset', offset_param: 'offset', limit_param: 'limit' },
        },
      }),
      fetcher,
      warn
    )) {
      pages.push(page.data);
    }

    // Only first page yielded; empty second page terminates without being yielded
    expect(pages).toHaveLength(1);
  });
});

function makeProvider(overrides: Record<string, unknown> = {}) {
  return makeBaseProvider('https://api.example.com', { name: 'github', ...overrides });
}

function makeResource(overrides: Record<string, unknown> = {}) {
  return makeBaseResource({
    name: 'issues',
    integration: 'github',
    endpoint: '/issues',
    ...overrides,
  });
}
