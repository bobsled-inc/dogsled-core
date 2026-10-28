import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBoundedOpenRouterFetch,
  OPENROUTER_MAX_RESPONSE_BYTES,
} from '../src/openrouter-fetch.js';
import { resolveProviderModels } from '../src/providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter vendored response-size mitigation', () => {
  it.each([200, 400])('rejects oversized declared response size at status %s', async (status) => {
    const cancel = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), { status, headers: { 'content-length': '9' } })
    );
    await expect(
      createBoundedOpenRouterFetch(fetchImplementation, 8)('https://provider.example.test')
    ).rejects.toThrow('maximum size');
    expect(cancel).toHaveBeenCalled();
  });

  it.each([200, 400])(
    'bounds actual body bytes without trusting content-length at status %s',
    async (status) => {
      const fetchImplementation = vi.fn<typeof fetch>(
        async () => new Response('123456789', { status })
      );
      const response = await createBoundedOpenRouterFetch(
        fetchImplementation,
        8
      )('https://provider.example.test');
      await expect(response.text()).rejects.toThrow('maximum size');
    }
  );

  it('bounds accumulated streaming data and cancels the upstream reader', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
      },
      cancel,
    });
    const response = await createBoundedOpenRouterFetch(
      async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      8
    )('https://provider.example.test');
    await expect(response.text()).rejects.toThrow('maximum size');
    expect(cancel).toHaveBeenCalled();
  });

  it('preserves a small successful response', async () => {
    const response = await createBoundedOpenRouterFetch(
      async () => Response.json({ ok: true }),
      100
    )('https://provider.example.test');
    expect(await response.json()).toEqual({ ok: true });
    expect(response.status).toBe(200);
  });

  it('passes the mitigation to the real OpenRouter provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response('{}', {
            headers: { 'content-length': String(OPENROUTER_MAX_RESPONSE_BYTES + 1) },
          })
      )
    );
    const models = await resolveProviderModels({
      provider: 'openrouter',
      model: 'example/model',
      api_key: 'test-key',
    });
    await expect(
      generateText({ model: models.languageModel as LanguageModel, prompt: 'Hi', maxRetries: 0 })
    ).rejects.toThrow('maximum size');
  });
  it('resolves global fetch when called after the provider and model are created', async () => {
    const earlierFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Earlier fetch must not be used');
    });
    vi.stubGlobal('fetch', earlierFetch);
    const models = await resolveProviderModels({
      provider: 'openrouter',
      model: 'example/model',
      api_key: 'test-key',
    });
    const model = models.languageModel as LanguageModel;
    const laterFetch = vi.fn<typeof fetch>(
      async () =>
        new Response('{}', {
          headers: { 'content-length': String(OPENROUTER_MAX_RESPONSE_BYTES + 1) },
        })
    );
    vi.stubGlobal('fetch', laterFetch);
    await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
      'maximum size'
    );
    expect(laterFetch).toHaveBeenCalledTimes(1);
    expect(earlierFetch).not.toHaveBeenCalled();
  });

  it('preserves an explicit injected fetch when global fetch changes', async () => {
    const injectedFetch = vi.fn<typeof fetch>(async () => new Response('injected'));
    const boundedFetch = createBoundedOpenRouterFetch(injectedFetch, 100);
    const laterFetch = vi.fn<typeof fetch>(async () => new Response('global'));
    vi.stubGlobal('fetch', laterFetch);
    expect(await (await boundedFetch('https://provider.example.test')).text()).toBe('injected');
    expect(injectedFetch).toHaveBeenCalledTimes(1);
    expect(laterFetch).not.toHaveBeenCalled();
  });
});
