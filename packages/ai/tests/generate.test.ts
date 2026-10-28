import { generateObject } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateStructured } from '../src/generate.js';
import type { ModelConnection } from '../src/types.js';

vi.mock('ai', () => ({ generateObject: vi.fn() }));
vi.mock('../src/providers.js', () => ({
  resolveProviderModels: vi.fn(async () => ({ languageModel: 'mock-model' })),
}));

const connection: ModelConnection = { provider: 'openai', model: 'gpt-4o-mini' };
const options = { schema: z.object({ answer: z.string() }), prompt: 'Reply.' };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
function respond(reportedUsage: unknown = usage): void {
  vi.mocked(generateObject).mockResolvedValue({
    object: { answer: 'Yes' },
    usage: reportedUsage,
  } as Awaited<ReturnType<typeof generateObject>>);
}

beforeEach(() => {
  vi.mocked(generateObject).mockReset();
});

describe('bounded structured generation', () => {
  it('forwards cancellation, output limits and zero retries without wrapper retries', async () => {
    const controller = new AbortController();
    vi.mocked(generateObject).mockImplementation(async (opts) => {
      expect(opts.abortSignal).toBe(controller.signal);
      expect(opts.maxOutputTokens).toBe(50);
      expect(opts.maxRetries).toBe(0);
      controller.abort();
      opts.abortSignal?.throwIfAborted();
      throw new Error('unreachable');
    });
    const result = await generateStructured(connection, {
      ...options,
      abortSignal: controller.signal,
      maxOutputTokens: 50,
      maxRetries: 0,
    });
    expect(result).toMatchObject({ ok: false, error: 'provider_error' });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('does not call the SDK when already cancelled', async () => {
    const signal = AbortSignal.abort();
    expect(await generateStructured(connection, { ...options, abortSignal: signal })).toMatchObject(
      { ok: false }
    );
    expect(generateObject).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects output limit %s',
    async (limit) => {
      expect(
        await generateStructured(connection, { ...options, maxOutputTokens: limit })
      ).toMatchObject({ ok: false });
      expect(generateObject).not.toHaveBeenCalled();
    }
  );

  it.each([-1, 0.5, NaN, Infinity])('rejects retry limit %s', async (limit) => {
    expect(await generateStructured(connection, { ...options, maxRetries: limit })).toMatchObject({
      ok: false,
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('reports measured counts and preserves the legacy total', async () => {
    respond();
    expect(await generateStructured(connection, options)).toMatchObject({
      ok: true,
      usage,
      tokenUsage: 15,
    });
  });

  it('derives a missing total only from both measured counts', async () => {
    respond({ inputTokens: 10, outputTokens: 5 });
    expect(await generateStructured(connection, options)).toMatchObject({ usage });
  });

  it.each([
    null,
    {},
    { totalTokens: 15 },
    { inputTokens: 10 },
    { inputTokens: -1, outputTokens: 5 },
    { ...usage, totalTokens: 99 },
  ])('keeps incomplete or invalid usage unknown: %j', async (reported) => {
    respond(reported);
    expect(await generateStructured(connection, options)).not.toHaveProperty('usage');
  });

  it('preserves measured usage and raw output on schema failures', async () => {
    vi.mocked(generateObject).mockRejectedValue(
      Object.assign(new Error('Bad shape'), {
        name: 'AI_NoObjectGeneratedError',
        text: '{bad}',
        usage,
      })
    );
    expect(await generateStructured(connection, options)).toMatchObject({
      ok: false,
      error: 'schema_violation',
      raw: '{bad}',
      usage,
    });
  });

  it('keeps schema failure usage unknown when not reported', async () => {
    vi.mocked(generateObject).mockRejectedValue(
      Object.assign(new Error('Bad shape'), {
        name: 'AI_NoObjectGeneratedError',
      })
    );
    expect(await generateStructured(connection, options)).not.toHaveProperty('usage');
  });

  it('keeps cost ceilings by default and explicitly permits observation only', async () => {
    respond();
    const budgeted = { ...connection, cost_budget_usd: 0 };
    expect(await generateStructured(budgeted, options)).toMatchObject({
      ok: false,
      error: 'budget_exceeded',
    });
    expect(generateObject).not.toHaveBeenCalled();
    expect(
      await generateStructured(budgeted, options, {
        costBudgetMode: 'observe',
        platform: { budget: { ai_cost_daily_usd: 0 } },
      })
    ).toMatchObject({ ok: true, usage });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });
});
