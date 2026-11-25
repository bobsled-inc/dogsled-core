import { afterEach, describe, expect, it, vi } from 'vitest';

import { embedMany, type ModelConnection } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

/** Answers every embedding API used here; the AI SDK reads the part it knows. */
function embeddingResponse(count: number): Response {
  const vectors = Array.from({ length: count }, () => [0.1, 0.2]);
  return Response.json({
    object: 'list',
    model: 'example',
    data: vectors.map((embedding, index) => ({ object: 'embedding', embedding, index })),
    embedding: vectors[0],
    inputTextTokenCount: 1,
    embeddings: vectors,
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

function googleResponse(url: string, count: number): Response {
  const values = [0.1, 0.2];
  return Response.json(
    url.includes(':batchEmbedContents')
      ? { embeddings: Array.from({ length: count }, () => ({ values })) }
      : { embedding: { values } }
  );
}

/** The bodies the bundled provider package sends for two inputs. */
async function sentBodies(connection: ModelConnection): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return connection.provider === 'google'
        ? googleResponse(String(input), 2)
        : embeddingResponse(connection.provider === 'amazon-bedrock' ? 1 : 2);
    })
  );
  for await (const result of embedMany(connection, [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'beta' },
  ])) {
    expect(result).toMatchObject({ ok: true });
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies;
}

const key = { api_key: 'test-key' };

describe('the configured dimension', () => {
  it.each<[ModelConnection, Record<string, unknown>]>([
    [
      { provider: 'openai', model: 'text-embedding-3-small', dimension: 512, ...key },
      { dimensions: 512 },
    ],
    [
      { provider: 'openai', model: 'text-embedding-3-large', dimension: 1024, ...key },
      { dimensions: 1024 },
    ],
    [
      {
        provider: 'amazon-bedrock',
        model: 'amazon.titan-embed-text-v2:0',
        region: 'us-east-1',
        dimension: 256,
        ...key,
      },
      { dimensions: 256 },
    ],
    [
      {
        provider: 'ollama',
        model: 'example-embed',
        base_url: 'http://127.0.0.1:11434/api',
        dimension: 384,
      },
      { dimensions: 384 },
    ],
  ])('is sent to $provider $model', async (connection, expected) => {
    for (const body of await sentBodies(connection)) expect(body).toMatchObject(expected);
  });

  it('is sent to Google as outputDimensionality', async () => {
    const [body] = await sentBodies({
      provider: 'google',
      model: 'gemini-embedding-001',
      dimension: 768,
      ...key,
    });
    expect(body!['requests']).toEqual([
      expect.objectContaining({ outputDimensionality: 768 }),
      expect.objectContaining({ outputDimensionality: 768 }),
    ]);
  });

  it('is sent to Cohere embed v4 on Bedrock as output_dimension', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ embeddings: { float: [[0.1, 0.2]] } });
      })
    );
    for await (const result of embedMany(
      {
        provider: 'amazon-bedrock',
        model: 'us.cohere.embed-v4:0',
        region: 'us-east-1',
        dimension: 1024,
        ...key,
      },
      [{ id: 'a', text: 'alpha' }]
    )) {
      expect(result).toMatchObject({ ok: true });
    }
    expect(bodies).toEqual([expect.objectContaining({ output_dimension: 1024 })]);
  });

  it.each<ModelConnection>([
    { provider: 'openai', model: 'text-embedding-ada-002', dimension: 1536, ...key },
    { provider: 'openrouter', model: 'example/embed', dimension: 256, ...key },
    { provider: 'google', model: 'text-embedding-004', dimension: 256, ...key },
    {
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v1',
      region: 'us-east-1',
      dimension: 1536,
      ...key,
    },
  ])('is not sent to $provider $model', async (connection) => {
    const bodies = JSON.stringify(await sentBodies(connection));
    expect(bodies).not.toMatch(/dimension/i);
  });

  it.each<ModelConnection>([
    { provider: 'openai', model: 'text-embedding-3-small', ...key },
    { provider: 'google', model: 'gemini-embedding-001', ...key },
    {
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      ...key,
    },
    { provider: 'ollama', model: 'example-embed', base_url: 'http://127.0.0.1:11434/api' },
  ])('is not made up for $provider $model', async (connection) => {
    const bodies = JSON.stringify(await sentBodies(connection));
    expect(bodies).not.toMatch(/dimension/i);
  });
});
