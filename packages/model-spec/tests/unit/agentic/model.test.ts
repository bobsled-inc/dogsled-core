import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { AgenticModelSpecSchema } from '../../../src/agentic/index.js';
import { parseTransformSpecFromParsed } from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

const fixture = (): Record<string, unknown> =>
  parse(
    readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
  );

describe('agentic model contracts', () => {
  it('accepts a prepared-pair model without a repeated input schema', () => {
    const model = AgenticModelSpecSchema.parse(fixture());
    expect(model.output.from).toBe('assess');
    expect(model.plan.steps[0]?.columns[0]).toEqual({
      name: 'pair_id',
      type: 'string',
      nullable: false,
    });
  });

  it('rejects agentic models before applying SQL hierarchy rewriting', () => {
    const model = AgenticModelSpecSchema.parse(fixture());
    expect(parseTransformSpecFromParsed(model, new Map())).toEqual({
      ok: false,
      error: 'Agentic models require agentic dispatch and cannot compile as SQL',
    });
  });

  it('rejects agentic definitions at the SQL-only schema boundary', () => {
    expect(
      TransformSpecSchema.safeParse({
        ...fixture(),
        source: { ref: 'undecided_pairs' },
        columns: [{ name: 'pair_id', expr: 'pair_id' }],
      }).success
    ).toBe(false);
  });
});

it.each([
  ['unknown top-level field', { extra: true }],
  ['missing output step', { output: { from: 'missing' } }],
  ['missing grain column', { grain: ['missing'] }],
  [
    'missing replacement key',
    { materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['missing'] } },
  ],
  [
    'unsupported strategy',
    { materialization: { type: 'table', strategy: 'merge', keys: ['pair_id'] } },
  ],
  ['zero budget', { limits: { tokens: 0, timeout_seconds: 600 } }],
])('rejects %s', (_label, patch) => {
  expect(AgenticModelSpecSchema.safeParse({ ...fixture(), ...patch }).success).toBe(false);
});

it('requires explicit mode and rejects SQL expressions and reserved metadata', () => {
  const model = AgenticModelSpecSchema.parse(fixture());
  const step = model.plan.steps[0]!;
  for (const patch of [
    { execution: undefined },
    { execution: { mode: 'python' } },
    { columns: [{ name: '_dogsled_reason', type: 'object', nullable: true }] },
    { columns: [{ name: 'pair_id', type: 'string', nullable: false, expr: 'pair_id' }] },
    { columns: [{ name: 'pair_id', type: 'string' }] },
    { source: { ref: 'later' } },
    { sources: ['undeclared'] },
  ]) {
    expect(
      AgenticModelSpecSchema.safeParse({ ...model, plan: { steps: [{ ...step, ...patch }] } })
        .success
    ).toBe(false);
  }
});

it('preserves existing database execution settings and rejects ambiguous names', () => {
  expect(
    AgenticModelSpecSchema.parse({
      ...fixture(),
      execution: { engine: 'warehouse', staging: 'persistent' },
    }).execution
  ).toEqual({ engine: 'warehouse', staging: 'persistent' });
  const model = AgenticModelSpecSchema.parse(fixture());
  const step = model.plan.steps[0]!;
  expect(
    AgenticModelSpecSchema.safeParse({ ...model, plan: { steps: [step, step] } }).success
  ).toBe(false);
  expect(
    AgenticModelSpecSchema.safeParse({
      ...model,
      sources: { pairs: { ref: 'undecided_pairs' }, PAIRS: { ref: 'other' } },
    }).success
  ).toBe(false);
});

it('rejects changed types for reserved metadata read from earlier models', async () => {
  const { AgenticColumnsSchema } = await import('../../../src/agentic/index.js');
  expect(
    AgenticColumnsSchema.safeParse([{ name: '_dogsled_run_id', type: 'number', nullable: true }])
      .success
  ).toBe(false);
  expect(
    AgenticColumnsSchema.safeParse([{ name: '_dogsled_custom', type: 'string', nullable: false }])
      .success
  ).toBe(false);
});

it.each(['context_sources', 'sources'] as const)('validates the %s context read list', (field) => {
  const model = AgenticModelSpecSchema.parse(fixture());
  const step = model.plan.steps[0]!;
  step.execution.mode = 'agent_loop';
  step[field] = ['pairs'];
  expect(AgenticModelSpecSchema.safeParse(model).success).toBe(true);
  step[field] = ['undeclared'];
  const invalid = AgenticModelSpecSchema.safeParse(model);
  expect(invalid.success).toBe(false);
  if (!invalid.success) {
    expect(invalid.error.issues[0]?.path).toEqual(['plan', 'steps', 0, field]);
  }
  step[field] = ['pairs'];
  step.execution.mode = 'llm_call';
  expect(AgenticModelSpecSchema.safeParse(model).success).toBe(false);
});

it('rejects both context source spellings even when one list is empty', () => {
  const model = AgenticModelSpecSchema.parse(fixture());
  const step = model.plan.steps[0]!;
  step.execution.mode = 'agent_loop';
  step.context_sources = [];
  step.sources = ['pairs'];
  expect(AgenticModelSpecSchema.safeParse(model).success).toBe(false);
});
