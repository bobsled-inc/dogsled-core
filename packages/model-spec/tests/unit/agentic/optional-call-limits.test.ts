import { expect, it, vi } from 'vitest';
import { AgentAssignmentSchema } from '../../../src/agentic/assignment.js';
import { createAssignmentBudget } from '../../../src/agentic/call-budget.js';
import { createAssignmentSourceAccess } from '../../../src/agentic/source-access.js';
import { assignment } from './fixtures.js';

function work(limits: Record<string, unknown> = {}) {
  return AgentAssignmentSchema.parse({
    ...assignment(),
    mode: 'agent_loop',
    allowed_sources: ['pairs'],
    limits: { ...assignment().limits, tokens: null, deadline_at: null, ...limits },
  });
}
const usage = { status: 'measured' as const, input_tokens: 1, output_tokens: 1, total_tokens: 2 };

it('allows more than the former call cap and records measured usage', async () => {
  const access = createAssignmentBudget(work(), new AbortController().signal);
  for (let index = 0; index < 1030; index++) {
    const receipt = await access.budget.reserve(null);
    await access.budget.settle(receipt, usage);
  }
  expect(access.charged()).toBe(2060);
  expect(access.valid()).toBe(true);
});

it('enforces a configured model call count before the next reservation', async () => {
  const access = createAssignmentBudget(work({ model_calls: 2 }), new AbortController().signal);
  for (let index = 0; index < 2; index++) {
    await access.budget.settle(await access.budget.reserve(null), usage);
  }
  await expect(access.budget.reserve(null)).rejects.toThrow('limit');
  expect(access.charged()).toBe(4);
});

it('does not let an unlimited reservation bypass a finite assignment budget', async () => {
  const access = createAssignmentBudget(work({ tokens: 5 }), new AbortController().signal);
  await expect(access.budget.reserve(null)).rejects.toThrow('limit');
});

it('keeps cancellation active without limits', async () => {
  const controller = new AbortController();
  const access = createAssignmentBudget(work(), controller.signal);
  controller.abort();
  await expect(access.budget.reserve(null)).rejects.toThrow();
});

it.each([undefined, null, 2])('enforces only configured source tool counts (%s)', async (limit) => {
  const host = vi.fn(async () => []);
  const access = createAssignmentSourceAccess(
    work(limit === undefined ? {} : { tool_calls: limit }),
    new AbortController().signal,
    host
  );
  const request = { source: 'pairs', operation: 'read', arguments: {} };
  await access.sources(request);
  await access.sources(request);
  if (limit === 2) {
    await expect(access.sources(request)).rejects.toThrow();
    expect(host).toHaveBeenCalledTimes(2);
  } else {
    for (let i = 0; i < 20; i++) await access.sources(request);
    expect(host).toHaveBeenCalledTimes(22);
  }
  await access.close();
});
