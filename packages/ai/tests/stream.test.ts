import { streamText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { MemoryBudgetLedger } from '../src/budget.js';
import { generateStream } from '../src/stream.js';

vi.mock('ai', () => ({ streamText: vi.fn() }));

const connection = { provider: 'openai' as const, model: 'gpt-4o-mini' };

async function interrupted(usage: Promise<unknown>) {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () {
      yield 'first';
      yield 'second';
    })(),
    usage,
  } as unknown as ReturnType<typeof streamText>);
  const ledger = new MemoryBudgetLedger();
  for await (const event of generateStream(connection, {
    prompt: 'hello',
    modelOverride: {},
    ledger,
    projectKey: 'acme',
    platform: { budget: { ai_cost_daily_usd: 0.003 } },
  })) {
    expect(event.type).toBe('delta');
    break;
  }
  return (await ledger.tryReserveCost('acme', new Date().toISOString().slice(0, 10), 0, 1)).usage
    .costUsd;
}

describe('interrupted stream accounting', () => {
  it('charges measured usage when the consumer stops after a delta', async () => {
    expect(
      await interrupted(Promise.resolve({ inputTokens: 1000, outputTokens: 2500 }))
    ).toBeCloseTo(0.00165, 8);
  });
  it('keeps the estimate when only part of the usage is reported', async () => {
    expect(await interrupted(Promise.resolve({ outputTokens: 0 }))).toBeGreaterThan(0);
  });
  it.each(['pending', 'rejected', 'missing'])(
    'keeps the estimate when usage is %s',
    async (kind) => {
      const usage =
        kind === 'pending'
          ? new Promise(() => {})
          : kind === 'rejected'
            ? Promise.reject(new Error('no usage'))
            : Promise.resolve(undefined);
      expect(await interrupted(usage)).toBeGreaterThan(0);
    }
  );
});
