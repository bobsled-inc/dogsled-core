import { describe, it, expect, vi } from 'vitest';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { MemoryStateStore } from './state-fixture.js';
import { runFixture } from './state-fixture.js';
import { AgentAssignmentSchema } from '../../../src/agentic/assignment.js';
import { assignment } from './fixtures.js';

function fixture() {
  const f = runFixture(1);
  const step = f.model.plan.steps[0]!;
  step.classification = { choices: { same: 'Same place', different: 'Different places' } };
  step.columns = [
    step.columns[0]!,
    { name: 'choice', type: 'string', nullable: false },
    { name: 'confidence', type: 'number', nullable: false },
  ];
  f.host.platform.models.review = {
    provider: 'typesafe',
    model: 'jev-latest',
    api_key: '$TEST_KEY',
    auth_env_vars: ['TEST_KEY'],
  };
  return f;
}
describe('classification contract', () => {
  it('resolves a single classification with the existing profile contract', () => {
    expect(fixture().context().resolved.steps[0]!.step.classification?.choices.same).toBe(
      'Same place'
    );
  });
  it.each(['agent_loop', 'skills', 'column', 'choices', 'collision', 'provider'])(
    'rejects unsupported %s',
    (kind) => {
      const f = fixture();
      const step = f.model.plan.steps[0]!;
      if (kind === 'agent_loop') step.execution.mode = 'agent_loop';
      if (kind === 'skills') step.skills = ['skill'];
      if (kind === 'column') step.columns.pop();
      if (kind === 'choices') step.classification!.choices = { only: 'One' };
      if (kind === 'collision') step.columns[0]!.name = 'choice';
      if (kind === 'provider') {
        f.host.platform.models.review = {
          provider: 'openai',
          model: 'x',
          api_key: '$KEY',
          auth_env_vars: ['KEY'],
        };
      }
      expect(() => f.context()).toThrow();
    }
  );
  it('rejects multiple rows at the assignment boundary', () => {
    const a = assignment();
    const data = {
      ...a,
      classification: { choices: { yes: 'Yes', no: 'No' } },
      profile: {
        name: 'review',
        connection: {
          provider: 'typesafe',
          model: 'jev-latest',
          api_key: '$KEY',
          auth_env_vars: ['KEY'],
        },
      },
      output: {
        ...a.output,
        columns: [
          a.output.columns[0],
          { name: 'choice', type: 'string', nullable: false },
          { name: 'confidence', type: 'number', nullable: false },
        ],
      },
    };
    expect(AgentAssignmentSchema.safeParse(data).success).toBe(true);
    data.input.rows.push({ pair_id: 'pair-1' });
    expect(AgentAssignmentSchema.safeParse(data).success).toBe(false);
  });
});

it('preserves choices through checkpoint resume and rejects duplicate groups before calls', async () => {
  const f = fixture();
  const stateStore = new MemoryStateStore();
  const original = f.host.executeAgent;
  const execute = vi.fn(async (request: Parameters<typeof original>[0]) => ({
    ...(await original(request)),
    status: 'succeeded' as const,
    rows: [
      {
        ...request.assignment.group_key,
        choice: 'same',
        confidence: 0.8,
        _bobsled_evidence: null,
        _bobsled_confidence: 0.8,
        _bobsled_reason: null,
      },
    ],
  }));
  f.host.executeAgent = execute;
  await executeAgenticRun(f.host, f.context(), {
    run: { id: 'classification', mode: 'start' },
    stateStore,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]![0].assignment.classification?.choices.same).toBe('Same place');
  await executeAgenticRun(f.host, f.context(), {
    run: { id: 'classification', mode: 'resume' },
    stateStore,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  f.host.prepare = async () => [{ pair_id: 'p0' }, { pair_id: 'p0' }];
  await expect(
    executeAgenticRun(f.host, f.context(), { run: { id: 'duplicate', mode: 'start' }, stateStore })
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});
