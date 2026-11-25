import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { connectHostEmbedding } from '../src/index.js';

/** The JSON examples of the contract, in the order of the page. */
const [requestExample, firstResponse, laterResponse] = [
  ...readFileSync(
    new URL('../../../docs/reference/host-embeddings.md', import.meta.url),
    'utf8'
  ).matchAll(/```json\n([\s\S]*?)```/g),
].map(([, json]) => JSON.parse(json!) as Record<string, unknown>);

describe('the documented examples of host embeddings', () => {
  it('are what the client sends and accepts', async () => {
    const bodies: unknown[] = [];
    const answers = [firstResponse, laterResponse];
    const connection = await connectHostEmbedding({
      url: 'https://host.example/embed',
      token: 'synthetic-host-token',
      fetch: vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(answers.shift());
      }),
    });
    const inputs = requestExample!['inputs'] as Array<{ text: string }>;
    const result = await connection.embed(inputs.map(({ text }) => text));

    expect(bodies).toEqual([{ ...requestExample, inputs: [] }, requestExample]);
    expect(connection.model).toEqual(firstResponse!['model']);
    expect(connection.limits).toEqual(firstResponse!['limits']);
    expect(result).toEqual({
      vectors: [[0.12, -0.03]],
      rejections: new Map(),
      tokensUsed: 7,
      requests: 1,
    });
  });
});
