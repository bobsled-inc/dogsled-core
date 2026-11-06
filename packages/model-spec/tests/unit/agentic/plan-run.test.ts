import { describe, expect, it, vi } from 'vitest';
import { executeAgenticRun, resolveAgenticModel } from '../../../src/agentic/index.js';
import type { AgentExecutorRequest, AgenticRunProgress } from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

function fixture(count = 2) {
  const f = runFixture(count);
  const original = f.model.plan.steps[0]!;
  f.model.plan.steps = [
    { ...structuredClone(original), id: 'names' },
    { ...structuredClone(original), id: 'phones' },
    {
      id: 'combine',
      source: { ref: 'names' },
      reduce: { over: ['names', 'phones'], group_by: ['pair_id'] },
      execution: { mode: 'llm_call' },
      instructions: 'Compare both assessments.',
      columns: original.columns,
    },
  ];
  f.model.output.from = 'combine';
  const stateStore = new MemoryStateStore();
  const options = {
    stateStore,
    projectDirectory: '/not-used',
    run: { id: 'plan', mode: 'start' as const },
    accounting: 'reservation' as const,
  };
  const context = () => ({ ...f.context(), resolved: resolveAgenticModel(f.model, f.host) });
  return {
    ...f,
    context,
    options,
    stateStore,
    state: () => [...stateStore.runs.values()][0]!,
    run: () => executeAgenticRun(f.host, context(), options),
  };
}
async function answer(request: AgentExecutorRequest, empty = false) {
  const { assignment, budget } = request;
  const receipt = await budget.reserve(100);
  const usage = { status: 'measured' as const, input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  await budget.settle(receipt, usage);
  return {
    contract_version: 2 as const,
    attempt_id: assignment.attempt_id,
    status: 'succeeded' as const,
    usage,
    rows: empty
      ? []
      : assignment.processed_keys.map((key) => ({
          ...key,
          assessment: assignment.step_id,
          _dogsled_evidence: null,
          _dogsled_confidence: null,
          _dogsled_reason: null,
        })),
  };
}

describe('authored agentic plans', { timeout: 60_000 }, () => {
  it('reports step counts without claiming a final total before downstream work is prepared', async () => {
    const f = fixture(2);
    f.host.executeAgent = answer;
    const progress: AgenticRunProgress[] = [];
    await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      onProgress: (value) => {
        progress.push(value);
      },
    });
    expect(progress).toContainEqual(
      expect.objectContaining({ total: 2, accepted: 2, totalIsFinal: false })
    );
    expect(progress.at(-1)).toMatchObject({
      total: 6,
      accepted: 6,
      totalIsFinal: true,
      steps: ['names', 'phones', 'combine'].map((stepId) => ({
        stepId,
        total: 2,
        accepted: 2,
        sealed: true,
      })),
    });
  });
  it('keeps the dispatch interval across step boundaries', async () => {
    const f = fixture(1);
    const starts: number[] = [];
    f.host.minDispatchIntervalMs = 150;
    f.host.executeAgent = async (request) => {
      starts.push(Date.now());
      return answer(request);
    };
    await f.run();
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(150);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(150);
  });

  it('measures the dispatch interval from the start of each call', async () => {
    const f = fixture(1);
    const starts: number[] = [];
    f.host.minDispatchIntervalMs = 100;
    f.host.executeAgent = async (request) => {
      // A call that is slow to start must not eat into the interval before the next one.
      const started = Date.now();
      if (starts.length === 0) while (Date.now() < started + 60);
      starts.push(Date.now());
      return answer(request);
    };
    await f.run();
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
  });

  it('does not expose preparation errors from the host', async () => {
    const f = fixture(1);
    f.host.prepare = async () => {
      throw new Error('secret connection detail');
    };
    await expect(f.run()).rejects.toThrow('Agentic input preparation failed');
  });

  it('reduces groups with several replacement keys without flattening inputs', async () => {
    const f = fixture(2);
    f.host.inputs.undecided_pairs!.push({ name: 'batch_id', type: 'string', nullable: false });
    f.host.prepare = async () => [
      { pair_id: 'p0', batch_id: 'b1' },
      { pair_id: 'p1', batch_id: 'b1' },
    ];
    for (const step of f.model.plan.steps) {
      ('map' in step ? step.map : step.reduce).group_by = ['batch_id'];
      step.columns = [...step.columns, { name: 'batch_id', type: 'string', nullable: false }];
    }
    const steps: string[] = [];
    f.host.executeAgent = async (request) => {
      steps.push(request.assignment.step_id);
      expect(request.assignment.processed_keys).toHaveLength(2);
      expect(request.assignment.input.rows).toHaveLength(2);
      if (request.assignment.inputs) {
        expect(request.assignment.inputs.names!.rows).toHaveLength(2);
        expect(request.assignment.inputs.phones!.rows).toHaveLength(2);
      }
      const result = await answer(request);
      return { ...result, rows: result.rows.map((row) => ({ ...row, batch_id: 'b1' })) };
    };
    expect((await f.run()).rows).toHaveLength(2);
    expect(steps).toEqual(['names', 'phones', 'combine']);
  });

  it('waits for both inputs, keeps named data separate, and emits only final rows', async () => {
    const f = fixture();
    const calls: string[] = [];
    f.host.concurrency = 2;
    f.host.executeAgent = async (request) => {
      const a = request.assignment;
      calls.push(a.step_id);
      if (a.step_id === 'combine') {
        expect(
          f
            .state()
            .work.filter((w) => w.assignment.step_id !== 'combine')
            .every((w) => !!w.accepted)
        ).toBe(true);
        expect(Object.keys(a.inputs!)).toEqual(['names', 'phones']);
        expect(a.inputs!.names!.rows[0]).toMatchObject({
          assessment: 'names',
          _dogsled_run_id: 'plan',
        });
        expect(a.inputs!.phones!.rows[0]).toMatchObject({ assessment: 'phones' });
      } else {
        expect(a.inputs).toBeUndefined();
        expect(a.input.rows[0]).toEqual(a.processed_keys[0]);
        expect(request.sources).toBeUndefined();
      }
      return answer(request);
    };
    const result = await f.run();
    expect(calls).toEqual(['names', 'names', 'phones', 'phones', 'combine', 'combine']);
    expect(result.rows).toHaveLength(2);
    expect(
      result.rows.every((row) => (row as { assessment: string }).assessment === 'combine')
    ).toBe(true);
    expect(result.processedKeys).toHaveLength(2);
    expect(result.chargedTokens).toBe(12);
  });

  it('passes completed empty inputs to reduce with their processed keys', async () => {
    const f = fixture(1);
    f.host.executeAgent = async (request) => {
      if (request.assignment.step_id === 'combine') {
        expect(request.assignment.inputs!.names).toMatchObject({
          complete: true,
          rows: [],
          processed_keys: [{ pair_id: 'p0' }],
        });
        expect(request.assignment.inputs!.phones!.rows).toHaveLength(1);
      }
      return answer(request, request.assignment.step_id === 'names');
    };
    expect((await f.run()).rows).toHaveLength(1);
  });

  it('seals all empty steps and completes without calls or replacement keys', async () => {
    const f = fixture(0);
    f.host.executeAgent = vi.fn();
    const result = await f.run();
    expect(result.rows).toEqual([]);
    expect(result.processedKeys).toEqual([]);
    expect(f.state().sealed_steps).toHaveLength(3);
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('reuses saved inputs and both completed maps after an interrupted reduce', async () => {
    const f = fixture(1);
    const calls: string[] = [];
    f.host.executeAgent = async (request) => {
      calls.push(request.assignment.step_id);
      if (request.assignment.step_id === 'combine') throw new Error('interrupted');
      return answer(request);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.state().sealed_steps).toHaveLength(3);
    f.host.prepare = vi.fn(async () => {
      throw new Error('Must not read sources on resume');
    });
    f.host.executeAgent = async (request) => {
      calls.push(request.assignment.step_id);
      return answer(request);
    };
    const resumed = await executeAgenticRun(f.host, f.context(), {
      ...f.options,
      run: { id: 'plan', mode: 'resume' },
      accounting: 'reservation' as const,
    });
    expect(calls).toEqual(['names', 'phones', 'combine', 'combine']);
    expect(resumed.chargedTokens).toBe(106);
    expect(f.host.prepare).not.toHaveBeenCalled();
    f.host.executeAgent = vi.fn();
    expect(
      (
        await executeAgenticRun(f.host, f.context(), {
          ...f.options,
          run: { id: 'plan', mode: 'resume' },
          accounting: 'reservation' as const,
        })
      ).reusedCompletion
    ).toBe(true);
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('rejects a missing required group instead of treating it as an empty result', async () => {
    const f = fixture(2);
    f.model.sources.other = { ref: 'other_pairs' };
    f.host.inputs = { ...f.host.inputs, other_pairs: f.host.inputs.undecided_pairs };
    const phones = f.model.plan.steps[1]!;
    if (!('map' in phones)) throw new Error('Expected map');
    phones.source.ref = 'other';
    phones.map.over = 'other';
    f.host.prepare = async (context) =>
      context.inputRef === 'other_pairs'
        ? [{ pair_id: 'p0' }]
        : [{ pair_id: 'p0' }, { pair_id: 'p1' }];
    f.host.executeAgent = (request) => answer(request);
    await expect(f.run()).rejects.toThrow('missing');
    expect(f.state().status).toBe('running');
    expect(f.state().work.some((w) => w.assignment.step_id === 'combine')).toBe(false);
  });
});
