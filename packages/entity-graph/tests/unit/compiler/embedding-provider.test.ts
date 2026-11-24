import { expect, it, vi } from 'vitest';

import { createSemanticEmbeddingProvider } from '../../../src/compiler/identity/embeddings/provider.js';

it('refuses redirects when it requests embeddings', async () => {
  const dimensions = 1536;
  const fetchFn = vi.fn<typeof fetch>(async () =>
    Response.json({
      data: [{ index: 0, embedding: new Array<number>(dimensions).fill(0) }],
      usage: { total_tokens: 1 },
    })
  );
  const provider = await createSemanticEmbeddingProvider({
    triage: { provider: 'openai', dimensions },
    env: { OPENAI_API_KEY: 'test-key' },
    fetchFn,
  });

  await provider.embed(['example']);

  expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe('error');
});
