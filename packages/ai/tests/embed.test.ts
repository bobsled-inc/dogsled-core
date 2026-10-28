import { beforeEach, describe, expect, it, vi } from 'vitest';

import { embedMany } from '../src/index.js';

vi.mock('ai', () => ({
  embedMany: vi.fn(),
}));

vi.mock('../src/providers.js', () => ({
  resolveProviderModels: vi.fn(async () => ({ embeddingModel: 'mock-model' })),
}));

describe('embedMany', () => {
  beforeEach(async () => {
    const ai = await import('ai');
    vi.mocked(ai.embedMany).mockReset();
  });

  it('yields one ok result per embedding', async () => {
    const ai = await import('ai');
    vi.mocked(ai.embedMany).mockResolvedValue({
      embeddings: [[0.1], [0.2]],
      usage: { totalTokens: 12 },
    } as Awaited<ReturnType<typeof ai.embedMany>>);

    const results = [];
    for await (const result of embedMany(
      {
        provider: 'amazon-bedrock',
        model: 'amazon.titan-embed-text-v2:0',
        region: 'us-east-1',
      },
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ]
    )) {
      results.push(result);
    }

    expect(results).toMatchObject([
      { ok: true, id: 'a', vector: [0.1], tokenUsage: 6 },
      { ok: true, id: 'b', vector: [0.2], tokenUsage: 6 },
    ]);
    expect(results[0]?.ok && results[0].costUsd).toBeCloseTo(1.2e-7);
    expect(results[1]?.ok && results[1].costUsd).toBeCloseTo(1.2e-7);
  });

  it('turns provider batch failures into per-input errors', async () => {
    const ai = await import('ai');
    vi.mocked(ai.embedMany).mockRejectedValue(new Error('provider unavailable'));

    const results = [];
    for await (const result of embedMany(
      {
        provider: 'amazon-bedrock',
        model: 'amazon.titan-embed-text-v2:0',
        region: 'us-east-1',
      },
      [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ]
    )) {
      results.push(result);
    }

    expect(results).toEqual([
      {
        ok: false,
        id: 'a',
        error: 'provider_error',
        message: 'provider unavailable',
        retriable: true,
      },
      {
        ok: false,
        id: 'b',
        error: 'provider_error',
        message: 'provider unavailable',
        retriable: true,
      },
    ]);
  });

  it('rejects invalid chunk sizes before chunking', async () => {
    await expect(async () => {
      for await (const _result of embedMany(
        {
          provider: 'amazon-bedrock',
          model: 'amazon.titan-embed-text-v2:0',
          region: 'us-east-1',
        },
        [{ id: 'a', text: 'A' }],
        { chunkSize: 0 }
      )) {
        // drain
      }
    }).rejects.toThrow('chunkSize must be a positive integer');
  });
});
