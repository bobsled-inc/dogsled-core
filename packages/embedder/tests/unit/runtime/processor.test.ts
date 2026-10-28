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
      embedded_from: { column: 'body', provider, model },
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
      embedded_from: { column: 'body', provider, model },
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
      embedded_from: { column: 'title', provider, model },
    });
    expect(enriched.schema.columns).toContainEqual({
      name: 'body_vec',
      type: 'vector',
      dimension: 1536,
      embedded_from: { column: 'body', provider, model },
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
