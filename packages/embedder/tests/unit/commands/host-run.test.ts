import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { parseStderrMessage } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleRunError, parseEmbedderConfig, runEmbedCommand } from '../../../src/commands/run.js';

const TOKEN = 'synthetic-host-token';
const HOST_URL = 'https://host.example/private/embed';
const ENV = { DOGSLED_HOST_EMBEDDING_URL: HOST_URL, DOGSLED_HOST_EMBEDDING_TOKEN: TOKEN };
const MODEL = { provider: 'acme', id: 'acme-embed-1', dimensions: 2 };

interface HostRequest {
  inputs: Array<{ id: string; text: string }>;
}

type Answer = (request: HostRequest, call: number) => Record<string, unknown> | Response;

function fakeHost(answer: Answer = () => ({})) {
  const requests: HostRequest[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as HostRequest;
    requests.push(request);
    const answered = answer(request, requests.length);
    if (answered instanceof Response) return answered;
    return Response.json({
      model: MODEL,
      results: request.inputs.map(({ id, text }) => ({ id, embedding: [text.length, 1] })),
      usage: { tokens: request.inputs.length },
      ...answered,
    });
  });
  return { fetch: fetchMock, requests };
}

function buffer(): { text: () => string; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { text: () => chunks.join(''), stream };
}

function lines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const schema = {
  _v: 1,
  type: 'SCHEMA',
  stream: 'docs',
  schema: {
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'body', type: 'string' },
      { name: 'title', type: 'string' },
    ],
  },
  key_properties: ['id'],
  load_strategy: 'append',
};

function record(id: number, body: string | null, title: string | null = null, stream = 'docs') {
  return {
    _v: 1,
    type: 'RECORD',
    stream,
    time_extracted: '2026-01-01T00:00:00.000Z',
    record: { id, body, title },
  };
}

interface RunOptions {
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  host?: ReturnType<typeof fakeHost>;
}

async function run(messages: unknown[], { config, env = ENV, host = fakeHost() }: RunOptions = {}) {
  const output = buffer();
  const errorOutput = buffer();
  let error: unknown;
  try {
    await runEmbedCommand(
      parseEmbedderConfig({ provider: 'host', streams: { docs: [{ field: 'body' }] }, ...config }),
      {
        input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
        output: output.stream,
        errorOutput: errorOutput.stream,
        env,
        hostEmbedding: { fetch: host.fetch, delay: async () => {} },
      }
    );
  } catch (thrown) {
    error = thrown;
    handleRunError(thrown, errorOutput.stream);
    process.exitCode = undefined;
  }
  const stdout = output.text();
  const stderr = errorOutput.text();
  return { stdout, stderr, output: lines(stdout), logs: lines(stderr), error, host };
}

function records(output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return output
    .filter((message) => message['type'] === 'RECORD')
    .map((message) => message['record'] as Record<string, unknown>);
}

function metrics(logs: Array<Record<string, unknown>>): Record<string, unknown> {
  return logs.find((message) => message['type'] === 'METRIC')?.['metrics'] as Record<
    string,
    unknown
  >;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function batchOf(rows: unknown[]): { message: Record<string, unknown>; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'host-embed-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'docs-0.jsonl');
  writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return {
    dir,
    message: {
      _v: 1,
      type: 'BATCH',
      stream: 'docs',
      encoding: { format: 'jsonl' },
      manifest: [pathToFileURL(file).href],
    },
  };
}

function batchRows(output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const batch = output.find((message) => message['type'] === 'BATCH')!;
  const [file] = batch['manifest'] as string[];
  return lines(readFileSync(new URL(file!), 'utf8'));
}

describe('provider: host', () => {
  it('asks for the model before the SCHEMA and records it on the vector column', async () => {
    const written: string[] = [];
    const host = fakeHost((_request, call) => {
      written.push(`call ${call}`);
      return {};
    });
    const { output, stdout } = await run([schema, record(1, 'hello')], { host });

    expect(host.requests[0]!.inputs).toEqual([]);
    expect(host.requests[1]!.inputs).toEqual([{ id: '0', text: 'hello' }]);
    expect(written).toEqual(['call 1', 'call 2']);
    expect(output[0]).toMatchObject({
      type: 'SCHEMA',
      schema: {
        columns: expect.arrayContaining([
          {
            name: 'body_embedding',
            type: 'vector',
            dimension: 2,
            embedded_from: {
              column: 'body',
              provider: 'acme',
              model: 'acme-embed-1',
              dimension: 2,
            },
          },
        ]),
      },
    });
    expect(records(output)).toEqual([
      { id: 1, body: 'hello', title: null, body_embedding: [5, 1] },
    ]);
    expect(stdout).not.toContain(TOKEN);
  });

  it('embeds BATCH files', async () => {
    const { message, dir } = batchOf([
      { id: 1, body: 'one' },
      { id: 2, body: null },
      { id: 3, body: 'three' },
    ]);
    const { output, logs } = await run([schema, message], {
      env: { ...ENV, DOGSLED_EMBEDDER_TMP_DIR: dir },
    });
    expect(batchRows(output)).toEqual([
      { id: 1, body: 'one', body_embedding: [3, 1] },
      { id: 2, body: null, body_embedding: null },
      { id: 3, body: 'three', body_embedding: [5, 1] },
    ]);
    expect(metrics(logs)).toMatchObject({
      embedding_records_processed: 3,
      embedding_tokens_processed: 2,
      embedding_inputs_rejected: 0,
    });
  });

  it.each([
    [{}, 'DOGSLED_HOST_EMBEDDING_URL, DOGSLED_HOST_EMBEDDING_TOKEN'],
    [{ DOGSLED_HOST_EMBEDDING_URL: HOST_URL }, 'DOGSLED_HOST_EMBEDDING_TOKEN'],
    [{ DOGSLED_HOST_EMBEDDING_TOKEN: TOKEN }, 'DOGSLED_HOST_EMBEDDING_URL'],
    [{ ...ENV, DOGSLED_HOST_EMBEDDING_TOKEN: '' }, 'DOGSLED_HOST_EMBEDDING_TOKEN'],
  ])('sends nothing and names what is missing: %j', async (env, missing) => {
    const { error, host, stdout } = await run([schema], { env });
    expect(error).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(`Not set: ${missing}.`),
    });
    expect(host.requests).toHaveLength(0);
    expect(stdout).toBe('');
  });

  it.each(['http://host.example/embed', 'http://127.0.0.1/embed', 'http://localhost/embed'])(
    'requires https: %s',
    async (url) => {
      const { error, host, stdout } = await run([schema], {
        env: { ...ENV, DOGSLED_HOST_EMBEDDING_URL: url },
      });
      expect(error).toMatchObject({ exitCode: 2, message: expect.stringContaining('https') });
      expect(host.requests).toHaveLength(0);
      expect(stdout).toBe('');
    }
  );

  it('accepts a matching dimension and never sends it', async () => {
    const { error, host } = await run([schema, record(1, 'a')], { config: { dimension: 2 } });
    expect(error).toBeUndefined();
    expect(JSON.stringify(host.requests)).not.toContain('dimension');
  });

  it('fails on another dimension before it writes anything or sends text', async () => {
    const { error, host, stdout } = await run([schema, record(1, 'a')], {
      config: { dimension: 1024 },
    });
    expect(error).toMatchObject({
      exitCode: 2,
      message: "The embed config sets dimension 1024, but the host's embedding model has 2.",
    });
    expect(host.requests).toEqual([{ inputs: [], purpose: 'document' }]);
    expect(stdout).toBe('');
  });

  it('leaves a refused input without a vector, counts it, and goes on', async () => {
    const host = fakeHost((request, call) =>
      call === 1
        ? {}
        : {
            results: request.inputs.map(({ id, text }) =>
              text.startsWith('bad')
                ? { id, error: text === 'bad long' ? 'too_long' : 'Secret: bad' }
                : { id, embedding: [1, 2] }
            ),
          }
    );
    const { output, logs } = await run(
      [
        schema,
        record(1, 'good'),
        record(2, 'bad long'),
        record(3, 'bad long'),
        record(4, 'bad other'),
      ],
      { host }
    );
    expect(records(output).map((row) => row['body_embedding'])).toEqual([[1, 2], null, null, null]);
    expect(metrics(logs)).toMatchObject({
      embedding_inputs_rejected: 3,
      embedding_records_processed: 4,
    });
    expect(logs.filter((message) => message['level'] === 'warn')).toEqual([
      {
        _v: 1,
        type: 'LOG',
        level: 'warn',
        message:
          'The embedding provider refused 3 inputs in stream "docs", and their vectors are null ' +
          '(too_long: 2, unknown: 1)',
        time: expect.any(String),
        event: 'embedding.inputs_rejected',
        attributes: { stream: 'docs', counts: { too_long: 2, unknown: 1 } },
      },
    ]);
  });

  it('sends a structured report that the protocol parser keeps', async () => {
    const host = fakeHost((request, call) =>
      call === 1 ? {} : { results: request.inputs.map(({ id, text }) => ({ id, error: text })) }
    );
    const { logs } = await run(
      [schema, record(1, 'constructor'), record(2, 'valueOf'), record(3, '__proto__')],
      { host }
    );
    const warning = logs.find((message) => message['level'] === 'warn');
    // The host client turns a code that is not one into `unknown`.
    expect(parseStderrMessage(warning)).toMatchObject({
      type: 'LOG',
      event: 'embedding.inputs_rejected',
      attributes: { stream: 'docs', counts: { unknown: 2, constructor: 1 } },
    });
    expect(parseStderrMessage(logs.find((message) => message['type'] === 'METRIC'))).toMatchObject({
      metrics: { embedding_inputs_rejected: 3 },
    });
  });

  const blank = ['', ' ', '   ', '\n\t\r\n', '\u00a0\u2003\ufeff'];

  it('has nothing to embed in whitespace, in a RECORD', async () => {
    const { output, logs, host } = await run([
      schema,
      ...blank.map((text, index) => record(index, text)),
      record(9, ' a '),
    ]);
    expect(records(output).map((row) => row['body_embedding'])).toEqual([
      ...blank.map(() => null),
      [3, 1],
    ]);
    expect(host.requests.slice(1).flatMap(({ inputs }) => inputs)).toEqual([
      { id: '0', text: ' a ' },
    ]);
    expect(metrics(logs)).toMatchObject({
      embedding_inputs_rejected: 0,
      embedding_tokens_truncated: 0,
      embedding_records_processed: blank.length + 1,
    });
    expect(logs.filter((message) => message['type'] === 'LOG')).toEqual([]);
  });

  it('has nothing to embed in whitespace, in a BATCH', async () => {
    const { message, dir } = batchOf([...blank, ' a '].map((body, index) => ({ id: index, body })));
    const { output, logs, host } = await run([schema, message], {
      env: { ...ENV, DOGSLED_EMBEDDER_TMP_DIR: dir },
    });
    expect(batchRows(output).map((row) => row['body_embedding'])).toEqual([
      ...blank.map(() => null),
      [3, 1],
    ]);
    expect(host.requests.slice(1).flatMap(({ inputs }) => inputs)).toEqual([
      { id: '0', text: ' a ' },
    ]);
    expect(logs.filter((message) => message['type'] === 'LOG')).toEqual([]);
  });

  it('sends no request when a whole run is whitespace, and stubs no vector for it', async () => {
    const { output, host } = await run([schema, record(1, ' \n ')]);
    expect(host.requests).toHaveLength(1);
    expect(records(output)[0]!['body_embedding']).toBeNull();
    const stubbed = await run([schema, record(1, ' \n ')], {
      env: { DOGSLED_EMBED_STUB: '1' },
      config: { dimension: 2 },
    });
    expect(records(stubbed.output)[0]!['body_embedding']).toBeNull();
  });

  it('still reports the cut when only whitespace is left of a longer text', async () => {
    const host = fakeHost(() => ({ limits: { maxInputCharacters: 2 } }));
    const { output, logs } = await run([schema, record(1, '   text')], { host });
    expect(records(output)[0]!['body_embedding']).toBeNull();
    expect(host.requests).toHaveLength(1);
    expect(metrics(logs)).toMatchObject({ embedding_tokens_truncated: 1 });
  });

  it('reports a bounded number of codes, once for each stream', async () => {
    const host = fakeHost((request, call) =>
      call === 1
        ? {}
        : { results: request.inputs.map(({ id, text }) => ({ id, error: `code_${text}` })) }
    );
    const { logs } = await run(
      [
        schema,
        { ...schema, stream: 'notes' },
        ...Array.from({ length: 60 }, (_, index) => record(index, String(index))),
        record(1, 'n', null, 'notes'),
      ],
      { host, config: { streams: { docs: [{ field: 'body' }], notes: [{ field: 'body' }] } } }
    );
    const warnings = logs.filter((message) => message['level'] === 'warn');
    const texts = warnings.map((message) => String(message['message']));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('refused 60 inputs');
    expect(texts[0]!.match(/code_/g)).toHaveLength(20);
    expect(texts[0]).toContain('other: 40');
    expect(texts[1]).toContain('refused 1 input in stream "notes"');
    const counts = warnings.map(
      (message) => (message['attributes'] as { counts: Record<string, number> }).counts
    );
    expect(Object.keys(counts[0]!)).toHaveLength(21);
    expect(counts[0]).toMatchObject({ other: 40, code_0: 1 });
    expect(counts[1]).toEqual({ code_n: 1 });
  });

  it('cuts text to the character limit, keeps surrogate pairs whole, and warns once', async () => {
    const host = fakeHost(() => ({ limits: { maxInputCharacters: 4 } }));
    const { logs, stderr } = await run(
      [
        schema,
        record(1, 'abcdef'),
        record(2, 'abc\u{1F6F7}x'),
        record(3, 'ab\u{1F6F7}x'),
        record(4, 'abcd'),
      ],
      { host }
    );
    expect(host.requests.slice(1).flatMap(({ inputs }) => inputs.map(({ text }) => text))).toEqual([
      'abcd',
      'abc',
      'ab\u{1F6F7}',
      'abcd',
    ]);
    expect(metrics(logs)).toMatchObject({ embedding_tokens_truncated: 3 });
    const warnings = logs.filter((message) => message['level'] === 'warn');
    expect(warnings.map((message) => message['message'])).toEqual([
      'Truncating field "body" in stream "docs" to 4 characters (first occurrence, original length 6 characters)',
    ]);
    expect(stderr).not.toContain('abcdef');
  });

  it('counts a text once when it is over both limits, and warns about each', async () => {
    const host = fakeHost(() => ({ limits: { maxInputCharacters: 45_000 } }));
    const { logs } = await run([schema, record(1, 'word '.repeat(10_000))], { host });
    expect(host.requests[1]!.inputs[0]!.text.length).toBeLessThan(45_000);
    expect(metrics(logs)).toMatchObject({ embedding_tokens_truncated: 1 });
    const warnings = logs
      .filter((message) => message['level'] === 'warn')
      .map((message) => String(message['message']));
    expect(warnings).toEqual([
      expect.stringContaining('to 45000 characters'),
      expect.stringContaining('to 8191 tokens'),
    ]);
  });

  it('has nothing to embed when the limit leaves no character', async () => {
    const host = fakeHost(() => ({ limits: { maxInputCharacters: 1 } }));
    const { output } = await run([schema, record(1, '\u{1F6F7}')], { host });
    expect(records(output)[0]!['body_embedding']).toBeNull();
    expect(host.requests).toHaveLength(1);
  });

  it('flushes at four requests of maxInputs and counts each request', async () => {
    const host = fakeHost(() => ({ limits: { maxInputs: 2 } }));
    const { logs, output } = await run(
      [schema, ...Array.from({ length: 11 }, (_, index) => record(index, `t${index}`))],
      { host }
    );
    expect(records(output)).toHaveLength(11);
    expect(host.requests.slice(1).map(({ inputs }) => inputs.length)).toEqual([2, 2, 2, 2, 2, 1]);
    expect(metrics(logs)).toMatchObject({
      embedding_api_calls: 6,
      embedding_tokens_processed: 11,
    });
  });

  it('counts a retried request once', async () => {
    const host = fakeHost((_request, call) =>
      call === 2 ? new Response(null, { status: 503 }) : {}
    );
    const { logs } = await run([schema, record(1, 'a')], { host });
    expect(host.requests).toHaveLength(3);
    expect(metrics(logs)).toMatchObject({ embedding_api_calls: 1 });
  });

  it('embeds a record with more fields than four requests hold', async () => {
    const host = fakeHost(() => ({ limits: { maxInputs: 1 } }));
    const fields = Array.from({ length: 6 }, (_, index) => ({ field: 'body', as: `v${index}` }));
    const { error, output } = await run([schema, record(1, 'abc')], {
      host,
      config: { streams: { docs: fields } },
    });
    expect(error).toBeUndefined();
    expect(records(output)[0]).toMatchObject({ v0: [3, 1], v5: [3, 1] });
  });

  it('stubs without the host when a dimension is set', async () => {
    const { output, host } = await run([schema, record(1, 'a')], {
      env: { DOGSLED_EMBED_STUB: '1' },
      config: { dimension: 3 },
    });
    expect(host.requests).toHaveLength(0);
    expect(records(output)[0]!['body_embedding']).toEqual([0, 0, 0]);
    const columns = (output[0]!['schema'] as { columns: Array<Record<string, unknown>> }).columns;
    expect(columns.at(-1)).toMatchObject({
      dimension: 3,
      embedded_from: { column: 'body', provider: 'host', model: 'stub', dimension: 3 },
    });
  });

  it('refuses to stub without a dimension', async () => {
    const { error, stdout } = await run([schema], { env: { DOGSLED_EMBED_STUB: '1' } });
    expect(error).toMatchObject({ exitCode: 2, message: expect.stringContaining('dimension') });
    expect(stdout).toBe('');
  });

  it.each<[string, Answer]>([
    ['refuses the token', () => new Response(`{"token":"${TOKEN}"}`, { status: 401 })],
    ['fails', () => new Response('quiet kennel', { status: 500 })],
    ['answers with something else', () => new Response('quiet kennel')],
    ['changes its model', () => ({ model: { ...MODEL, id: 'quiet kennel' } })],
    ['sends a short vector', () => ({ results: [{ id: '0', embedding: [1] }] })],
  ])('tells nothing private when the host %s', async (_label, answer) => {
    const text = 'quiet kennel';
    const host = fakeHost((request, call) => (call === 1 ? {} : answer(request, call)));
    const { error, stdout, stderr } = await run([schema, record(1, text)], { host });

    expect(error).toBeInstanceOf(Error);
    const told = [
      stderr,
      String(error),
      (error as Error).stack,
      String((error as Error).cause),
      JSON.stringify(error),
    ].join('\n');
    expect(told).not.toContain(TOKEN);
    expect(told).not.toContain(text);
    expect(told).not.toContain('host.example');
    expect(stdout).not.toContain(TOKEN);
    expect(lines(stdout).map((message) => message['type'])).toEqual(['SCHEMA']);
  });

  it('keeps the token and the text out of logs, metrics and SCHEMA when it works', async () => {
    const text = 'quiet kennel';
    const { output, stdout, stderr } = await run([schema, record(1, text)]);
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(stdout + stderr).not.toContain('host.example');
    expect(stderr).not.toContain(text);
    expect(JSON.stringify(output[0])).not.toContain(text);
  });

  it('reads the endpoint and token for no other provider, and sends it neither', async () => {
    const touched = new Set<string>();
    const note = (name: string | symbol): void => {
      if (String(name).startsWith('DOGSLED_HOST_')) touched.add(String(name));
    };
    const env = new Proxy<Record<string, string>>(
      { OPENAI_API_KEY: 'test-key', ...ENV },
      {
        get(target, name) {
          note(name);
          return Reflect.get(target, name) as unknown;
        },
        has(target, name) {
          note(name);
          return Reflect.has(target, name);
        },
        getOwnPropertyDescriptor(target, name) {
          note(name);
          return Reflect.getOwnPropertyDescriptor(target, name);
        },
        ownKeys(target) {
          touched.add('all names');
          return Reflect.ownKeys(target);
        },
      }
    );
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        sent.push(JSON.stringify([String(input), [...new Headers(init?.headers)], init?.body]));
        return Response.json({
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ object: 'embedding', index: 0, embedding: [0.5, 0.5] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      })
    );
    const output = buffer();
    const errorOutput = buffer();
    try {
      await runEmbedCommand(
        parseEmbedderConfig({
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: '$OPENAI_API_KEY',
          dimension: 2,
          streams: { docs: [{ field: 'body' }] },
        }),
        {
          input: Readable.from(
            [schema, record(1, 'hello')].map((message) => `${JSON.stringify(message)}\n`)
          ),
          output: output.stream,
          errorOutput: errorOutput.stream,
          env,
        }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(records(lines(output.text()))[0]).toMatchObject({ body_embedding: [0.5, 0.5] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('test-key');
    expect([...touched]).toEqual([]);
    for (const text of [...sent, output.text(), errorOutput.text()]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('host.example');
    }
  });

  it.each(['RECORD', 'BATCH'])(
    'keeps a malformed %s out of the error and the log',
    async (type) => {
      const { message, dir } = batchOf([{ id: 1, body: 'first' }]);
      const [file] = message['manifest'] as string[];
      writeFileSync(new URL(file!), '{"id":1,"body":"quiet kennel"');
      const malformed = '{"_v":1,"type":"RECORD","record":{"body":"quiet kennel"';
      const input = [
        JSON.stringify(schema),
        type === 'RECORD' ? malformed : JSON.stringify(message),
      ];
      const errorOutput = buffer();
      const error = await runEmbedCommand(
        parseEmbedderConfig({ provider: 'host', streams: { docs: [{ field: 'body' }] } }),
        {
          input: Readable.from(input.map((line) => `${line}\n`)),
          output: buffer().stream,
          errorOutput: errorOutput.stream,
          env: { ...ENV, DOGSLED_EMBEDDER_TMP_DIR: dir },
          hostEmbedding: { fetch: fakeHost().fetch },
        }
      ).catch((thrown: unknown) => thrown);
      handleRunError(error, errorOutput.stream);
      process.exitCode = undefined;
      expect(String(error)).toMatch(/is not valid JSON/);
      expect(errorOutput.text() + String((error as Error).stack)).not.toContain('kennel');
    }
  );
});
