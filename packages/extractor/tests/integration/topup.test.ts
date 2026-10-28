import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractResource } from '../../src/commands/extract.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { FileStateStore, loadState, saveState } from '../../src/runtime/state.js';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';
import { makeProvider as makeBaseProvider, makeResource } from '../helpers/fixtures.js';
import { createFakeServer, type FakeServer } from './helpers/fake-server.js';

function makeProvider(baseUrl: string): IntegrationSpec {
  return makeBaseProvider(baseUrl);
}

function makeTimestampResource(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return makeResource({
    name: 'test_events',
    endpoint: '/events',
    schema: {
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'updated_at', type: 'timestamp' },
        { name: 'title', type: 'string' },
      ],
    },
    incremental: {
      cursor_field: 'updated_at',
      cursor_param: 'since',
      cursor_type: 'timestamp',
    },
    extract: {
      record_path: '$',
      pagination: {
        type: 'link_header',
      },
    },
    ...overrides,
  });
}

describe('topup integration', () => {
  let server: FakeServer;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-topup-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends the since cursor on the first request only', async () => {
    const seenSinceValues: Array<string | null> = [];
    server = await createFakeServer([
      {
        path: '/events',
        handler: (_req, url) => {
          seenSinceValues.push(url.searchParams.get('since'));
          const page = Number(url.searchParams.get('page') ?? '1');
          const headers = page === 1 ? { Link: `<${server.url}/events?page=2>; rel="next"` } : {};
          return {
            body: [{ id: page, updated_at: `2024-01-0${page}T00:00:00Z`, title: `page_${page}` }],
            headers,
          };
        },
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeTimestampResource();

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {
        sinceOverride: '2024-01-01T00:00:00Z',
        cursorKind: 'timestamp',
        advanceState: false,
      },
    });

    expect(seenSinceValues).toEqual(['2024-01-01T00:00:00Z', null]);
  });

  it('does not let advance-state regress the durable bookmark', async () => {
    await saveState(tmpDir, {
      streams: {
        'test_api/test_events': {
          cursor_field: 'updated_at',
          cursor_value: '2024-06-15T12:00:00Z',
          last_run_at: '2024-06-16T00:00:00Z',
          record_count: 10,
        },
      },
    });

    server = await createFakeServer([
      {
        path: '/events',
        handler: () => ({
          body: [
            { id: 1, updated_at: '2024-06-01T00:00:00Z', title: 'historical' },
            { id: 2, updated_at: '2024-06-10T00:00:00Z', title: 'historical_2' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeTimestampResource();

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {
        advanceState: true,
        cursorKind: 'timestamp',
      },
    });

    const bookmark = (await loadState(tmpDir)).streams['test_api/test_events'];
    expect(bookmark?.cursor_value).toBe('2024-06-15T12:00:00Z');
    expect(bookmark?.record_count).toBe(10);
  });

  it('keeps the durable bookmark on empty windows when advance-state is enabled', async () => {
    await saveState(tmpDir, {
      streams: {
        'test_api/test_events': {
          cursor_field: 'updated_at',
          cursor_value: '2024-06-15T12:00:00Z',
          last_run_at: '2024-06-16T00:00:00Z',
          record_count: 10,
        },
      },
    });

    server = await createFakeServer([
      {
        path: '/events',
        handler: () => ({ body: [] }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeTimestampResource();

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {
        advanceState: true,
        cursorKind: 'timestamp',
      },
    });

    const bookmark = (await loadState(tmpDir)).streams['test_api/test_events'];
    expect(bookmark?.cursor_value).toBe('2024-06-15T12:00:00Z');
    expect(bookmark?.record_count).toBe(10);
  });

  it('emits run-local state for non-incremental resources without persisting it', async () => {
    server = await createFakeServer([
      {
        path: '/events',
        handler: () => ({ body: [{ id: 1, title: 'full' }] }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      name: 'full_table',
      endpoint: '/events',
      incremental: undefined,
    });

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: { advanceState: true },
    });

    expect((await loadState(tmpDir)).streams['test_api/full_table']).toBeUndefined();
  });
});
