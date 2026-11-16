import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateStructured } from '../src/generate.js';
import { generateStream } from '../src/stream.js';

const refusal = 'Synthetic refusal.';
const prompt = 'Return a synthetic record.';
const schema = z.object({ ok: z.boolean() });
const connection = { provider: 'openai' as const, model: 'gpt-4o-mini' };
const responsesPayload = {
  id: 'resp_synthetic',
  object: 'response',
  created_at: 0,
  model: connection.model,
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_synthetic',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'refusal', refusal }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

describe('provider compatibility through the shared AI boundary', () => {
  it('preserves an OpenAI Responses refusal as a schema violation with measured usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(responsesPayload));
    const provider = createOpenAI({
      apiKey: 'example-invalid',
      baseURL: 'https://provider.example.test/v1',
      fetch: fetchMock,
    });
    const result = await generateStructured(
      connection,
      { schema, prompt, maxRetries: 0 },
      { modelOverride: provider.responses(connection.model), costBudgetMode: 'observe' }
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'schema_violation',
      raw: refusal,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams Chat Completions refusals through the ordinary text event contract', async () => {
    const chunks = [
      {
        id: 'chatcmpl_synthetic',
        created: 0,
        model: connection.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', refusal },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_synthetic',
        created: 0,
        model: connection.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    ];
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
    );
    const provider = createOpenAI({
      apiKey: 'example-invalid',
      baseURL: 'https://provider.example.test/v1',
      fetch: fetchMock,
    });
    const events = [];
    for await (const event of generateStream(connection, {
      prompt,
      modelOverride: provider.chat(connection.model),
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'delta', text: refusal }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts an ordinary Google schema and reports oversized schemas before HTTP', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: '{"ok":true}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        modelVersion: 'example-model',
        responseId: 'synthetic',
      })
    );
    const provider = createGoogleGenerativeAI({
      apiKey: 'example-invalid',
      baseURL: 'https://provider.example.test/google',
      fetch: fetchMock,
    });
    const googleConnection = { provider: 'google' as const, model: 'gemini-2.5-flash' };
    const runOptions = {
      modelOverride: provider(googleConnection.model),
      costBudgetMode: 'observe' as const,
    };

    expect(
      await generateStructured(googleConnection, { schema, prompt, maxRetries: 0 }, runOptions)
    ).toMatchObject({ ok: true, value: { ok: true } });

    const oversizedSchema = z.object(
      Object.fromEntries(
        Array.from({ length: 6000 }, (_, index) => [
          `field_${index}`,
          z.string().describe('Synthetic field.'),
        ])
      )
    );
    expect(
      await generateStructured(
        googleConnection,
        { schema: oversizedSchema, prompt, maxRetries: 0 },
        runOptions
      )
    ).toMatchObject({
      ok: false,
      error: 'provider_error',
      message: expect.stringContaining('schema conversion exceeded'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
