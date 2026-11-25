import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { enrichSchema, runEmbedder } from '../../../src/runtime/processor.js';

import type { SchemaMessage } from '@bobsled-inc/protocol';

function createWritableBuffer(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
  };
}

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const baseSchemaMessage: SchemaMessage = {
  _v: 1,
  type: 'SCHEMA',
  stream: 'docs',
  schema: {
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'body', type: 'string' },
    ],
  },
  key_properties: ['id'],
  load_strategy: 'append',
};

describe('enrichSchema', () => {
  const provider = 'openai';
  const model = 'text-embedding-3-small';

  it('appends vector columns for configured fields with embedded_from provenance', () => {
    const enriched = enrichSchema(baseSchemaMessage, {
      streamConfigs: { docs: [{ field: 'body' }] },
      dimensions: 1536,
      provider,
      model,
    });

    expect(enriched.schema.columns).toContainEqual({
      name: 'body_embedding',
      type: 'vector',
      dimension: 1536,
      embedded_from: { column: 'body', provider, model, dimension: 1536 },
    });
  });

  it('respects aliases and keeps embedded_from.column as the source field', () => {
    const enriched = enrichSchema(baseSchemaMessage, {
      streamConfigs: { docs: [{ field: 'body', as: 'embedding' }] },
      dimensions: 1536,
      provider,
      model,
    });

    expect(enriched.schema.columns).toContainEqual({
      name: 'embedding',
      type: 'vector',
      dimension: 1536,
      embedded_from: { column: 'body', provider, model, dimension: 1536 },
    });
  });

  it('stamps embedded_from on every column when multiple fields are configured', () => {
    const wideSchema: SchemaMessage = {
      ...baseSchemaMessage,
      schema: {
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'title', type: 'string' },
          { name: 'body', type: 'string' },
        ],
      },
    };

    const enriched = enrichSchema(wideSchema, {
      streamConfigs: { docs: [{ field: 'title' }, { field: 'body', as: 'body_vec' }] },
      dimensions: 1536,
      provider,
      model,
    });

    expect(enriched.schema.columns).toContainEqual({
      name: 'title_embedding',
      type: 'vector',
      dimension: 1536,
      embedded_from: { column: 'title', provider, model, dimension: 1536 },
    });
    expect(enriched.schema.columns).toContainEqual({
      name: 'body_vec',
      type: 'vector',
      dimension: 1536,
      embedded_from: { column: 'body', provider, model, dimension: 1536 },
    });
  });

  it('passes through unchanged for non-configured streams', () => {
    expect(
      enrichSchema(baseSchemaMessage, {
        streamConfigs: { companies: [{ field: 'description' }] },
        dimensions: 1536,
        provider,
        model,
      })
    ).toEqual(baseSchemaMessage);
  });

  it('throws when a configured field is missing from the schema', () => {
    expect(() =>
      enrichSchema(baseSchemaMessage, {
        streamConfigs: { docs: [{ field: 'missing' }] },
        dimensions: 1536,
        provider,
        model,
      })
    ).toThrow(/Embed field "missing" not found/);
  });
});

describe('runEmbedder', () => {
  it('enriches RECORD messages with embedding values', async () => {
    const input = Readable.from([
      `${JSON.stringify(baseSchemaMessage)}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:00.000Z',
        record: { id: 1, body: 'hello' },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:01.000Z',
        record: { id: 2, body: 'world' },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'STATE',
        stream: 'docs',
        value: { record_count: 2 },
      })}\n`,
    ]);
    const output = createWritableBuffer();
    const errorOutput = createWritableBuffer();

    await runEmbedder({
      input,
      output: output.stream,
      errorOutput: errorOutput.stream,
      config: {
        streams: {
          docs: [{ field: 'body' }],
        },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn: async (texts: string[]) => ({
        vectors: texts.map((_text, index) => [index * 0.1, index * 0.2]),
        tokensUsed: 7,
      }),
    });

    const messages = parseLines(output.chunks);
    const schema = messages.find((message) => message['type'] === 'SCHEMA');
    const records = messages.filter((message) => message['type'] === 'RECORD');
    const state = messages.find((message) => message['type'] === 'STATE');
    expect(
      (schema?.['schema'] as { columns: Array<Record<string, unknown>> }).columns
    ).toContainEqual({
      name: 'body_embedding',
      type: 'vector',
      dimension: 2,
      embedded_from: {
        column: 'body',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: 2,
      },
    });
    expect(records[0]?.['record']).toMatchObject({
      id: 1,
      body: 'hello',
      body_embedding: [0, 0],
    });
    expect(records[1]?.['record']).toMatchObject({
      id: 2,
      body: 'world',
      body_embedding: [0.1, 0.2],
    });
    expect(state).toMatchObject({
      stream: 'docs',
      value: { record_count: 2 },
    });

    const stderrMessages = parseLines(errorOutput.chunks);
    expect(stderrMessages).toContainEqual(
      expect.objectContaining({
        type: 'METRIC',
        stream: 'docs',
        metrics: expect.objectContaining({
          embedding_api_calls: 1,
          embedding_tokens_processed: 7,
          embedding_records_processed: 2,
        }),
      })
    );
  });

  it('emits null embeddings for null source values without calling the provider', async () => {
    const input = Readable.from([
      `${JSON.stringify(baseSchemaMessage)}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:00.000Z',
        record: { id: 1, body: null },
      })}\n`,
    ]);
    const output = createWritableBuffer();
    const embedFn = vi.fn(async () => ({
      vectors: [],
      tokensUsed: 0,
    }));

    await runEmbedder({
      input,
      output: output.stream,
      errorOutput: createWritableBuffer().stream,
      config: {
        streams: {
          docs: [{ field: 'body' }],
        },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn,
    });

    const record = parseLines(output.chunks).find((message) => message['type'] === 'RECORD');
    expect(record?.['record']).toMatchObject({
      id: 1,
      body: null,
      body_embedding: null,
    });
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('flushes sparse records immediately so they do not accumulate behind pending embeddings', async () => {
    const input = Readable.from([
      `${JSON.stringify(baseSchemaMessage)}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:00.000Z',
        record: { id: 1, body: 'hello' },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:01.000Z',
        record: { id: 2, body: null },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:02.000Z',
        record: { id: 3, body: null },
      })}\n`,
    ]);
    const output = createWritableBuffer();
    const errorOutput = createWritableBuffer();
    const embedFn = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => [1, 2]),
      tokensUsed: texts.length,
    }));

    await runEmbedder({
      input,
      output: output.stream,
      errorOutput: errorOutput.stream,
      config: {
        streams: {
          docs: [{ field: 'body' }],
        },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn,
    });

    const records = parseLines(output.chunks).filter((message) => message['type'] === 'RECORD');
    expect(records).toHaveLength(3);
    expect(records[0]?.['record']).toMatchObject({
      id: 1,
      body: 'hello',
      body_embedding: [1, 2],
    });
    expect(records[1]?.['record']).toMatchObject({
      id: 2,
      body: null,
      body_embedding: null,
    });
    expect(records[2]?.['record']).toMatchObject({
      id: 3,
      body: null,
      body_embedding: null,
    });
    expect(embedFn).toHaveBeenCalledTimes(1);

    const metric = parseLines(errorOutput.chunks).find((message) => message['type'] === 'METRIC');
    expect(metric).toMatchObject({
      stream: 'docs',
      metrics: expect.objectContaining({
        embedding_records_processed: 3,
      }),
    });
  });

  it('logs the first truncation per stream and field', async () => {
    const huge = 'word '.repeat(20_000);
    const input = Readable.from([
      `${JSON.stringify(baseSchemaMessage)}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:00.000Z',
        record: { id: 1, body: huge },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:01.000Z',
        record: { id: 2, body: huge },
      })}\n`,
    ]);
    const errorOutput = createWritableBuffer();

    await runEmbedder({
      input,
      output: createWritableBuffer().stream,
      errorOutput: errorOutput.stream,
      config: {
        streams: {
          docs: [{ field: 'body' }],
        },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn: async (texts: string[]) => ({
        vectors: texts.map(() => [0, 0]),
        tokensUsed: texts.length * 10,
      }),
    });

    const stderrMessages = parseLines(errorOutput.chunks);
    const truncationLogs = stderrMessages.filter(
      (message) => message['type'] === 'LOG' && String(message['message']).includes('Truncating')
    );
    const metric = stderrMessages.find((message) => message['type'] === 'METRIC');
    expect(truncationLogs).toHaveLength(1);
    expect(metric).toMatchObject({
      stream: 'docs',
      metrics: expect.objectContaining({
        embedding_tokens_truncated: 2,
      }),
    });
  });

  it('rejects records that require more embeddings than the configured batch size', async () => {
    const input = Readable.from([
      `${JSON.stringify({
        ...baseSchemaMessage,
        schema: {
          columns: [
            { name: 'id', type: 'integer', primary_key: true },
            { name: 'title', type: 'string' },
            { name: 'body', type: 'string' },
          ],
        },
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'docs',
        time_extracted: '2026-04-23T00:00:00.000Z',
        record: { id: 1, title: 'hello', body: 'world' },
      })}\n`,
    ]);
    const embedFn = vi.fn(async () => ({
      vectors: [],
      tokensUsed: 0,
    }));

    await expect(
      runEmbedder({
        input,
        output: createWritableBuffer().stream,
        errorOutput: createWritableBuffer().stream,
        config: {
          streams: {
            docs: [{ field: 'title' }, { field: 'body' }],
          },
          provider: 'openai',
          model: 'text-embedding-3-small',
        },
        dimensions: 2,
        batchSize: 1,
        embedFn,
      })
    ).rejects.toThrow(/batch-size 1 is too small/i);
    expect(embedFn).not.toHaveBeenCalled();
  });
});

describe('vectors that do not fit the column', () => {
  async function embedOne(
    vectors: unknown[],
    rejections?: ReadonlyMap<string, number>
  ): Promise<{ error: unknown; output: string[] }> {
    const output = createWritableBuffer();
    const error = await runEmbedder({
      input: Readable.from([
        `${JSON.stringify(baseSchemaMessage)}\n`,
        `${JSON.stringify({
          _v: 1,
          type: 'RECORD',
          stream: 'docs',
          time_extracted: '2026-04-23T00:00:00.000Z',
          record: { id: 1, body: 'quiet kennel' },
        })}\n`,
      ]),
      output: output.stream,
      errorOutput: createWritableBuffer().stream,
      config: {
        streams: { docs: [{ field: 'body' }] },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 3,
      batchSize: 100,
      embedFn: async () => ({ vectors: vectors as number[][], tokensUsed: 0, rejections }),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    return { error, output: output.chunks };
  }

  it.each([
    [[[1, 2]], 'returned a vector of 2 numbers for stream "docs", expected 3.'],
    [[[1, 2, 3, 4]], 'returned a vector of 4 numbers for stream "docs", expected 3.'],
    [[[]], 'returned a vector of 0 numbers for stream "docs", expected 3.'],
    [[undefined], 'returned a vector of 0 numbers for stream "docs", expected 3.'],
    [[[1, NaN, 3]], 'a value that is not a finite number for stream "docs".'],
    [[[1, Infinity, 3]], 'a value that is not a finite number for stream "docs".'],
    [[[1, '2', 3]], 'a value that is not a finite number for stream "docs".'],
  ])('refuses %j in a RECORD', async (vectors, message) => {
    const { error, output } = await embedOne(vectors);
    expect(error).toMatchObject({ exitCode: 1, message: expect.stringContaining(message) });
    expect((error as Error).message).toContain('text-embedding-3-small');
    expect((error as Error).message).not.toContain('quiet kennel');
    expect(parseLines(output).map((line) => line['type'])).toEqual(['SCHEMA']);
  });

  it.each([
    ['a null nobody reported', [null], undefined, 'left out 1 vectors', 'reported 0 refused'],
    ['a null next to no refusals', [null], new Map(), 'left out 1 vectors', 'reported 0 refused'],
    [
      'fewer nulls than refusals',
      [null],
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
      'left out 1 vectors',
      'reported 2 refused',
    ],
    [
      'a vector for a refused text',
      [[1, 2, 3]],
      new Map([['a', 1]]),
      'left out 0 vectors',
      'reported 1 refused',
    ],
  ])('refuses %s', async (_label, vectors, rejections, missing, reported) => {
    const { error, output } = await embedOne(vectors, rejections);
    expect(error).toMatchObject({ exitCode: 1 });
    expect((error as Error).message).toContain(missing);
    expect((error as Error).message).toContain(reported);
    expect((error as Error).message).not.toContain('quiet kennel');
    expect(parseLines(output).map((line) => line['type'])).toEqual(['SCHEMA']);
  });

  it('accepts a null that the provider reported', async () => {
    const { error, output } = await embedOne([null], new Map([['too_long', 1]]));
    expect(error).toBeUndefined();
    expect(parseLines(output)[1]?.['record']).toMatchObject({ body_embedding: null });
  });

  it('accepts a vector of the declared length', async () => {
    const { error, output } = await embedOne([[1, -2.5, 0]]);
    expect(error).toBeUndefined();
    expect(parseLines(output)[1]?.['record']).toMatchObject({ body_embedding: [1, -2.5, 0] });
  });
});

describe('document streams', () => {
  const row = (stream: string, values: Record<string, unknown>) => ({
    _v: 1,
    type: 'RECORD',
    stream,
    time_extracted: '2026-04-23T00:00:00.000Z',
    record: values,
  });
  const replace = (stream: string, id: string) => ({
    _v: 1,
    type: 'REPLACE',
    stream,
    key: 'document_id',
    values: [id],
  });
  const schema = (stream: string) => ({
    _v: 1,
    type: 'SCHEMA',
    stream,
    schema: {
      columns: [
        { name: 'document_id', type: 'string' },
        { name: 'text', type: 'string' },
      ],
    },
    key_properties: [],
    load_strategy: 'append',
  });

  it('embeds only the chunk stream and keeps REPLACE in its place', async () => {
    const messages = [
      schema('docs__documents'),
      schema('docs__chunks'),
      schema('docs__parse_errors'),
      schema('docs__acl'),
      ...['one', 'two'].flatMap((id) => [
        replace('docs__documents', id),
        replace('docs__chunks', id),
        replace('docs__parse_errors', id),
        replace('docs__acl', id),
        row('docs__documents', { document_id: id, text: `${id} whole` }),
        row('docs__chunks', { document_id: id, text: `${id} a` }),
        row('docs__chunks', { document_id: id, text: `${id} b` }),
      ]),
      // Nothing between these records and the REPLACE flushes them.
      row('docs__chunks', { document_id: 'two', text: 'two c' }),
      replace('docs__chunks', 'three'),
      row('docs__acl', { document_id: 'two', text: 'reader' }),
      row('docs__parse_errors', { document_id: 'two', text: 'unreadable' }),
      { _v: 1, type: 'STATE', stream: 'docs', value: { record_count: 5 } },
    ];
    const output = createWritableBuffer();
    const embedFn = vi.fn(async (texts: string[]) => ({
      vectors: texts.map((text) => [text.length, 0]),
      tokensUsed: 0,
    }));
    await runEmbedder({
      input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
      output: output.stream,
      errorOutput: createWritableBuffer().stream,
      config: {
        streams: { docs__chunks: [{ field: 'text' }] },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn,
    });

    const written = parseLines(output.chunks);
    const withoutVectors = written.map((message) => {
      if (message['type'] === 'SCHEMA' && message['stream'] === 'docs__chunks') {
        return schema('docs__chunks');
      }
      if (message['type'] !== 'RECORD' || message['stream'] !== 'docs__chunks') return message;
      const { text_embedding: vector, ...rest } = message['record'] as Record<string, unknown>;
      expect(vector).toEqual([String(rest['text']).length, 0]);
      return { ...message, record: rest };
    });
    expect(withoutVectors).toEqual(messages);
    expect(embedFn.mock.calls.flatMap(([texts]) => texts)).toEqual([
      'one a',
      'one b',
      'two a',
      'two b',
      'two c',
    ]);
  });
});

describe('refused inputs', () => {
  it('reports any code as a plain key', async () => {
    const errorOutput = createWritableBuffer();
    const codes = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
    await runEmbedder({
      input: Readable.from([
        `${JSON.stringify(baseSchemaMessage)}\n`,
        ...Array.from(
          { length: 10 },
          (_, id) =>
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'docs',
              time_extracted: '2026-04-23T00:00:00.000Z',
              record: { id, body: 'hello' },
            })}\n`
        ),
      ]),
      output: createWritableBuffer().stream,
      errorOutput: errorOutput.stream,
      config: {
        streams: { docs: [{ field: 'body' }] },
        provider: 'acme',
        model: 'acme-embed-1',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn: async (texts) => ({
        vectors: texts.map(() => null),
        tokensUsed: 0,
        rejections: new Map(codes.map((code, index) => [code, index + 1])),
      }),
    });

    const line = errorOutput.chunks
      .join('')
      .split('\n')
      .find((text) => text.includes('embedding.inputs_rejected'))!;
    expect(line).toContain('"__proto__":2');
    const { counts } = (JSON.parse(line) as { attributes: { counts: object } }).attributes;
    expect(Object.entries(counts)).toEqual([
      ['hasOwnProperty', 4],
      ['toString', 3],
      ['__proto__', 2],
      ['constructor', 1],
    ]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe('whitespace', () => {
  it('is embedded unless a host supplies the model', async () => {
    const run = async (hostText?: { maxCharacters?: number }) => {
      const embedFn = vi.fn(async (texts: string[]) => ({
        vectors: texts.map(() => [0, 0]),
        tokensUsed: 0,
      }));
      await runEmbedder({
        input: Readable.from([
          `${JSON.stringify(baseSchemaMessage)}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'docs',
            time_extracted: '2026-04-23T00:00:00.000Z',
            record: { id: 1, body: ' \n ' },
          })}\n`,
        ]),
        output: createWritableBuffer().stream,
        errorOutput: createWritableBuffer().stream,
        config: {
          streams: { docs: [{ field: 'body' }] },
          provider: 'openai',
          model: 'text-embedding-3-small',
        },
        dimensions: 2,
        batchSize: 100,
        hostText,
        embedFn,
      });
      return embedFn.mock.calls;
    };
    expect(await run()).toEqual([[[' \n ']]]);
    expect(await run({})).toEqual([]);
  });
});

describe('input that is not JSON', () => {
  it('is reported by line, without the line', async () => {
    const started = runEmbedder({
      input: Readable.from([
        `${JSON.stringify(baseSchemaMessage)}\n\n`,
        '{"_v":1,"type":"RECORD","record":{"body":"quiet kennel"\n',
      ]),
      output: createWritableBuffer().stream,
      errorOutput: createWritableBuffer().stream,
      config: {
        streams: { docs: [{ field: 'body' }] },
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      dimensions: 2,
      batchSize: 100,
      embedFn: async () => ({ vectors: [], tokensUsed: 0 }),
    });
    await expect(started).rejects.toMatchObject({
      message: 'Protocol line 3 is not valid JSON.',
      exitCode: 1,
    });
  });

  it('leaves other reader errors as they are', async () => {
    const started = runEmbedder({
      input: Readable.from(['{"_v":1,"type":"NOPE"}\n']),
      output: createWritableBuffer().stream,
      errorOutput: createWritableBuffer().stream,
      config: { streams: {}, provider: 'openai', model: 'text-embedding-3-small' },
      dimensions: 2,
      batchSize: 100,
      embedFn: async () => ({ vectors: [], tokensUsed: 0 }),
    });
    await expect(started).rejects.toThrow(/Invalid protocol message on line 1/);
  });
});
