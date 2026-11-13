import { describe, expect, it } from 'vitest';
import { runFixture } from './state-fixture.js';
import { resolveAgenticModel } from '../../../src/agentic/resolve.js';
import { buildAgenticStepAssignments } from '../../../src/agentic/plan-work.js';
import {
  agenticDefinitionIdentity,
  AgenticRunSnapshotSchema,
  applyAgenticCheckpoint,
} from '../../../src/agentic/state.js';
import type { AgenticRunSnapshot } from '../../../src/agentic/state.js';

function fixture(rows: { pair_id: string }[] = []) {
  const f = runFixture();
  const first = f.model.plan.steps[0]!;
  const model = {
    ...f.model,
    plan: {
      steps: [
        first,
        {
          ...first,
          id: 'second',
          source: { ref: first.id },
          map: { over: first.id, group_by: ['pair_id'] },
        },
      ],
    },
    output: { from: 'second' },
  };
  const resolved = resolveAgenticModel(model, f.host);
  const definition = { resolved, tokensPerAssignment: 100, maxAttempts: 3 };
  const started_at = new Date(Date.now() - 1000).toISOString();
  const run = AgenticRunSnapshotSchema.parse({
    version: 2,
    revision: 0,
    key: { scope: 'lake', model: model.name, id: 'run' },
    definition,
    identity: agenticDefinitionIdentity(definition),
    started_at,
    deadline_at: new Date(
      Date.parse(started_at) + model.limits.timeout_seconds * 1000
    ).toISOString(),
    token_limit: model.limits.tokens,
    max_attempts: 3,
    charged: 0,
    status: 'preparing',
    publication: 'pending',
    work: [],
  });
  const seal = {
    type: 'seal_work' as const,
    operation_id: 'seal_work' as const,
    expected_revision: 0,
    assignments: [],
    plan_inputs: {
      pairs: {
        ref: 'undecided_pairs',
        columns: resolved.steps[0]!.input_columns,
        rows,
        retrieved_at: started_at,
      },
    },
  };
  return { run, seal, state: applyAgenticCheckpoint(run, seal) };
}
function append(state: AgenticRunSnapshot, index: number) {
  const step_id = index === 0 ? 'assess' : 'second';
  return {
    type: 'append_step' as const,
    operation_id: `append_step:${step_id}`,
    expected_revision: state.revision,
    step_id,
    assignments: buildAgenticStepAssignments(state, index),
  };
}

describe('durable plan step checkpoints', () => {
  it('rejects retired snapshot versions', () => {
    const { run } = fixture();
    expect(run.version).toBe(2);
    expect(AgenticRunSnapshotSchema.safeParse({ ...run, version: 1 }).success).toBe(false);
  });

  it.each(['instructions', 'sources', 'output'] as const)(
    'rejects a resolved %s contract that differs from the model',
    (field) => {
      const { run } = fixture();
      const definition = run.definition as unknown as {
        resolved: ReturnType<typeof resolveAgenticModel>;
      };
      if (field === 'instructions') {
        definition.resolved.steps[0]!.step = {
          ...definition.resolved.steps[0]!.step,
          instructions: 'Different instructions',
        };
      }
      if (field === 'sources') definition.resolved.steps[0]!.allowed_sources = ['pairs'];
      if (field === 'output') {
        definition.resolved.output_columns = [
          { name: 'unapproved', type: 'string', nullable: false },
        ];
      }
      run.identity = agenticDefinitionIdentity(run.definition);
      expect(AgenticRunSnapshotSchema.safeParse(run).success).toBe(false);
    }
  );

  it('seals empty steps separately and refuses premature completion', () => {
    let { state } = fixture();
    expect(() =>
      applyAgenticCheckpoint(state, {
        type: 'complete',
        operation_id: 'complete',
        expected_revision: state.revision,
      })
    ).toThrow();
    const first = append(state, 0);
    state = applyAgenticCheckpoint(state, first);
    expect(state.work).toEqual([]);
    expect(state.sealed_steps).toEqual([{ id: 'assess', revision: 1 }]);
    expect(applyAgenticCheckpoint(state, first)).toEqual(state);
    state = applyAgenticCheckpoint(state, append(state, 1));
    state = applyAgenticCheckpoint(state, {
      type: 'complete',
      operation_id: 'complete',
      expected_revision: state.revision,
    });
    expect(state.status).toBe('execution_complete');
    expect(state.revision).toBe(4);
  });

  it('keeps the initial input seal idempotent after step work is added', () => {
    const f = fixture([{ pair_id: 'p0' }]);
    const state = applyAgenticCheckpoint(f.state, append(f.state, 0));
    expect(state.work).toHaveLength(1);
    expect(applyAgenticCheckpoint(state, f.seal)).toEqual(state);
    const changed = structuredClone(f.seal);
    changed.plan_inputs.pairs.rows = [{ pair_id: 'changed' }];
    expect(() => applyAgenticCheckpoint(state, changed)).toThrow();
  });

  it('appends downstream work after an accepted empty result without losing prior attempts', () => {
    let { state } = fixture([{ pair_id: 'p0' }]);
    state = applyAgenticCheckpoint(state, append(state, 0));
    state = applyAgenticCheckpoint(state, {
      type: 'start_attempt',
      operation_id: 'start_attempt:attempt',
      expected_revision: state.revision,
      work: 0,
      attempt_id: 'attempt',
    });
    state = applyAgenticCheckpoint(state, {
      type: 'finish_attempt',
      operation_id: 'finish_attempt:attempt',
      expected_revision: state.revision,
      work: 0,
      attempt_id: 'attempt',
      charge: 2,
      outcome: {
        contract_version: 2,
        attempt_id: 'attempt',
        status: 'succeeded',
        rows: [],
        usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    const prior = structuredClone(state.work[0]);
    const second = append(state, 1);
    state = applyAgenticCheckpoint(state, second);
    expect(state.work[0]).toEqual(prior);
    expect(state.work).toHaveLength(2);
    expect(state.work[1]!.assignment.input.rows).toEqual([]);
    expect(state.work[1]!.assignment.processed_keys).toEqual([{ pair_id: 'p0' }]);
    expect(applyAgenticCheckpoint(state, second)).toEqual(state);
    expect(() =>
      applyAgenticCheckpoint(state, { ...second, expected_revision: second.expected_revision - 1 })
    ).toThrow();
    const forged = structuredClone(state);
    forged.sealed_steps![1]!.revision = 3;
    expect(AgenticRunSnapshotSchema.safeParse(forged).success).toBe(false);
  });

  it('rejects wrong step IDs, altered assignments, unaccepted dependencies and malformed snapshots', () => {
    const { state } = fixture([{ pair_id: 'p0' }]);
    const first = append(state, 0);
    expect(() =>
      applyAgenticCheckpoint(state, {
        ...first,
        step_id: 'second',
        operation_id: 'append_step:second',
      })
    ).toThrow();
    expect(() => applyAgenticCheckpoint(state, { ...first, assignments: [] })).toThrow();
    const next = applyAgenticCheckpoint(state, first);
    expect(() => buildAgenticStepAssignments(next, 1)).toThrow();
    const bad = structuredClone(next);
    bad.plan_inputs!.pairs!.ref = 'unapproved';
    expect(AgenticRunSnapshotSchema.safeParse(bad).success).toBe(false);
    bad.plan_inputs!.pairs!.ref = 'undecided_pairs';
    bad.sealed_steps![0]!.revision = 0;
    expect(AgenticRunSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});
