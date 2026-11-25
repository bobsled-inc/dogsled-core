import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectHostEmbedding,
  HostEmbeddingError,
  type HostEmbeddingOptions,
} from '../src/index.js';

const URL_WITH_PATH = 'https://host.example/private/embed?run=7';
const TOKEN = 'synthetic-host-token';
const TEXT = 'A synthetic sentence about sled dogs.';
const MODEL = { provider: 'acme', id: 'acme-embed-1', dimensions: 2 };

interface SentRequest {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: { inputs: Array<{ id: string; text: string }>; purpose: string };
}

type Reply = (request: SentRequest, call: number) => Response | Promise<Response>;

/** A host that answers the first call and echoes a vector per input, unless `reply` is set. */
function fakeHost(reply: Reply = (request) => Response.json(answer(request))) {
  const requests: SentRequest[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init = {}) => {
    const request: SentRequest = {
      url: String(input),
      init,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as SentRequest['body'],
    };
    requests.push(request);
    return reply(request, requests.length);
  });
  return { fetch: fetchMock, requests };
}

function answer(request: SentRequest, overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    results: request.body.inputs.map(({ id, text }) => ({ id, embedding: [text.length, 1] })),
    usage: { tokens: request.body.inputs.length * 3 },
    ...overrides,
  };
}

/** Answer the first call normally and every later one with `reply`. */
function afterFirstCall(reply: Reply): Reply {
  return (request, call) => (call === 1 ? Response.json(answer(request)) : reply(request, call));
}

function connect(fetchImplementation: typeof fetch, overrides: Partial<HostEmbeddingOptions> = {}) {
  return connectHostEmbedding({
    url: URL_WITH_PATH,
    token: TOKEN,
    fetch: fetchImplementation,
    delay: async () => {},
    startTimeout: () => () => {},
    random: () => 0,
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<HostEmbeddingError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(HostEmbeddingError);
  return error as HostEmbeddingError;
}

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/embed`;
}

/** Node's own fetch, sent to a local test server instead of the https endpoint. */
function nodeFetchTo(localUrl: string): typeof fetch {
  return (_input, init) => fetch(localUrl, init);
}

describe('first call', () => {
  it('asks for the model and limits without sending text', async () => {
    const host = fakeHost((request) =>
      Response.json(answer(request, { limits: { maxInputs: 3, maxInputCharacters: 50 } }))
    );
    const connection = await connect(host.fetch);

    expect(connection.model).toEqual(MODEL);
    expect(connection.limits).toEqual({ maxInputs: 3, maxInputCharacters: 50 });
    expect(connection.textsInFlight).toBe(12);
    expect(host.requests).toHaveLength(1);
    const [request] = host.requests;
    expect(request!.url).toBe(URL_WITH_PATH);
    expect(request!.body).toEqual({ inputs: [], purpose: 'document' });
    expect(request!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(request!.headers)).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('uses the default limits when the host sends none', async () => {
    const connection = await connect(fakeHost().fetch);
    expect(connection.limits).toEqual({ maxInputs: 32, maxInputCharacters: 32_000 });
  });

  it('ignores keys it does not know and limits in later responses', async () => {
    const host = fakeHost((request, call) =>
      Response.json(
        answer(request, {
          extra: { nested: true },
          limits: call === 1 ? { maxInputs: 2, maxOther: 9 } : { maxInputs: 0 },
        })
      )
    );
    const connection = await connect(host.fetch);
    expect(connection.limits).toEqual({ maxInputs: 2, maxInputCharacters: 32_000 });
    await expect(connection.embed(['a', 'b', 'c'])).resolves.toMatchObject({ requests: 2 });
  });

  it.each([
    { provider: ' ', id: '~'.repeat(200), dimensions: 1 },
    { provider: 'p'.repeat(200), id: 'Mixed/Case:v1', dimensions: 16_384 },
  ])('records an accepted model unchanged', async (model) => {
    const host = fakeHost(() => Response.json({ model, results: [] }));
    expect((await connect(host.fetch)).model).toEqual(model);
  });

  it.each([
    ['a missing model', undefined],
    ['a model that is not an object', 'acme'],
    ['an empty provider', { ...MODEL, provider: '' }],
    ['a provider over 200 characters', { ...MODEL, provider: 'p'.repeat(201) }],
    ['a provider with a control character', { ...MODEL, provider: 'a\nb' }],
    ['a provider that is not ASCII', { ...MODEL, provider: 'acmé' }],
    ['an id that is not a string', { ...MODEL, id: 7 }],
    ['an empty id', { ...MODEL, id: '' }],
    ['no dimensions', { provider: 'acme', id: 'x' }],
    ['zero dimensions', { ...MODEL, dimensions: 0 }],
    ['fractional dimensions', { ...MODEL, dimensions: 1.5 }],
    ['dimensions as a string', { ...MODEL, dimensions: '2' }],
    ['too many dimensions', { ...MODEL, dimensions: 16_385 }],
  ])('refuses %s', async (_label, model) => {
    const host = fakeHost(() => Response.json({ model, results: [] }));
    expect(await failure(connect(host.fetch))).toMatchObject({
      code: 'invalid_response',
      exitCode: 1,
    });
    expect(host.requests).toHaveLength(1);
  });

  it.each([
    { maxInputs: 1, maxInputCharacters: 1 },
    { maxInputs: 100, maxInputCharacters: 200_000 },
  ])('accepts the limits $maxInputs and $maxInputCharacters', async (limits) => {
    const host = fakeHost((request) => Response.json(answer(request, { limits })));
    expect((await connect(host.fetch)).limits).toEqual(limits);
  });

  it.each([
    [],
    'many',
    null,
    { maxInputs: 0 },
    { maxInputs: 101 },
    { maxInputs: 2.5 },
    { maxInputs: '32' },
    { maxInputs: null },
    { maxInputCharacters: 0 },
    { maxInputCharacters: 200_001 },
  ])('refuses the limits %j', async (limits) => {
    const host = fakeHost((request) => Response.json(answer(request, { limits })));
    expect((await failure(connect(host.fetch))).code).toBe('invalid_response');
  });

  it('refuses results it did not ask for', async () => {
    const host = fakeHost(() =>
      Response.json({ model: MODEL, results: [{ id: '0', embedding: [1, 2] }] })
    );
    expect((await failure(connect(host.fetch))).code).toBe('invalid_response');
  });
});

describe('embed', () => {
  it('returns vectors in input order, whatever order the host answers in', async () => {
    const host = fakeHost((request) => {
      const body = answer(request);
      return Response.json({ ...body, results: [...body.results].reverse() });
    });
    const connection = await connect(host.fetch);
    await expect(connection.embed(['a', 'bb', 'ccc'])).resolves.toEqual({
      vectors: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      rejections: new Map(),
      tokensUsed: 9,
      requests: 1,
    });
    expect(host.requests[1]!.body).toEqual({
      inputs: [
        { id: '0', text: 'a' },
        { id: '1', text: 'bb' },
        { id: '2', text: 'ccc' },
      ],
      purpose: 'document',
    });
  });

  it('sends nothing for no texts', async () => {
    const host = fakeHost();
    const connection = await connect(host.fetch);
    await expect(connection.embed([])).resolves.toMatchObject({ vectors: [], requests: 0 });
    expect(host.requests).toHaveLength(1);
  });

  it('keeps four requests of at most maxInputs in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const host = fakeHost(async (request, call) => {
      if (call > 1) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
      }
      return Response.json(answer(request, { limits: { maxInputs: 2 } }));
    });
    const connection = await connect(host.fetch);
    const texts = Array.from({ length: 13 }, (_, index) => 'x'.repeat(index + 1));
    const result = await connection.embed(texts);

    expect(most).toBe(4);
    expect(result.requests).toBe(7);
    expect(result.vectors).toEqual(texts.map((text) => [text.length, 1]));
    const sizes = host.requests.slice(1).map((request) => request.body.inputs.length);
    expect(sizes).toEqual([2, 2, 2, 2, 2, 2, 1]);
    const keys = host.requests.map((request) => request.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cancels the other requests when one fails, and sends no more', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const aborted: number[] = [];
    const host = fakeHost((request, call) => {
      if (call === 1) return Response.json(answer(request, { limits: { maxInputs: 1 } }));
      if (call === 2) return new Response('no', { status: 400 });
      return new Promise<Response>((_resolve, reject) => {
        request.init.signal!.addEventListener('abort', () => {
          aborted.push(call);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const connection = await connect(host.fetch);
    const error = await failure(connection.embed(Array.from({ length: 20 }, () => TEXT)));
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);

    expect(error).toMatchObject({ code: 'http_status' });
    expect(aborted).toEqual([3, 4, 5]);
    expect(host.requests).toHaveLength(5);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('cancels a request that is waiting to retry', async () => {
    let releaseFailure = (): void => {};
    const waits: AbortSignal[] = [];
    const host = fakeHost((request, call) => {
      if (call === 1) return Response.json(answer(request, { limits: { maxInputs: 1 } }));
      if (call === 2) return new Response(null, { status: 503 });
      return new Promise<Response>((resolve) => {
        releaseFailure = () => resolve(new Response(null, { status: 404 }));
      });
    });
    const connection = await connect(host.fetch, {
      delay: (_milliseconds, signal) =>
        new Promise((resolve) => {
          waits.push(signal);
          signal.addEventListener('abort', () => resolve());
          releaseFailure();
        }),
    });
    expect(await failure(connection.embed(['a', 'b']))).toMatchObject({ code: 'http_status' });
    expect(waits).toHaveLength(1);
    expect(host.requests).toHaveLength(3);
  });

  it('turns a refused input into a null vector and counts it by code', async () => {
    const host = fakeHost(
      afterFirstCall((request) =>
        Response.json(
          answer(request, {
            results: [
              { id: '0', error: 'too_long' },
              { id: '1', embedding: [1, 2] },
              { id: '2', error: 'too_long' },
              { id: '3', error: 'Not A Code' },
              { id: '4', error: { detail: TEXT } },
              { id: '5', error: 'x'.repeat(65) },
            ],
          })
        )
      )
    );
    const connection = await connect(host.fetch);
    const result = await connection.embed(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result.vectors).toEqual([null, [1, 2], null, null, null, null]);
    expect([...result.rejections]).toEqual([
      ['too_long', 2],
      ['unknown', 3],
    ]);
  });

  it.each([
    ['provider', { ...MODEL, provider: 'other' }],
    ['id', { ...MODEL, id: 'acme-embed-2' }],
    ['dimensions', { ...MODEL, dimensions: 3 }],
  ])('fails when the model changes its %s', async (_label, model) => {
    const host = fakeHost(
      afterFirstCall((request) =>
        Response.json(
          answer(request, {
            model,
            results: [{ id: '0', embedding: Array.from({ length: model.dimensions }, () => 0) }],
          })
        )
      )
    );
    const connection = await connect(host.fetch);
    expect((await failure(connection.embed([TEXT]))).code).toBe('model_changed');
    expect(host.requests).toHaveLength(2);
  });

  const good = { id: '0', embedding: [1, 2] };
  const other = { id: '1', embedding: [3, 4] };
  it.each([
    ['no results', undefined],
    ['results that are not a list', { 0: good }],
    ['too few results', [good]],
    ['too many results', [good, other, { id: '2', embedding: [5, 6] }]],
    ['a result that is not an object', [good, null]],
    ['an id that was not sent', [good, { ...other, id: '2' }]],
    ['an id that is not a string', [good, { ...other, id: 1 }]],
    ['an id from the object prototype', [good, { ...other, id: 'constructor' }]],
    ['a repeated id', [good, good]],
    ['neither a vector nor an error', [good, { id: '1' }]],
    ['both a vector and an error', [good, { ...other, error: 'too_long' }]],
    ['a vector that is not a list', [good, { id: '1', embedding: '3,4' }]],
    ['a vector that is null', [good, { id: '1', embedding: null }]],
    ['a short vector', [good, { id: '1', embedding: [3] }]],
    ['a long vector', [good, { id: '1', embedding: [3, 4, 5] }]],
    ['a vector with text', [good, { id: '1', embedding: [3, '4'] }]],
    ['a vector with null', [good, { id: '1', embedding: [3, null] }]],
  ])('refuses %s', async (_label, results) => {
    const host = fakeHost(afterFirstCall((request) => Response.json(answer(request, { results }))));
    const connection = await connect(host.fetch);
    expect((await failure(connection.embed(['a', 'b']))).code).toBe('invalid_response');
    expect(host.requests).toHaveLength(2);
  });

  it('refuses a number that is not finite', async () => {
    const host = fakeHost(
      afterFirstCall(
        () =>
          new Response(
            `{"model":${JSON.stringify(MODEL)},"results":[{"id":"0","embedding":[1e999,0]}]}`
          )
      )
    );
    const connection = await connect(host.fetch);
    expect((await failure(connection.embed(['a']))).code).toBe('invalid_response');
  });

  it.each([undefined, {}, { tokens: 0 }, { tokens: 5, other: 'x' }])(
    'accepts the usage %j',
    async (usage) => {
      const host = fakeHost((request) => Response.json(answer(request, { usage })));
      const connection = await connect(host.fetch);
      const { tokensUsed } = await connection.embed(['a']);
      expect(tokensUsed).toBe(usage?.tokens ?? 0);
    }
  );

  it.each([null, 5, { tokens: -1 }, { tokens: 1.5 }, { tokens: '5' }, { tokens: null }])(
    'refuses the usage %j',
    async (usage) => {
      const host = fakeHost(afterFirstCall((request) => Response.json(answer(request, { usage }))));
      const connection = await connect(host.fetch);
      expect((await failure(connection.embed(['a']))).code).toBe('invalid_response');
    }
  );

  it('keeps a __proto__ key in a response away from its results', async () => {
    const host = fakeHost(
      afterFirstCall(
        () =>
          new Response(
            `{"__proto__":{"polluted":1},"model":${JSON.stringify(MODEL)},` +
              '"results":[{"__proto__":{"error":"x"},"id":"0","embedding":[1,2]}]}'
          )
      )
    );
    const connection = await connect(host.fetch);
    expect((await connection.embed(['a'])).vectors).toEqual([[1, 2]]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('response body', () => {
  it.each([
    ['text', '<html>'],
    ['a list', '[]'],
    ['an empty body', ''],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ])('refuses %s without a retry', async (_label, body) => {
    const host = fakeHost(() => new Response(body));
    expect((await failure(connect(host.fetch))).code).toBe('invalid_response');
    expect(host.requests).toHaveLength(1);
  });

  it('refuses a response with no body', async () => {
    const host = fakeHost(() => new Response(null, { status: 200 }));
    expect((await failure(connect(host.fetch))).code).toBe('invalid_response');
  });

  const KIB = 1024;
  const MIB = 1024 * KIB;

  /** The first response or a later one, and the most bytes it may have. */
  const caps: Array<[string, number, (reply: Reply) => Reply, boolean]> = [
    ['first response', 64 * KIB, (reply) => reply, false],
    ['batch response', 16 * MIB, afterFirstCall, true],
  ];

  async function run(reply: Reply, sendsBatch: boolean) {
    const host = fakeHost(reply);
    const result = connect(host.fetch).then((connection) =>
      sendsBatch ? connection.embed(['a']) : undefined
    );
    return { host, result };
  }

  describe.each(caps)('%s', (_label, cap, place, sendsBatch) => {
    const padded = (request: SentRequest, length: number): string => {
      const body = JSON.stringify(answer(request, { padding: '' }));
      return body.replace('"padding":""', `"padding":"${' '.repeat(length - body.length)}"`);
    };

    it('may be as large as its cap', async () => {
      const { result } = await run(
        place((request) => new Response(padded(request, cap))),
        sendsBatch
      );
      await expect(result).resolves.not.toThrow();
    });

    it('may not be one byte larger', async () => {
      const { host, result } = await run(
        place((request) => new Response(padded(request, cap + 1))),
        sendsBatch
      );
      const error = await failure(result);
      expect(error.code).toBe('invalid_response');
      expect(error.message).toContain(`over ${cap} bytes`);
      expect(host.requests).toHaveLength(sendsBatch ? 2 : 1);
    });

    it('is refused for its declared size, and cancelled', async () => {
      const cancel = vi.fn();
      const { result } = await run(
        place(
          () =>
            new Response(new ReadableStream({ cancel }), {
              headers: { 'content-length': String(cap + 1) },
            })
        ),
        sendsBatch
      );
      expect((await failure(result)).message).toContain(`over ${cap} bytes`);
      expect(cancel).toHaveBeenCalled();
    });

    it('is cancelled once it passes the cap, whatever it declares', async () => {
      const cancel = vi.fn();
      const chunk = new Uint8Array(cap / 16).fill(0x20);
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(chunk)
      );
      const { result } = await run(
        place(() => new Response(new ReadableStream({ pull, cancel }))),
        sendsBatch
      );
      expect((await failure(result)).code).toBe('invalid_response');
      expect(cancel).toHaveBeenCalled();
      expect(pull.mock.calls.length).toBeLessThan(25);
    });
  });

  it('counts a compressed body after decompression, and does not retry a broken one', async () => {
    const padded = JSON.stringify({ model: MODEL, results: [], padding: ' '.repeat(65 * KIB) });
    const broken = gzipSync('{"model":{}}');
    broken.fill(0xff, 12);
    expect(gzipSync(padded).length).toBeLessThan(KIB);
    let requests = 0;
    const url = await listen(
      createServer((request, response) => {
        requests += 1;
        response.writeHead(200, { 'content-encoding': 'gzip' });
        response.end(request.url === '/embed' ? gzipSync(padded) : broken);
      })
    );
    const tooLarge = await failure(connect(nodeFetchTo(url)));
    expect(tooLarge.message).toContain('over 65536 bytes');
    const undecodable = await failure(connect(nodeFetchTo(`${url}/broken`)));
    expect(undecodable.code).toBe('invalid_response');
    expect(requests).toBe(2);
  });
});

describe('endpoint URL', () => {
  const accepted = async (url: string): Promise<boolean> => {
    const host = fakeHost();
    try {
      await connect(host.fetch, { url });
      return true;
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_config', exitCode: 2 });
      expect(host.requests).toHaveLength(0);
      return false;
    }
  };

  // The URL parser turns the numeric spellings into 127.0.0.1 or [::1]. The scheme decides,
  // so none of them is a way around https.
  it.each([
    'http://host.example/embed',
    'http://host.example./embed',
    'http://127.0.0.1/embed',
    'http://127.0.0.1:8080/embed',
    'http://127.0.0.1./embed',
    'http://127.0.0.2/embed',
    'http://127.1/embed',
    'http://2130706433/embed',
    'http://0x7f000001/embed',
    'http://0177.0.0.1/embed',
    'http://%31%32%37.0.0.1/embed',
    'http://[::1]/embed',
    'http://[::1]:8080/embed',
    'http://[0:0:0:0:0:0:0:1]/embed',
    'http://[::ffff:127.0.0.1]/embed',
    'http://[::ffff:7f00:1]/embed',
    'http://localhost/embed',
    'http://localhost./embed',
    'http://app.localhost/embed',
    'http://10.0.0.1/embed',
    'http://192.168.1.10/embed',
    'http://169.254.169.254/embed',
    'http://0.0.0.0/embed',
    'http://127.0.0.1@host.example/embed',
    'HTTP://127.0.0.1/embed',
    'http:127.0.0.1/embed',
    'ftp://host.example/embed',
    'ws://host.example/embed',
    'file:///etc/hosts',
    'data:application/json,{}',
    'host.example/embed',
    '127.0.0.1/embed',
    '//host.example/embed',
    '',
  ])('refuses %j and sends nothing', async (url) => {
    expect(await accepted(url)).toBe(false);
  });

  it.each([
    'https://host.example/embed',
    'HTTPS://host.example/embed',
    'https://host.example./embed',
    'https://host.example:8443/embed?key=value',
    'https://127.0.0.1:8443/embed',
    'https://[::1]/embed',
    'https://localhost/embed',
  ])('accepts %s', async (url) => {
    expect(await accepted(url)).toBe(true);
  });

  it.each([
    'https://user:synthetic-password@host.example/embed',
    'https://user@host.example/embed',
    'https://:synthetic-password@host.example/embed',
    'https://host.example/embed#part',
    'https://host.example/embed#',
    'https://host.example/em\nbed',
    'https://host.example/em\tbed',
    'https://host.example/embed\r\nX-Injected: 1',
    'https://host.example/em\u0000bed',
    'https://host.example/em\u007fbed',
    'https://host.example/em\u0085bed',
    ' https://host.example/embed',
    'https://host.example/embed ',
    'https://host.example/em bed',
  ])('refuses %j', async (url) => {
    expect(await accepted(url)).toBe(false);
  });

  it.each(['', ' ', 'two words', 'line\nbreak', 'return\rhere', 'tab\there', 'tökén', 'nul\u0000'])(
    'refuses the token %j',
    async (token) => {
      const host = fakeHost();
      expect(await failure(connect(host.fetch, { token }))).toMatchObject({
        code: 'invalid_config',
        exitCode: 2,
      });
      expect(host.requests).toHaveLength(0);
    }
  );
});

describe('certificate checks', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('connects to nothing when they are turned off', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const host = fakeHost();
    const error = await failure(connect(host.fetch));
    expect(error).toMatchObject({ code: 'invalid_config', exitCode: 2 });
    expect(error.message).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(host.requests).toHaveLength(0);
  });

  it.each(['1', '', undefined])('connects when the variable is %j', async (value) => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', value);
    await expect(connect(fakeHost().fetch)).resolves.toMatchObject({ model: MODEL });
  });
});

describe('redirects', () => {
  it.each([
    [301, 'https://host.example/other'],
    [302, 'http://127.0.0.1/other'],
    [303, '/other'],
    [307, 'https://host.example/other'],
    [308, 'http://host.example/other'],
  ])('fails without a retry on HTTP status %i to %s', async (status, location) => {
    const host = fakeHost(() => new Response(null, { status, headers: { location } }));
    const error = await failure(connect(host.fetch));
    expect(error.code).toBe('redirect');
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]!.init.redirect).toBe('error');
  });

  it('fails without a retry when fetch reports a redirect', async () => {
    const host = fakeHost(() => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    expect((await failure(connect(host.fetch))).code).toBe('redirect');
    expect(host.requests).toHaveLength(1);
  });

  it('fails when fetch followed a redirect anyway', async () => {
    const host = fakeHost((request) =>
      Object.defineProperty(Response.json(answer(request)), 'redirected', { value: true })
    );
    expect((await failure(connect(host.fetch))).code).toBe('redirect');
  });

  it("is refused by Node's own fetch before the target is reached", async () => {
    let targetRequests = 0;
    const target = await listen(
      createServer((_request, response) => {
        targetRequests += 1;
        response.end('{}');
      })
    );
    let requests = 0;
    const host = await listen(
      createServer((_request, response) => {
        requests += 1;
        response.writeHead(307, { location: target });
        response.end();
      })
    );
    const error = await failure(connect(nodeFetchTo(host)));
    expect(error.code).toBe('redirect');
    expect(requests).toBe(1);
    expect(targetRequests).toBe(0);
  });
});

describe('attempts', () => {
  const networkError = (code: string): TypeError =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ${code} 127.0.0.1 ${TOKEN}`), { code }),
    });

  it.each([408, 429, 500, 502, 503, 599])('tries HTTP status %i four times', async (status) => {
    const cancel = vi.fn();
    const host = fakeHost(() => new Response(new ReadableStream({ cancel }), { status }));
    const error = await failure(connect(host.fetch));
    expect(error).toMatchObject({ code: 'http_status', exitCode: 1 });
    expect(error.message).toContain(`HTTP status ${status} after 4 attempts`);
    expect(host.requests).toHaveLength(4);
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('keeps one idempotency key and body for the attempts of one batch', async () => {
    const host = fakeHost((request, call) =>
      call === 1 || call === 4
        ? Response.json(answer(request))
        : new Response(null, { status: 503 })
    );
    const connection = await connect(host.fetch);
    const result = await connection.embed([TEXT]);

    expect(result.requests).toBe(1);
    const [first, ...attempts] = host.requests;
    expect(attempts).toHaveLength(3);
    const keys = attempts.map((request) => request.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe(first!.headers.get('idempotency-key'));
    expect(new Set(attempts.map((request) => request.init.body)).size).toBe(1);
  });

  it('waits longer before each attempt, with jitter', async () => {
    const waits = async (random: () => number): Promise<number[]> => {
      const delays: number[] = [];
      const host = fakeHost(() => new Response(null, { status: 503 }));
      await failure(
        connect(host.fetch, {
          random,
          delay: async (milliseconds) => {
            delays.push(milliseconds);
          },
        })
      );
      return delays;
    };
    expect(await waits(() => 0)).toEqual([250, 500, 1000]);
    expect(await waits(() => 1)).toEqual([500, 1000, 2000]);
  });

  it.each([
    ['2', 2000],
    ['30', 30_000],
    ['31', 30_000],
    ['999999999', 30_000],
    ['0', 250],
    ['1.5', 250],
    ['-1', 250],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 250],
  ])('reads Retry-After %s as %i ms', async (header, expected) => {
    const delays: number[] = [];
    const host = fakeHost((request, call) =>
      call === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': header } })
        : Response.json(answer(request))
    );
    await connect(host.fetch, {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(delays).toEqual([expected]);
  });

  it.each([400, 402, 404, 409, 413, 422])('does not retry HTTP status %i', async (status) => {
    const cancel = vi.fn();
    const host = fakeHost(() => new Response(new ReadableStream({ cancel }), { status }));
    const error = await failure(connect(host.fetch));
    expect(error.message).toBe(`The host embedding request failed with HTTP status ${status}.`);
    expect(host.requests).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('reports HTTP status %i as a refused token', async (status) => {
    const cancel = vi.fn();
    const host = fakeHost(() => new Response(new ReadableStream({ cancel }), { status }));
    const error = await failure(connect(host.fetch));
    expect(error).toMatchObject({ code: 'unauthorized', exitCode: 1 });
    expect(error.message).toContain(`HTTP status ${status}`);
    expect(host.requests).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retries a network error and reports only its code', async () => {
    const host = fakeHost(() => {
      throw networkError('ECONNRESET');
    });
    const error = await failure(connect(host.fetch));
    expect(error.code).toBe('network');
    expect(error.message).toBe(
      'The host embedding request failed with a network error (ECONNRESET) after 4 attempts.'
    );
    expect(host.requests).toHaveLength(4);
  });

  it.each([
    ['no cause', new TypeError('fetch failed')],
    ['a code that is not one', networkError(`bad code ${TOKEN}`)],
    ['a thrown string', TOKEN],
    ['nothing', undefined],
  ])('retries %s without repeating what was thrown', async (_label, thrown) => {
    const host = fakeHost(() => {
      throw thrown;
    });
    const error = await failure(connect(host.fetch));
    expect(error.message).toBe(
      'The host embedding request failed with a network error after 4 attempts.'
    );
  });

  it('retries a body that breaks off', async () => {
    const host = fakeHost((request, call) =>
      call === 1
        ? new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(networkError('UND_ERR_SOCKET'));
              },
            })
          )
        : Response.json(answer(request))
    );
    await connect(host.fetch);
    expect(host.requests).toHaveLength(2);
  });

  /** Fires each attempt's timeout as soon as the attempt waits for something. */
  const timeOutAtOnce: HostEmbeddingOptions['startTimeout'] = (milliseconds, onTimeout) => {
    expect(milliseconds).toBe(60_000);
    const timer = setImmediate(onTimeout);
    return () => clearImmediate(timer);
  };

  it('times out a request that gets no response, even if fetch ignores the signal', async () => {
    const host = fakeHost(() => new Promise<Response>(() => {}));
    const error = await failure(connect(host.fetch, { startTimeout: timeOutAtOnce }));
    expect(error.code).toBe('timeout');
    expect(error.message).toBe('The host embedding request timed out after 4 attempts.');
    expect(host.requests).toHaveLength(4);
    expect(host.requests.every((request) => request.init.signal?.aborted)).toBe(true);
  });

  it('cancels a response that arrives after the timeout', async () => {
    const cancel = vi.fn();
    const late: Array<(response: Response) => void> = [];
    const host = fakeHost(() => new Promise<Response>((resolve) => late.push(resolve)));
    await failure(connect(host.fetch, { startTimeout: timeOutAtOnce }));
    for (const resolve of late) resolve(new Response(new ReadableStream({ cancel })));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('times out a body that never ends and cancels it', async () => {
    const cancel = vi.fn();
    const host = fakeHost(() => new Response(new ReadableStream({ cancel })));
    const error = await failure(connect(host.fetch, { startTimeout: timeOutAtOnce }));
    expect(error.code).toBe('timeout');
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('stops each attempt timer and waits with real timers by default', async () => {
    vi.useFakeTimers();
    const host = fakeHost((request, call) =>
      call === 1 ? new Response(null, { status: 503 }) : Response.json(answer(request))
    );
    const connected = connectHostEmbedding({ url: URL_WITH_PATH, token: TOKEN, fetch: host.fetch });
    await vi.advanceTimersByTimeAsync(500);
    await expect(connected).resolves.toMatchObject({ model: MODEL });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('what an error may say', () => {
  const body = `{"error":"${TEXT} ${TOKEN}"`;
  const failures: Array<[string, Reply]> = [
    ['a refused token', () => new Response(body, { status: 401 })],
    ['a bad request', () => new Response(body, { status: 400 })],
    ['a server error', () => new Response(body, { status: 500 })],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: TOKEN } })],
    ['a body that is not JSON', () => new Response(body)],
    [
      'a network error',
      () => {
        throw new TypeError(`fetch ${URL_WITH_PATH} ${TOKEN}`, {
          cause: Object.assign(new Error(`${TEXT} ${TOKEN}`), { code: 'ECONNREFUSED' }),
        });
      },
    ],
    [
      'a model that changed',
      (request) => Response.json(answer(request, { model: { ...MODEL, id: TEXT } })),
    ],
    [
      'an id that was not sent',
      (request) => Response.json(answer(request, { results: [{ id: TEXT, embedding: [1, 2] }] })),
    ],
    [
      'a vector that is text',
      (request) => Response.json(answer(request, { results: [{ id: '0', embedding: TEXT }] })),
    ],
  ];

  it.each(failures)('says nothing it was sent or told after %s', async (_label, reply) => {
    const host = fakeHost(afterFirstCall(reply));
    const connection = await connect(host.fetch);
    const error = await failure(connection.embed([TEXT]));

    expect(error.cause).toBeUndefined();
    const told = [error.message, error.stack, String(error), JSON.stringify(error)].join('\n');
    expect(told).not.toContain(TOKEN);
    expect(told).not.toContain('sled dogs');
    expect(told).not.toContain('host.example');
    expect(told).not.toContain('private/embed');
  });

  it('says neither the URL nor the token when one is refused', async () => {
    const { fetch: fetchMock } = fakeHost();
    const url = `http://${TOKEN}.example/private`;
    for (const overrides of [{ url }, { url: `::${TOKEN}` }, { token: `${TOKEN} x` }]) {
      const error = await failure(connect(fetchMock, overrides));
      expect(error.cause).toBeUndefined();
      expect([error.message, error.stack].join('\n')).not.toContain(TOKEN);
    }
  });
});
