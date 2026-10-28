import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupResource } from '../../src/runtime/lookup.js';

import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { createFakeServer, type FakeServer } from './helpers/fake-server.js';

async function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

describe('lookup integration', () => {
  let server: FakeServer;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
  });

  it('fetches a single item by ID via lookup endpoint', async () => {
    server = await createFakeServer([
      {
        path: '/items/{id}',
        handler: () => ({
          body: { id: 42, name: 'found_item' },
        }),
      },
    ]);

    const records = await lookupResource({
      integration: makeProvider(server.url),
      resource: makeResource({
        lookup: {
          description: 'Fetch a single item',
          api: {
            endpoint: '/items/${{ input.id }}',
            method: 'GET',
          },
          input: {
            id: {
              type: 'string',
              required: true,
            },
          },
        },
      }),
      input: { id: '42' },
    });

    expect(records).toEqual([{ id: 42, name: 'found_item' }]);
  });

  it('supports templated lookup headers and body overrides', async () => {
    let receivedHeader: string | null = null;
    let receivedBody = '';

    server = await createFakeServer([
      {
        path: '/items/search',
        method: 'POST',
        handler: async (req) => {
          receivedHeader = req.headers['x-lookup'] as string | null;
          receivedBody = await readRequestBody(req);
          return {
            body: {
              data: {
                items: [{ id: 99, name: 'posted_item' }],
              },
            },
          };
        },
      },
    ]);

    const records = await lookupResource({
      integration: makeProvider(server.url, {
        headers: { 'X-Shared': 'connection' },
      }),
      resource: makeResource({
        lookup: {
          description: 'Search items',
          api: {
            endpoint: '/items/search',
            method: 'POST',
            headers: { 'X-Lookup': '${{ input.repo }}' },
            request_body: { query: '${{ input.repo }}', id: '${{ input.id }}' },
          },
          input: {
            repo: { type: 'string', required: true },
            id: { type: 'string', required: true },
          },
          extract: { record_path: '$.data.items' },
        },
      }),
      input: { id: '99', repo: 'cli-repo' },
    });

    expect(receivedHeader).toBe('cli-repo');
    expect(JSON.parse(receivedBody)).toEqual({ query: 'cli-repo', id: '99' });
    expect(records).toEqual([{ id: 99, name: 'posted_item' }]);
  });
});
