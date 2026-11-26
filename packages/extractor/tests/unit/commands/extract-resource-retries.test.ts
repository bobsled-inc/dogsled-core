import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractResource } from '../../../src/commands/extract-resource.js';
import { ExtractorClient } from '../../../src/runtime/client.js';
import { ControlLogger } from '../../../src/runtime/control.js';
import { Emitter } from '../../../src/runtime/emitter.js';
import type { StateStore } from '../../../src/runtime/state.js';
import type { ExtractorState } from '../../../src/types/index.js';
import { makeProvider, makeResource } from '../../helpers/fixtures.js';

type Message = {
  type: string;
  level?: string;
  message?: string;
  event?: string;
  attributes?: Record<string, unknown>;
  record?: Record<string, unknown>;
};

function makeHarness(options: { quiet?: boolean } = {}) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const state: ExtractorState = { streams: {} };
  const stateStore: StateStore = { load: async () => state, save: async () => undefined };
  return {
    state,
    stateStore,
    emitter: new Emitter('stdout', 'unused', { stdoutStream: stream }),
    logger: new ControlLogger({ stream, quiet: options.quiet ?? false }),
    batchDir: 'unused',
    messages: (): Message[] =>
      lines
        .flatMap((line) => line.trim().split('\n'))
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Message),
  };
}

const resource = makeResource({
  name: 'items',
  api: { endpoint: '/items', method: 'GET' },
  output: { id: { type: 'integer', path: '$.id' } },
  extract: { record_path: '$' },
});

/** A 200 whose body fails as undici reports a connection dropped halfway. */
function bodyThatDrops(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        controller.error(
          new TypeError('terminated', {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          })
        );
      },
    })
  );
}

describe('extraction retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('warns in the run log for each retry and still extracts the page', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Retry-After': '0' },
        })
      )
      .mockResolvedValueOnce(bodyThatDrops())
      .mockResolvedValueOnce(new Response('{"id":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const integration = makeProvider('https://api.example.com/', {
      auth: { type: 'bearer', token: 'secret-token-value' },
    });
    const harness = makeHarness();

    const result = await extractResource({
      ...harness,
      integration,
      resource,
      client: new ExtractorClient({ integration }),
      opts: {},
    });

    const messages = harness.messages();
    const warnings = messages.filter((message) => message.event === 'http.request_retry');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      type: 'LOG',
      level: 'warn',
      message:
        'Request for items failed on attempt 1 of 5 (HTTP 503 Service Unavailable). Retrying in 0.0s.',
      attributes: {
        resource: 'items',
        attempt: 1,
        max_attempts: 5,
        reason: 'http_status',
        detail: 'HTTP 503 Service Unavailable',
        status: 503,
        wait_ms: 0,
      },
    });
    expect(warnings[1]).toMatchObject({
      level: 'warn',
      message:
        'Request for items failed on attempt 2 of 5 (response body read failed: other side closed (UND_ERR_SOCKET)). Retrying in 0.0s.',
      attributes: { attempt: 2, reason: 'response_body', wait_ms: 0 },
    });
    expect(result.recordCount).toBe(1);
    expect(messages.filter((message) => message.type === 'RECORD')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warnings)).not.toContain('secret-token-value');
    expect(JSON.stringify(warnings)).not.toContain('api.example.com');
  });

  it('keeps retry warnings out of a quiet run', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('{"id":1}'))
    );
    const integration = makeProvider();
    const harness = makeHarness({ quiet: true });

    const result = await extractResource({
      ...harness,
      integration,
      resource,
      client: new ExtractorClient({ integration }),
      opts: {},
    });

    expect(result.recordCount).toBe(1);
    expect(harness.messages().filter((message) => message.type === 'LOG')).toEqual([]);
  });
});
