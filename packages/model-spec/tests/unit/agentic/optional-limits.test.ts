import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgenticModelSpecSchema, executeAgenticRun } from '../../../src/agentic/index.js';
import { assignmentLimits } from '../../../src/agentic/limits.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

const usage = {
  status: 'measured' as const,
  input_tokens: 400,
  output_tokens: 200,
  total_tokens: 600,
};

describe('optional agentic limits', () => {
  it('accepts an omitted limits block without adding caps', () => {
    const { model } = runFixture(1);
    const { limits: _, ...without } = model;
    expect(AgenticModelSpecSchema.parse(without).limits).toEqual({});
  });

  it.each([
    'tokens',
    'tokens_per_assignment',
    'tool_calls_per_assignment',
    'model_calls_per_assignment',
    'timeout_seconds',
  ])('validates %s', (key) => {
    const { model } = runFixture(1);
    for (const value of [undefined, null, 1, 200]) {
      expect(AgenticModelSpecSchema.safeParse({ ...model, limits: { [key]: value } }).success).toBe(
        true
      );
    }
    for (const value of [0, -1, 1.5, Infinity, NaN, '100']) {
      expect(AgenticModelSpecSchema.safeParse({ ...model, limits: { [key]: value } }).success).toBe(
        false
      );
    }
  });

  it('inherits each field independently and respects explicit null', () => {
    const { model } = runFixture(1);
    model.limits = {
      tokens_per_assignment: 100,
      tool_calls_per_assignment: 5,
      model_calls_per_assignment: 8,
    };
    const step = model.plan.steps[0]!;
    expect(assignmentLimits(model, step)).toEqual({ tokens: 100, tool_calls: 5, model_calls: 8 });
    step.limits = { tokens_per_assignment: null, tool_calls_per_assignment: 2 };
    expect(assignmentLimits(model, step, 999)).toEqual({
      tokens: null,
      tool_calls: 2,
      model_calls: 8,
    });
  });

  it.each(['tokens', 'timeout_seconds'])('rejects shared %s as a step override', (key) => {
    const { model } = runFixture(1);
    expect(
      AgenticModelSpecSchema.safeParse({
        ...model,
        plan: { steps: [{ ...model.plan.steps[0], limits: { [key]: 10 } }] },
      }).success
    ).toBe(false);
  });

  it('runs without caps, records usage, and resumes without new calls', async () => {
    const f = runFixture(2);
    f.model.limits = {};
    delete f.host.tokensPerAssignment;
    const store = new MemoryStateStore();
    let calls = 0;
    f.host.executeAgent = async ({ assignment, budget }) => {
      calls++;
      expect(assignment.limits.tokens).toBeNull();
      expect(assignment.limits.deadline_at).toBeNull();
      const receipt = await budget.reserve(null);
      await budget.settle(receipt, usage);
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage,
        rows: [],
      };
    };
    const options = {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'unlimited', mode: 'start' as const },
    };
    expect((await executeAgenticRun(f.host, f.context(), options)).chargedTokens).toBe(1200);
    expect(
      (
        await executeAgenticRun(f.host, f.context(), {
          ...options,
          run: { ...options.run, mode: 'resume' },
        })
      ).reusedCompletion
    ).toBe(true);
    expect(calls).toBe(2);
  });

  it('uses the remaining shared budget without an assignment cap', async () => {
    const f = runFixture(2);
    f.model.limits = { tokens: 1500 };
    delete f.host.tokensPerAssignment;
    f.host.concurrency = 3;
    const allowances: (number | null)[] = [];
    f.host.executeAgent = async ({ assignment, budget }) => {
      allowances.push(assignment.limits.tokens);
      const receipt = await budget.reserve(assignment.limits.tokens);
      await budget.settle(receipt, usage);
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage,
        rows: [],
      };
    };
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: new MemoryStateStore(),
      run: { id: 'shared', mode: 'start' },
    });
    expect(allowances).toEqual([1500, 900]);
    expect(result.chargedTokens).toBe(1200);
  });
});

it('resumes an unlimited run from local files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dogsled-unlimited-'));
  try {
    const f = runFixture(1);
    f.model.limits = {};
    delete f.host.tokensPerAssignment;
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: directory,
      run: { id: 'local', mode: 'start' },
    });
    f.host.executeAgent = async () => {
      throw new Error('Must reuse accepted work');
    };
    const resumed = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: directory,
      run: { id: 'local', mode: 'resume' },
    });
    expect(resumed.chargedTokens).toBe(result.chargedTokens);
    expect(resumed.deadlineAt).toBeNull();
    expect(resumed.reusedCompletion).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('binds different limits to separate plan steps and persists them on resume', async () => {
  const f = runFixture(1);
  delete f.host.tokensPerAssignment;
  f.model.limits = {
    tokens_per_assignment: 100,
    tool_calls_per_assignment: 4,
    model_calls_per_assignment: 2,
  };
  const first = f.model.plan.steps[0]!;
  f.model.plan.steps = [
    { ...first, id: 'first' },
    {
      ...first,
      id: 'second',
      limits: { tokens_per_assignment: null, tool_calls_per_assignment: 8 },
    },
  ];
  f.model.output.from = 'second';
  const seen: unknown[] = [];
  f.host.executeAgent = async ({ assignment, budget }) => {
    seen.push({ step: assignment.step_id, ...assignment.limits });
    const receipt = await budget.reserve(assignment.limits.tokens);
    const measured = {
      status: 'measured' as const,
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
    await budget.settle(receipt, measured);
    return {
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: measured,
      rows: [],
    };
  };
  const options = {
    projectDirectory: '/unused',
    stateStore: new MemoryStateStore(),
    run: { id: 'steps', mode: 'start' as const },
  };
  expect((await executeAgenticRun(f.host, f.context(), options)).chargedTokens).toBe(4);
  expect(seen).toMatchObject([
    { step: 'first', tokens: 100, tool_calls: 4, model_calls: 2 },
    { step: 'second', tokens: null, tool_calls: 8, model_calls: 2 },
  ]);
  await executeAgenticRun(f.host, f.context(), {
    ...options,
    run: { id: 'steps', mode: 'resume' },
  });
  expect(seen).toHaveLength(2);
});

it('enforces an assignment token cap without a model token cap', async () => {
  const f = runFixture(1);
  delete f.host.tokensPerAssignment;
  f.model.limits = { tokens_per_assignment: 100 };
  const stateStore = new MemoryStateStore();
  f.host.executeAgent = async ({ assignment }) => ({
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'succeeded',
    usage,
    rows: [],
  });
  await expect(
    executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore,
      run: { id: 'overrun', mode: 'start' },
    })
  ).rejects.toThrow('limit');
  const saved = [...stateStore.runs.values()][0]!;
  expect(saved.charged).toBe(600);
  expect(saved.work[0]!.accepted).toBeUndefined();
});

it('preserves unknown usage without inventing an unlimited reservation amount', async () => {
  const f = runFixture(1);
  delete f.host.tokensPerAssignment;
  f.model.limits = {};
  const stateStore = new MemoryStateStore();
  f.host.executeAgent = async ({ assignment }) => ({
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'succeeded',
    usage: { status: 'unknown', reason: 'unavailable' },
    rows: [],
  });
  await executeAgenticRun(f.host, f.context(), {
    projectDirectory: '/unused',
    stateStore,
    run: { id: 'unknown', mode: 'start' },
  });
  const saved = [...stateStore.runs.values()][0]!;
  expect(saved.work[0]!.accepted?.usage.status).toBe('unknown');
  expect(saved.work[0]!.attempts[0]!.reservation).toBeNull();
});
