import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractResource } from '../../src/commands/extract.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { FileStateStore, loadState } from '../../src/runtime/state.js';

import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { createFakeServer, type FakeServer } from './helpers/fake-server.js';

describe('extract integration', () => {
  const originalAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  let server: FakeServer;
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-test-'));
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (server) await server.close();
    if (originalAllowPrivateHosts === undefined) {
      delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalAllowPrivateHosts;
    }
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks monotonic max cursor across out-of-order records', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 5, name: 'five' },
            { id: 2, name: 'two' },
            { id: 8, name: 'eight' },
            { id: 1, name: 'one' },
            { id: 10, name: 'ten' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      incremental: {
        cursor_field: 'id',
        cursor_param: 'since_id',
        cursor_type: 'integer',
      },
    });

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: { advanceState: true, cursorKind: 'integer' },
    });

    expect(result.recordCount).toBe(5);
    expect((await loadState(tmpDir)).streams['test_api/test_items']?.cursor_value).toBe('10');
  });

  it('routes POST pagination cursors through the shared request body path', async () => {
    const requestBodies: unknown[] = [];
    server = await createFakeServer([
      {
        path: '/search',
        method: 'POST',
        handler: async (req, url) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            start_cursor?: string;
          };
          requestBodies.push(body);
          expect(url.searchParams.has('start_cursor')).toBe(false);
          return body.start_cursor === undefined
            ? { body: { results: [{ id: 1 }], next_cursor: 'cursor-2' } }
            : { body: { results: [{ id: 2 }], next_cursor: null } };
        },
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      name: 'search_results',
      api: { endpoint: '/search', method: 'POST', request_body: { page_size: 100 } },
      output: { id: { type: 'integer', path: '$.id' } },
      extract: {
        record_path: '$.results',
        pagination: {
          type: 'cursor',
          cursor_path: '$.next_cursor',
          cursor_param: 'start_cursor',
        },
      },
    });

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {},
    });

    expect(result).toMatchObject({ recordCount: 2, apiCalls: 2 });
    expect(requestBodies).toEqual([
      { page_size: 100 },
      { page_size: 100, start_cursor: 'cursor-2' },
    ]);
  });

  it('keeps stdout protocol-only and stderr JSON-only by default', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({ body: [{ id: 1, name: 'alpha' }] }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const logger = new ControlLogger({ logFormat: 'json' });

    await logger.info('starting');
    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger,
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {},
    });
    await logger.metric(resource.name, {
      records_emitted: 1,
      api_calls: 1,
      duration_ms: 5,
    });

    const stdoutMessages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const stderrMessages = stderrSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(stdoutMessages.map((message) => message.type)).toEqual(['SCHEMA', 'RECORD', 'STATE']);
    expect(stderrMessages.map((message) => message.type)).toEqual(['LOG', 'LOG', 'METRIC']);
    expect(stderrMessages[1]).toMatchObject({
      event: 'progress.resource_page',
      attributes: {
        progress_event: 'resource_page',
        resource: 'test_items',
        records_seen: 1,
        records_emitted: 1,
      },
    });
  });

  it('does not persist incremental state unless advanceState is enabled', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 1, name: 'alpha' },
            { id: 2, name: 'beta' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      incremental: {
        cursor_field: 'id',
        cursor_param: 'since_id',
        cursor_type: 'integer',
      },
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
      opts: {},
    });

    expect((await loadState(tmpDir)).streams['test_api/test_items']).toBeUndefined();
  });

  it('respects limits and preserves message ordering', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            name: `item_${index + 1}`,
          })),
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: { limit: 3 },
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(result.recordCount).toBe(3);
    expect(messages[0]?.type).toBe('SCHEMA');
    expect(messages.filter((message) => message.type === 'RECORD')).toHaveLength(3);
    expect(messages.at(-1)?.type).toBe('STATE');
  });

  it('applies resource record_filters before emit and onRecord callbacks', async () => {
    server = await createFakeServer([
      {
        path: '/repos',
        handler: () => ({
          body: [
            { id: 1, name: 'bobsled' },
            { id: 2, name: 'bobsled-agents' },
            { id: 3, name: 'demo-repo' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      name: 'repos',
      api: { endpoint: '/repos', method: 'GET' },
      input: {
        repo_names: { type: 'string' },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        name: { type: 'string', path: '$.name' },
      },
      extract: {
        record_path: '$',
        record_filters: [{ field: 'name', input: 'repo_names', operator: 'in' }],
        table: { primary_key: ['id'] },
      },
    });
    const cachedRecords: Record<string, unknown>[] = [];

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir: path.join(tmpDir, 'batch'),
      opts: {},
      inputOverrides: { repo_names: 'bobsled,demo-repo' },
      onRecord: (record) => cachedRecords.push(record),
    });

    const recordMessages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.type === 'RECORD');

    expect(result.recordCount).toBe(2);
    expect(recordMessages.map((message) => message.record.name)).toEqual(['bobsled', 'demo-repo']);
    expect(cachedRecords.map((record) => record['name'])).toEqual(['bobsled', 'demo-repo']);
  });

  it('partitions incremental bookmarks per for_each iteration so each repo resumes from its own cursor', async () => {
    // Regression for the for_each + incremental bug: iteration 1 used to
    // write its cursor under the bare resource key, and iteration 2 then
    // applied it as a since= floor on the NEW repo's first page and silently
    // returned zero records. With partitions, each iteration owns its own
    // bookmark slot keyed by (owner, repo).
    const sinceParamsReceived: Array<string | null> = [];
    server = await createFakeServer([
      {
        path: '/repos/bobsled-inc/bobsled/commits',
        handler: (_req, url) => {
          sinceParamsReceived.push(url.searchParams.get('since'));
          return {
            body: [
              { sha: 'a1', author_date: '2026-03-15T00:00:00Z' },
              { sha: 'a2', author_date: '2026-03-16T00:00:00Z' },
            ],
          };
        },
      },
      {
        path: '/repos/bobsled-inc/demo-repo/commits',
        handler: (_req, url) => {
          sinceParamsReceived.push(url.searchParams.get('since'));
          return {
            body: [
              { sha: 'b1', author_date: '2026-03-10T00:00:00Z' },
              { sha: 'b2', author_date: '2026-03-11T00:00:00Z' },
            ],
          };
        },
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const sharedResource = makeResource({
      name: 'commits',
      api: { endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/commits', method: 'GET' },
      input: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
      },
      output: {
        sha: { type: 'string', path: '$.sha' },
        author_date: { type: 'timestamp', path: '$.author_date' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'author_date',
          cursor_param: 'since',
          cursor_type: 'timestamp',
        },
        table: { primary_key: ['sha'] },
      },
    });

    for (const iteration of [
      {
        inputs: { owner: 'bobsled-inc', repo: 'bobsled' },
        partition: 'owner=bobsled-inc::repo=bobsled',
      },
      {
        inputs: { owner: 'bobsled-inc', repo: 'demo-repo' },
        partition: 'owner=bobsled-inc::repo=demo-repo',
      },
    ]) {
      await extractResource({
        integration: integrationSpec,
        integrationName: 'test_api',
        resource: sharedResource,
        client: new ExtractorClient({ integration: integrationSpec }),
        emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
        logger: new ControlLogger({ logFormat: 'json' }),
        state,
        stateStore,
        batchDir: path.join(tmpDir, 'batch'),
        opts: { advanceState: true, cursorKind: 'timestamp' },
        inputOverrides: iteration.inputs,
        inputContext: iteration.inputs,
        partition: iteration.partition,
        skipSchema: true,
      });
    }

    // Both iterations must hit their respective endpoints WITHOUT carrying
    // a `since` value (no prior bookmark for either partition slot).
    expect(sinceParamsReceived).toEqual([null, null]);

    // After the run, state.json holds two distinct partition slots —
    // each scoped to a single (owner, repo).
    const persisted = await loadState(tmpDir);
    expect(Object.keys(persisted.streams).sort()).toEqual([
      'test_api/commits#owner=bobsled-inc::repo=demo-repo',
      'test_api/commits#owner=bobsled-inc::repo=bobsled',
    ]);
    expect(
      persisted.streams['test_api/commits#owner=bobsled-inc::repo=bobsled']?.cursor_value
    ).toBe('2026-03-16T00:00:00Z');
    expect(
      persisted.streams['test_api/commits#owner=bobsled-inc::repo=demo-repo']?.cursor_value
    ).toBe('2026-03-11T00:00:00Z');

    // STATE messages emitted on stdout carry the matching partition field
    // so external state backends key the bookmark per iteration without
    // overloading `stream`.
    const stateMessages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.type === 'STATE');
    expect(stateMessages.map((m) => ({ stream: m.stream, partition: m.partition }))).toEqual([
      { stream: 'commits', partition: 'owner=bobsled-inc::repo=bobsled' },
      { stream: 'commits', partition: 'owner=bobsled-inc::repo=demo-repo' },
    ]);

    // Second pass: each iteration must now read its OWN persisted bookmark
    // (no cross-iteration poisoning). Verify by re-running with the prior
    // state still in-place and observing the `since` param carrying the
    // partition-specific cursor value.
    sinceParamsReceived.length = 0;
    for (const iteration of [
      {
        inputs: { owner: 'bobsled-inc', repo: 'bobsled' },
        partition: 'owner=bobsled-inc::repo=bobsled',
      },
      {
        inputs: { owner: 'bobsled-inc', repo: 'demo-repo' },
        partition: 'owner=bobsled-inc::repo=demo-repo',
      },
    ]) {
      await extractResource({
        integration: integrationSpec,
        integrationName: 'test_api',
        resource: sharedResource,
        client: new ExtractorClient({ integration: integrationSpec }),
        emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
        logger: new ControlLogger({ logFormat: 'json' }),
        state: persisted,
        stateStore,
        batchDir: path.join(tmpDir, 'batch'),
        opts: { advanceState: true, cursorKind: 'timestamp' },
        inputOverrides: iteration.inputs,
        inputContext: iteration.inputs,
        partition: iteration.partition,
        skipSchema: true,
      });
    }
    expect(sinceParamsReceived).toEqual(['2026-03-16T00:00:00Z', '2026-03-11T00:00:00Z']);
  });

  it('limited runs do not persist state but still emit STATE messages', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            name: `item_${index + 1}`,
          })),
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource({
      incremental: {
        cursor_field: 'id',
        cursor_param: 'since_id',
        cursor_type: 'integer',
      },
    });

    // Snapshot the state file before the run
    const stateBefore = await loadState(tmpDir);

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
      opts: { limit: 3 },
    });

    // STATE messages should still be emitted on stdout
    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.some((message) => message.type === 'STATE')).toBe(true);

    // The durable state file should remain unchanged (no persisted bookmark)
    const stateAfter = await loadState(tmpDir);
    expect(stateAfter).toEqual(stateBefore);
  });
});
