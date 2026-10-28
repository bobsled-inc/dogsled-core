import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  AgentAssignmentSchema,
  createAgentAssignmentOutputSchema,
  createAgentAssignmentRowSchema,
  parseAgentAssignmentOutcome,
} from '../../../src/agentic/index.js';
import { assignment } from './fixtures.js';

const citation = (source: string) => ({
  source,
  reference: 'https://example.com/event',
  support_excerpt: null,
  retrieved_at: '2026-09-11T10:01:00Z',
});

describe('assignment output contract', () => {
  function validators(task = AgentAssignmentSchema.parse(assignment())) {
    const schema = createAgentAssignmentOutputSchema(task);
    const json = JSON.parse(JSON.stringify(schema.toJSONSchema()));
    const wire = new Ajv2020({ strict: false, validateFormats: false }).compile(json);
    return {
      task,
      json,
      accepts(value: unknown) {
        const accepted = schema.safeParse(value).success;
        expect(wire(value)).toBe(accepted);
        return accepted;
      },
    };
  }

  it('rejects duplicate single-grain output before the agent finishes', () => {
    const schema = validators();
    expect(schema.accepts({ rows: [row('pairs')] })).toBe(true);
    expect(schema.accepts({ rows: [row('pairs'), row('pairs')] })).toBe(false);
    expect(schema.json.type).toBe('object');
    expect(schema.json.properties.rows.maxItems).toBe(1);
  });

  it('publishes group keys as literal values', () => {
    const schema = validators();
    expect(schema.accepts({ rows: [{ ...row('pairs'), pair_id: 'another-pair' }] })).toBe(false);
    expect(schema.json.properties.rows.items.properties.pair_id.const).toBe('pair-1');
  });

  it('keeps valid empty output distinct from an absent or invalid result', () => {
    const schema = validators();
    expect(schema.accepts({ rows: [] })).toBe(true);
    for (const invalid of [
      {},
      { rows: null },
      { rows: [], extra: true },
      { rows: [{ pair_id: 'pair-1' }] },
    ]) {
      expect(schema.accepts(invalid)).toBe(false);
    }
  });

  it('requires the prepared input timestamp while allowing fresh source evidence', () => {
    const task = AgentAssignmentSchema.parse({
      ...assignment(),
      mode: 'agent_loop',
      input: { ...assignment().input, retrieved_at: '2026-09-11T10:00:00Z' },
      allowed_tools: ['web_fetch'],
    });
    const schema = validators(task);
    expect(schema.accepts({ rows: [row('pairs')] })).toBe(false);
    const valid = {
      ...row('pairs'),
      _dogsled_evidence: [{ ...citation('pairs'), retrieved_at: task.input.retrieved_at }],
    };
    expect(schema.accepts({ rows: [valid] })).toBe(true);
    expect(schema.accepts({ rows: [row('web_fetch')] })).toBe(true);
    expect(() =>
      parseAgentAssignmentOutcome(task, {
        contract_version: 2,
        attempt_id: task.attempt_id,
        status: 'succeeded',
        rows: [valid],
        usage: { status: 'unknown', reason: 'unavailable' },
      })
    ).not.toThrow();
  });

  it('does not freeze evidence time for an input that can also be queried live', () => {
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...assignment(),
        mode: 'agent_loop',
        allowed_sources: ['pairs'],
        input: { ...assignment().input, retrieved_at: '2026-09-11T10:00:00Z' },
      })
    );
    expect(schema.accepts({ rows: [row('pairs')] })).toBe(true);
  });

  it('allows several findings when the group does not fix the whole output grain', () => {
    const task = assignment();
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...task,
        output: { ...task.output, grain: ['pair_id', 'assessment'] },
      })
    );
    expect(
      schema.accepts({ rows: [row('pairs'), { ...row('pairs'), assessment: 'another finding' }] })
    ).toBe(true);
    expect(schema.json.properties.rows.maxItems).toBe(1000);
  });

  it('requires one classification from the declared choices with valid confidence', () => {
    const task = assignment();
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...task,
        classification: { choices: { same: 'Same place', different: 'Different place' } },
        profile: {
          name: 'classifier',
          connection: {
            provider: 'typesafe',
            model: 'jev-latest',
            api_key: '$KEY',
            auth_env_vars: ['KEY'],
          },
        },
        output: {
          ...task.output,
          columns: [
            task.output.columns[0],
            { name: 'choice', type: 'string', nullable: false },
            { name: 'confidence', type: 'number', nullable: false },
          ],
        },
      })
    );
    const classification = {
      pair_id: 'pair-1',
      choice: 'same',
      confidence: 0.8,
      _dogsled_evidence: null,
      _dogsled_confidence: null,
      _dogsled_reason: null,
    };
    expect(schema.accepts({ rows: [classification] })).toBe(true);
    for (const rows of [
      [],
      [classification, classification],
      [{ ...classification, choice: 'invented' }],
      [{ ...classification, confidence: 1.1 }],
    ]) {
      expect(schema.accepts({ rows })).toBe(false);
    }
  });

  it('keeps the declared types of numeric and boolean group keys', () => {
    const task = assignment();
    const keys = { item_id: 7, active: true };
    const columns = [
      { name: 'item_id', type: 'integer', nullable: false },
      { name: 'active', type: 'boolean', nullable: false },
    ];
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...task,
        group_key: keys,
        processed_keys: [keys],
        input: { ...task.input, columns, rows: [keys] },
        output: { columns, grain: ['item_id', 'active'], replacement_keys: ['item_id', 'active'] },
      })
    );
    const value = {
      ...keys,
      _dogsled_evidence: null,
      _dogsled_confidence: null,
      _dogsled_reason: null,
    };
    expect(schema.accepts({ rows: [value] })).toBe(true);
    expect(schema.accepts({ rows: [{ ...value, item_id: '7' }] })).toBe(false);
    expect(schema.accepts({ rows: [{ ...value, active: false }] })).toBe(false);
  });

  it('keeps the final validator as the authority for multi-row grain uniqueness', () => {
    const task = assignment();
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...task,
        output: { ...task.output, grain: ['pair_id', 'assessment'] },
      })
    );
    const rows = [row('pairs'), row('pairs')];
    expect(schema.accepts({ rows })).toBe(true);
    expect(() =>
      parseAgentAssignmentOutcome(schema.task, {
        contract_version: 2,
        attempt_id: schema.task.attempt_id,
        status: 'succeeded',
        rows,
        usage: { status: 'unknown', reason: 'unavailable' },
      })
    ).toThrow('Output rows must be unique at the declared grain');
  });

  it('transports array and object columns without losing the local data bounds', () => {
    const task = assignment();
    const schema = validators(
      AgentAssignmentSchema.parse({
        ...task,
        output: {
          ...task.output,
          columns: [
            ...task.output.columns,
            { name: 'keywords', type: 'array', nullable: false },
            { name: 'details', type: 'object', nullable: true },
          ],
        },
      })
    );
    const value = {
      ...row('pairs'),
      keywords: ['rain', 'wind'],
      details: { nested: [{ value: 3, known: true }], missing: null },
    };
    expect(schema.accepts({ rows: [value] })).toBe(true);
    expect(schema.accepts({ rows: [{ ...value, keywords: 'rain' }] })).toBe(false);
    expect(schema.accepts({ rows: [{ ...value, details: [] }] })).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 18; i++) deep = { next: deep };
    const cycle: Record<string, unknown> = {};
    cycle['next'] = cycle;
    const local = createAgentAssignmentOutputSchema(schema.task);
    for (const details of [deep, cycle, JSON.parse('{"__proto__":{"unsafe":true}}')]) {
      expect(local.safeParse({ rows: [{ ...value, details }] }).success).toBe(false);
    }
    expect(
      local.safeParse({
        rows: [
          {
            ...value,
            keywords: ['x'.repeat(1_048_577)],
          },
        ],
      }).success
    ).toBe(false);
  });
});
const row = (source: string) => ({
  pair_id: 'pair-1',
  assessment: 'uncertain',
  _dogsled_evidence: [citation(source)],
  _dogsled_confidence: null,
  _dogsled_reason: null,
});

describe('assignment output evidence schema', () => {
  const work = () =>
    AgentAssignmentSchema.parse({
      ...assignment(),
      mode: 'agent_loop',
      allowed_sources: ['documents'],
      allowed_tools: ['web_fetch'],
    });

  it.each(['pairs', 'documents', 'web_fetch'])('accepts %s at both boundaries', (source) => {
    const task = work();
    expect(createAgentAssignmentRowSchema(task).safeParse(row(source)).success).toBe(true);
    expect(
      parseAgentAssignmentOutcome(task, {
        contract_version: 2,
        attempt_id: task.attempt_id,
        status: 'succeeded',
        rows: [row(source)],
        usage: { status: 'unknown', reason: 'unavailable' },
      }).status
    ).toBe('succeeded');
  });

  it.each(['https://example.com/event', 'inputs', 'invented_tool'])(
    'rejects %s before completion',
    (source) => {
      expect(createAgentAssignmentRowSchema(work()).safeParse(row(source)).success).toBe(false);
    }
  );

  it('publishes the exact source choices in JSON Schema', () => {
    const json = createAgentAssignmentRowSchema(work()).toJSONSchema();
    expect(JSON.stringify(json)).toContain('"enum":["pairs","documents","web_fetch"]');
  });

  it('preserves prior input evidence without granting a tool', () => {
    const task = AgentAssignmentSchema.parse({
      ...assignment(),
      input: {
        ...assignment().input,
        columns: [
          ...assignment().input.columns,
          { name: '_dogsled_evidence', type: 'array', nullable: true },
        ],
        rows: [{ pair_id: 'pair-1', _dogsled_evidence: [citation('prior_tool')] }],
      },
    });
    expect(createAgentAssignmentRowSchema(task).safeParse(row('prior_tool')).success).toBe(true);
    expect(task.allowed_tools ?? []).toEqual([]);
    expect(task.allowed_sources).toEqual([]);
  });

  it('continues to accept missing evidence as null and reject empty evidence', () => {
    const schema = createAgentAssignmentRowSchema(work());
    expect(schema.safeParse({ ...row('pairs'), _dogsled_evidence: null }).success).toBe(true);
    expect(schema.safeParse({ ...row('pairs'), _dogsled_evidence: [] }).success).toBe(false);
  });

  it('uses named input references rather than their aliases', () => {
    const task = AgentAssignmentSchema.parse({
      ...assignment(),
      inputs: {
        pages: {
          ...assignment().input,
          complete: true,
          processed_keys: assignment().processed_keys,
        },
      },
    });
    const schema = createAgentAssignmentRowSchema(task);
    expect(schema.safeParse(row('pairs')).success).toBe(true);
    expect(schema.safeParse(row('pages')).success).toBe(false);
  });
});
