import { embed, generateText, jsonSchema, streamText, tool } from 'ai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveProviderModels } from '../src/providers.js';

const baseURL = 'https://ollama.example.test/api';
const connection = { provider: 'ollama' as const, model: 'example-model', base_url: baseURL };

afterEach(() => vi.unstubAllGlobals());

describe('Ollama provider compatibility', () => {
  it.each([baseURL, `${baseURL}/`])('generates text using native base URL %s', async (url) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: connection.model,
        created_at: '2026-01-01T00:00:00Z',
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content: 'hello' },
        prompt_eval_count: 2,
        eval_count: 1,
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await resolveProviderModels({ ...connection, base_url: url });
    const result = await generateText({
      model: models.languageModel as LanguageModel,
      prompt: 'Hi',
      maxRetries: 0,
    });
    expect(result.text).toBe('hello');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${baseURL}/chat`);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ model: connection.model, stream: false });
  });

  it('streams native NDJSON text through the current AI SDK', async () => {
    const rows = [
      { done: false, message: { role: 'assistant', content: 'hel' } },
      { done: false, message: { role: 'assistant', content: 'lo' } },
      {
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content: '' },
        prompt_eval_count: 2,
        eval_count: 1,
      },
    ].map((row) => ({ model: connection.model, created_at: '2026-01-01T00:00:00Z', ...row }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', {
            headers: { 'content-type': 'application/x-ndjson' },
          })
      )
    );
    const models = await resolveProviderModels(connection);
    const result = streamText({
      model: models.languageModel as LanguageModel,
      prompt: 'Hi',
      maxRetries: 0,
    });
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('hello');
  });

  it('preserves tool calls through the current AI SDK interface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          model: connection.model,
          created_at: '2026-01-01T00:00:00Z',
          done: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'lookup', arguments: { id: 'item' } } }],
          },
        })
      )
    );
    const models = await resolveProviderModels(connection);
    const result = await generateText({
      model: models.languageModel as LanguageModel,
      prompt: 'Look up item',
      maxRetries: 0,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema<{ id: string }>({
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          }),
        }),
      },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'lookup', input: { id: 'item' } });
  });

  it('creates embeddings through the existing native endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: connection.model,
        embeddings: [[0.1, 0.2]],
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: 2,
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await resolveProviderModels(connection);
    const result = await embed({
      model: models.embeddingModel as EmbeddingModel,
      value: 'hello',
      maxRetries: 0,
    });
    expect(result.embedding).toEqual([0.1, 0.2]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${baseURL}/embed`);
  });
});
