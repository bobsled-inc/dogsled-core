import { describe, expect, it, vi } from 'vitest';
import {
  AgentExecutorRequestSchema,
  AgenticUsageSchema,
  agenticChargeableTokens,
  isBoundedAgenticJson,
} from '../../../src/agentic/index.js';
import { assignment } from './fixtures.js';

describe('executor contract', () => {
  const runtime = () => ({
    signal: new AbortController().signal,
    budget: { reserve: vi.fn(), settle: vi.fn() },
  });

  it('requires cancellation and forbids any callback field on a direct call', () => {
    expect(
      AgentExecutorRequestSchema.safeParse({ assignment: assignment(), ...runtime() }).success
    ).toBe(true);
    expect(
      AgentExecutorRequestSchema.safeParse({
        assignment: assignment(),
        ...runtime(),
        sources: vi.fn(),
      }).success
    ).toBe(false);
    expect(
      AgentExecutorRequestSchema.safeParse({
        assignment: assignment(),
        ...runtime(),
        signal: undefined,
      }).success
    ).toBe(false);
  });

  it('requires a source callback for an agent loop without granting extra sources', () => {
    const work = { ...assignment(), mode: 'agent_loop', allowed_sources: ['web'] };
    expect(AgentExecutorRequestSchema.safeParse({ assignment: work, ...runtime() }).success).toBe(
      false
    );
    expect(
      AgentExecutorRequestSchema.safeParse({ assignment: work, ...runtime(), sources: vi.fn() })
        .success
    ).toBe(true);
  });

  it('charges unknown usage conservatively and rejects inconsistent totals', () => {
    const reservation = { id: 'call-1', attempt_id: 'attempt-1', tokens: 100 };
    expect(agenticChargeableTokens(reservation, { status: 'unknown', reason: 'interrupted' })).toBe(
      100
    );
    expect(
      agenticChargeableTokens(reservation, {
        status: 'measured',
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
      })
    ).toBe(30);
    expect(
      AgenticUsageSchema.safeParse({
        status: 'measured',
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 10,
      }).success
    ).toBe(false);
  });

  it('bounds JSON depth, bytes and non-JSON values, while allowing shared values', () => {
    let deep: unknown = null;
    for (let i = 0; i < 18; i++) deep = { next: deep };
    const cycle: Record<string, unknown> = {};
    cycle['next'] = cycle;
    for (const value of [
      deep,
      cycle,
      'x'.repeat(1048577),
      NaN,
      Infinity,
      new Date(),
      { missing: undefined },
    ]) {
      expect(isBoundedAgenticJson(value)).toBe(false);
    }
    const shared = { value: 1 };
    expect(isBoundedAgenticJson([shared, shared])).toBe(true);
  });
});

it('does not let array properties replace missing JSON elements', () => {
  const sparse = new Array(1);
  Object.assign(sparse, { label: 'value' });
  expect(isBoundedAgenticJson(sparse)).toBe(false);
});
