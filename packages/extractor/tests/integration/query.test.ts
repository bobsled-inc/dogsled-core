import { afterEach, describe, expect, it } from 'vitest';

import { queryResource } from '../../src/runtime/query/index.js';

import type { ResourceSpec } from '../../src/types/index.js';
import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { createFakeServer, type FakeServer } from './helpers/fake-server.js';

function makeGithubQueryResource(): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        state: '${{ input.state }}',
        since: '${{ input.since }}',
      },
    },
    input: {
      state: {
        type: 'string',
      },
      since: {
        type: 'string',
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      state: { type: 'string', path: '$.state' },
      updated_at: { type: 'timestamp', path: '$.updated_at' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        state: {
          operators: ['eq'],
          enum: ['open', 'closed'],
          bind: {
            eq: { input: 'state' },
          },
        },
        updated_at: {
          operators: ['gte'],
          bind: {
            gte: { input: 'since' },
          },
        },
      },
    },
  });
}

function makeScalarOperatorQueryResource(): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        status_ne: '${{ input.status_ne }}',
        rank_lt: '${{ input.rank_lt }}',
        score_gt: '${{ input.score_gt }}',
        archived_not: '${{ input.archived_not }}',
      },
    },
    input: {
      status_ne: {
        type: 'string',
      },
      rank_lt: {
        type: 'integer',
      },
      score_gt: {
        type: 'number',
      },
      archived_not: {
        type: 'boolean',
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      status: { type: 'string', path: '$.status' },
      rank: { type: 'integer', path: '$.rank' },
      score: { type: 'number', path: '$.score' },
      archived: { type: 'boolean', path: '$.archived' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        status: {
          operators: ['ne'],
          enum: ['open', 'closed'],
          bind: {
            ne: { input: 'status_ne' },
          },
        },
        rank: {
          operators: ['lt'],
          bind: {
            lt: { input: 'rank_lt' },
          },
        },
        score: {
          operators: ['gt'],
          bind: {
            gt: { input: 'score_gt' },
          },
        },
        archived: {
          operators: ['not'],
          bind: {
            not: { input: 'archived_not' },
          },
        },
      },
    },
  });
}

function makeInOperatorQueryResource(): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        state_in: '${{ input.states }}',
      },
    },
    input: {
      states: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
        },
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      state: { type: 'string', path: '$.state' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        state: {
          operators: ['in'],
          enum: ['open', 'closed', 'pending'],
          bind: {
            in: { input: 'states' },
          },
        },
      },
    },
  });
}

function makeJiraQueryResource(): ResourceSpec {
  return makeResource({
    name: 'search_issues',
    api: {
      endpoint: '/search',
      method: 'GET',
      query_params: {
        jql: '${{ input.jql }}',
      },
    },
    input: {
      jql: {
        type: 'string',
      },
    },
    output: {
      id: { type: 'string', path: '$.id' },
      key: { type: 'string', path: '$.key' },
    },
    extract: {
      record_path: '$.issues',
    },
    query: {
      search: {
        dialect: 'jira_jql',
        bind: {
          input: 'jql',
        },
      },
    },
  });
}

function makePaginatedQueryResource(): ResourceSpec {
  return makeResource({
    name: 'items',
    api: {
      endpoint: '/items',
      method: 'GET',
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      updated_at: { type: 'timestamp', path: '$.updated_at' },
    },
    extract: {
      record_path: '$',
      pagination: {
        type: 'link_header',
      },
    },
    query: {
      filters: {
        updated_at: {
          operators: ['gte'],
          bind: {
            gte: { input: 'since' },
          },
        },
      },
    },
    input: {
      since: {
        type: 'string',
      },
    },
  });
}

describe('query integration', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('binds GitHub-style filters into the first request URL', async () => {
    let firstUrl: URL | undefined;

    server = await createFakeServer([
      {
        path: '/issues',
        handler: (_req, url) => {
          firstUrl = url;
          return {
            body: [{ id: 1, state: 'open', updated_at: '2026-04-01T00:00:00Z' }],
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url, { name: 'github' }),
      resource: makeGithubQueryResource(),
      filter: {
        state: 'open',
        updated_at: {
          gte: '2026-04-01T00:00:00Z',
        },
      },
    });

    expect(firstUrl?.searchParams.get('state')).toBe('open');
    expect(firstUrl?.searchParams.get('since')).toBe('2026-04-01T00:00:00Z');
    expect(result).toEqual({
      records: [{ id: 1, state: 'open', updated_at: '2026-04-01T00:00:00Z' }],
      limitReached: false,
      requestCount: 1,
    });
  });

  it('binds ne, lt, gt, and not filters into the first request URL', async () => {
    let firstUrl: URL | undefined;

    server = await createFakeServer([
      {
        path: '/issues',
        handler: (_req, url) => {
          firstUrl = url;
          return {
            body: [{ id: 1, status: 'open', rank: 4, score: 0.9, archived: false }],
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makeScalarOperatorQueryResource(),
      filter: {
        status: { $ne: 'closed' },
        rank: { lt: 10 },
        score: { $gt: 0.75 },
        archived: { $not: false },
      },
    });

    expect(firstUrl?.searchParams.get('status_ne')).toBe('closed');
    expect(firstUrl?.searchParams.get('rank_lt')).toBe('10');
    expect(firstUrl?.searchParams.get('score_gt')).toBe('0.75');
    expect(firstUrl?.searchParams.get('archived_not')).toBe('false');
    expect(result).toEqual({
      records: [{ id: 1, status: 'open', rank: 4, score: 0.9, archived: false }],
      limitReached: false,
      requestCount: 1,
    });
  });

  it('binds in filters into the first request URL', async () => {
    let firstUrl: URL | undefined;

    server = await createFakeServer([
      {
        path: '/issues',
        handler: (_req, url) => {
          firstUrl = url;
          return {
            body: [{ id: 1, state: 'open' }],
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makeInOperatorQueryResource(),
      filter: {
        state: { $in: ['open', 'closed'] },
      },
    });

    expect(firstUrl?.searchParams.get('state_in')).toBe(JSON.stringify(['open', 'closed']));
    expect(result).toEqual({
      records: [{ id: 1, state: 'open' }],
      limitReached: false,
      requestCount: 1,
    });
  });

  it('binds Jira-style search strings into the first request URL', async () => {
    let firstUrl: URL | undefined;

    server = await createFakeServer([
      {
        path: '/search',
        handler: (_req, url) => {
          firstUrl = url;
          return {
            body: {
              issues: [{ id: '10001', key: 'FOO-1' }],
            },
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url, { name: 'jira' }),
      resource: makeJiraQueryResource(),
      search: 'project = FOO ORDER BY updated DESC',
    });

    expect(firstUrl?.searchParams.get('jql')).toBe('project = FOO ORDER BY updated DESC');
    expect(result).toEqual({
      records: [{ id: '10001', key: 'FOO-1' }],
      limitReached: false,
      requestCount: 1,
    });
  });

  it('returns request count, ETag, and rate-limit metadata', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [{ id: 1, updated_at: '2026-04-01T00:00:00Z' }],
          headers: {
            ETag: '"slice-1"',
            'X-RateLimit-Limit': '100',
            'X-RateLimit-Remaining': '98',
          },
        }),
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makePaginatedQueryResource(),
      limit: 10,
    });

    expect(result.records).toHaveLength(1);
    expect(result.requestCount).toBe(1);
    expect(result.etag).toBe('"slice-1"');
    expect(result.rateLimit).toEqual({ limit: 100, remaining: 98 });
  });

  it('sends If-None-Match and reports conditional 304 hits', async () => {
    let ifNoneMatch: string | undefined;
    server = await createFakeServer([
      {
        path: '/issues',
        handler: (req) => {
          const header = req.headers['if-none-match'];
          ifNoneMatch = Array.isArray(header) ? header[0] : header;
          return {
            status: 304,
            body: {},
            headers: {
              'X-RateLimit-Limit': '100',
              'X-RateLimit-Remaining': '99',
            },
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makeGithubQueryResource(),
      etag: '"slice-1"',
    });

    expect(ifNoneMatch).toBe('"slice-1"');
    expect(result).toEqual({
      records: [],
      limitReached: false,
      requestCount: 1,
      etag: '"slice-1"',
      notModified: true,
      rateLimit: { limit: 100, remaining: 99 },
    });
  });

  it('clears stale ETags when a conditional 200 response omits a fresh ETag', async () => {
    let ifNoneMatch: string | undefined;
    server = await createFakeServer([
      {
        path: '/issues',
        handler: (req) => {
          const header = req.headers['if-none-match'];
          ifNoneMatch = Array.isArray(header) ? header[0] : header;
          return {
            body: [{ id: 1, state: 'open', updated_at: '2026-04-01T00:00:00Z' }],
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makeGithubQueryResource(),
      etag: '"slice-1"',
    });

    expect(ifNoneMatch).toBe('"slice-1"');
    expect(result.records).toEqual([{ id: 1, state: 'open', updated_at: '2026-04-01T00:00:00Z' }]);
    expect(result.etag).toBeUndefined();
    expect(result.notModified).toBeUndefined();
  });

  it('does not use a single ETag to validate a paginated slice', async () => {
    let ifNoneMatch: string | undefined;
    server = await createFakeServer([
      {
        path: '/items',
        handler: (req) => {
          const header = req.headers['if-none-match'];
          ifNoneMatch = Array.isArray(header) ? header[0] : header;
          return {
            body: [{ id: 1, updated_at: '2026-04-01T00:00:00Z' }],
            headers: {
              ETag: '"page-1"',
            },
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makePaginatedQueryResource(),
      limit: 10,
      etag: '"slice-1"',
    });

    expect(ifNoneMatch).toBeUndefined();
    expect(result).toMatchObject({
      records: [{ id: 1, updated_at: '2026-04-01T00:00:00Z' }],
      limitReached: false,
      requestCount: 1,
      etag: '"page-1"',
    });
    expect(result.notModified).toBeUndefined();
  });

  it('respects limit across paginated responses', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: (_req, url) => {
          const page = Number(url.searchParams.get('page') ?? '1');
          const records = Array.from({ length: 10 }, (_, index) => ({
            id: (page - 1) * 10 + index + 1,
            updated_at: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
          }));

          const headers =
            page < 3 ? { Link: `<${server!.url}/items?page=${page + 1}>; rel="next"` } : undefined;

          return {
            body: records,
            headers,
          };
        },
      },
    ]);

    const limited = await queryResource({
      integration: makeProvider(server.url),
      resource: makePaginatedQueryResource(),
      limit: 15,
    });

    const exhaustive = await queryResource({
      integration: makeProvider(server.url),
      resource: makePaginatedQueryResource(),
      limit: 100,
    });

    expect(limited.records).toHaveLength(15);
    expect(limited.limitReached).toBe(true);
    expect(exhaustive.records).toHaveLength(30);
    expect(exhaustive.limitReached).toBe(false);
  });

  it('pushes query limits into page-number page-size params', async () => {
    let requestedPerPage: string | null = null;
    server = await createFakeServer([
      {
        path: '/items',
        handler: (_req, url) => {
          requestedPerPage = url.searchParams.get('per_page');
          const count = Number(requestedPerPage ?? '100');
          return {
            body: {
              items: Array.from({ length: count }, (_, index) => ({
                id: index + 1,
                updated_at: '2026-04-01T00:00:00Z',
              })),
              total_pages: 10,
            },
          };
        },
      },
    ]);

    const result = await queryResource({
      integration: makeProvider(server.url),
      resource: makeResource({
        name: 'items',
        api: {
          endpoint: '/items',
          method: 'GET',
          query_params: {
            page: '${{ input.page }}',
            per_page: '${{ input.per_page }}',
          },
        },
        input: {
          page: { type: 'integer', default: 1 },
          per_page: { type: 'integer', default: 100 },
        },
        output: {
          id: { type: 'integer', path: '$.id' },
          updated_at: { type: 'timestamp', path: '$.updated_at' },
        },
        extract: {
          record_path: '$.items',
          pagination: {
            type: 'page_number',
            page_param: 'page',
            per_page_param: 'per_page',
            total_pages_path: '$.total_pages',
          },
        },
        query: {
          filters: {},
        },
      }),
      limit: 1,
    });

    expect(requestedPerPage).toBe('1');
    expect(result.records).toHaveLength(1);
    expect(result.requestCount).toBe(1);
    expect(result.limitReached).toBe(true);
  });

  it('fails closed after 50 pages when no limit is supplied', async () => {
    let requestCount = 0;
    server = await createFakeServer([
      {
        path: '/items',
        handler: (_req, url) => {
          requestCount += 1;
          const page = Number(url.searchParams.get('page') ?? '1');
          return {
            body: [{ id: page, updated_at: '2026-04-01T00:00:00Z' }],
            headers: {
              Link: `<${server!.url}/items?page=${page + 1}>; rel="next"`,
            },
          };
        },
      },
    ]);

    await expect(
      queryResource({
        integration: makeProvider(server.url),
        resource: makePaginatedQueryResource(),
      })
    ).rejects.toThrow('unbounded page safety cap of 50 pages');
    expect(requestCount).toBe(50);
  });
});
