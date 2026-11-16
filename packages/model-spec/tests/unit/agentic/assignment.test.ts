import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentAssignmentSchema, parseAgentAssignmentOutcome } from '../../../src/agentic/index.js';

import { assignment } from './fixtures.js';
const outcome = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/agentic/${file}.json`, import.meta.url), 'utf8'));

describe('assignment outcomes', () => {
  it('requires version 2 for assignments and outcomes', () => {
    const work = AgentAssignmentSchema.parse(assignment());
    expect(work.contract_version).toBe(2);
    expect(AgentAssignmentSchema.safeParse({ ...work, contract_version: 1 }).success).toBe(false);
    expect(() =>
      parseAgentAssignmentOutcome(work, {
        ...outcome('success-empty'),
        contract_version: 1,
      })
    ).toThrow();
  });

  it('keeps successful empty completion separate from a failed attempt', () => {
    const work = AgentAssignmentSchema.parse(assignment());
    expect(parseAgentAssignmentOutcome(work, outcome('success-empty')).status).toBe('succeeded');
    expect(parseAgentAssignmentOutcome(work, outcome('failure')).status).toBe('failed');
  });

  it('rejects a late attempt and absent usage', () => {
    const work = AgentAssignmentSchema.parse(assignment());
    expect(() =>
      parseAgentAssignmentOutcome(work, { ...outcome('success-empty'), attempt_id: 'old-attempt' })
    ).toThrow(/attempt/);
    expect(() =>
      parseAgentAssignmentOutcome(work, { ...outcome('success-empty'), usage: undefined })
    ).toThrow();
  });
});

describe('assignment boundary validation', () => {
  const finding = () => ({
    pair_id: 'pair-1',
    assessment: 'uncertain',
    _bobsled_evidence: null,
    _bobsled_confidence: null,
    _bobsled_reason: null,
  });
  const result = (rows: unknown[]) => ({ ...outcome('success-empty'), rows });

  it('accepts typed findings and a separate insufficient-evidence outcome', () => {
    const work = AgentAssignmentSchema.parse(assignment());
    expect(parseAgentAssignmentOutcome(work, result([finding()])).status).toBe('succeeded');
    expect(
      parseAgentAssignmentOutcome(work, {
        ...result([]),
        status: 'insufficient_evidence',
        reason: {
          summary: 'The input lacks enough evidence.',
          supporting_factors: [],
          conflicting_factors: [],
        },
      }).status
    ).toBe('insufficient_evidence');
  });

  it.each([
    ['foreign key', { pair_id: 'other-pair' }],
    ['null key', { pair_id: null }],
    ['wrong type', { assessment: 12 }],
    ['unknown field', { extra: true }],
    ['run override', { _bobsled_run_id: 'forged-run' }],
    ['invalid confidence', { _bobsled_confidence: 1.1 }],
    ['malformed reason', { _bobsled_reason: { summary: 'Missing factors' } }],
    ['empty evidence', { _bobsled_evidence: [] }],
    [
      'undeclared source',
      {
        _bobsled_evidence: [
          {
            source: 'secret',
            reference: 'record:1',
            support_excerpt: null,
            retrieved_at: '2026-09-11T10:01:00Z',
          },
        ],
      },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      parseAgentAssignmentOutcome(
        AgentAssignmentSchema.parse(assignment()),
        result([{ ...finding(), ...patch }])
      )
    ).toThrow();
  });

  it('accepts non-web evidence without inventing an excerpt', () => {
    const row = {
      ...finding(),
      _bobsled_evidence: [
        {
          source: 'pairs',
          reference: 'record:pair-1',
          support_excerpt: null,
          retrieved_at: '2026-09-11T10:01:00Z',
        },
      ],
    };
    expect(
      parseAgentAssignmentOutcome(AgentAssignmentSchema.parse(assignment()), result([row]))
    ).toEqual(result([row]));
  });

  it('rejects duplicate findings at the output grain', () => {
    expect(() =>
      parseAgentAssignmentOutcome(
        AgentAssignmentSchema.parse(assignment()),
        result([finding(), finding()])
      )
    ).toThrow(/grain/);
  });

  it.each([
    [
      'foreign input',
      (work: ReturnType<typeof assignment>) => {
        work.input.rows[0]!.pair_id = 'foreign';
      },
    ],
    [
      'missing key',
      (work: ReturnType<typeof assignment>) => {
        work.output.replacement_keys = ['missing'];
      },
    ],
    [
      'nullable key',
      (work: ReturnType<typeof assignment>) => {
        work.output.columns[0]!.nullable = true;
      },
    ],
    [
      'invalid deadline',
      (work: ReturnType<typeof assignment>) => {
        work.limits.deadline_at = work.limits.started_at;
      },
    ],
    [
      'source access on direct calls',
      (work: ReturnType<typeof assignment>) => {
        Object.assign(work, { allowed_sources: ['web'] });
      },
    ],
  ])('returns a validation failure for %s', (_label, mutate) => {
    const work = assignment();
    mutate(work);
    expect(AgentAssignmentSchema.safeParse(work).success).toBe(false);
  });

  it('rejects missing completion and rows attached to a failure', () => {
    const work = AgentAssignmentSchema.parse(assignment());
    expect(() => parseAgentAssignmentOutcome(work, { rows: [] })).toThrow();
    expect(() => parseAgentAssignmentOutcome(work, { ...outcome('failure'), rows: [] })).toThrow();
  });
});

it('preserves evidence from earlier findings without granting source access', () => {
  const citation = {
    source: 'public_search',
    reference: 'document:1',
    support_excerpt: null,
    retrieved_at: '2026-09-11T10:01:00Z',
  };
  const work = assignment();
  work.input.columns.push({ name: '_bobsled_evidence', type: 'array', nullable: true });
  Object.assign(work.input.rows[0]!, { _bobsled_evidence: [citation] });
  const result = {
    ...outcome('success-empty'),
    rows: [
      {
        pair_id: 'pair-1',
        assessment: 'uncertain',
        _bobsled_evidence: [citation],
        _bobsled_confidence: null,
        _bobsled_reason: null,
      },
    ],
  };
  expect(parseAgentAssignmentOutcome(AgentAssignmentSchema.parse(work), result).status).toBe(
    'succeeded'
  );
  expect(work.allowed_sources).toEqual([]);
});

it('accepts a completed empty input group with independent processed keys', () => {
  const work = assignment();
  work.input.rows = [];
  expect(
    parseAgentAssignmentOutcome(AgentAssignmentSchema.parse(work), outcome('success-empty')).status
  ).toBe('succeeded');
});

it('reports invalid input metadata as a schema failure', () => {
  const work = assignment();
  work.input.columns.push({ name: '_bobsled_run_id', type: 'number', nullable: true });
  expect(AgentAssignmentSchema.safeParse(work).success).toBe(false);
});

describe('host-owned evidence time', () => {
  it('rejects a valid-looking date that differs from the saved input time', () => {
    const original = assignment();
    const retrievedAt = '2026-09-13T11:00:00.000Z';
    const work = AgentAssignmentSchema.parse({
      ...original,
      input: { ...original.input, retrieved_at: retrievedAt },
    });
    const reply = (date: string) => ({
      ...outcome('success-empty'),
      rows: [
        {
          pair_id: 'pair-1',
          assessment: 'uncertain',
          _bobsled_evidence: [
            {
              source: work.input.ref,
              reference: 'pair-1',
              support_excerpt: null,
              retrieved_at: date,
            },
          ],
          _bobsled_confidence: null,
          _bobsled_reason: null,
        },
      ],
    });
    expect(() => parseAgentAssignmentOutcome(work, reply('2024-06-01T00:00:00Z'))).toThrow(
      'Evidence retrieval time must match the prepared input'
    );
    expect(parseAgentAssignmentOutcome(work, reply(retrievedAt)).status).toBe('succeeded');
  });
});

const namedWork = () => {
  const base = assignment();
  return {
    ...base,
    inputs: {
      pairs: { ...base.input, complete: true, processed_keys: base.processed_keys },
      phone: {
        ref: 'phone',
        retrieved_at: '2026-09-13T11:00:00.000Z',
        columns: base.input.columns,
        rows: [],
        complete: true,
        processed_keys: base.processed_keys,
      },
    },
  };
};

it('accepts complete-empty named input and preserves its identity', () => {
  const work = AgentAssignmentSchema.parse(namedWork());
  expect(work.inputs!.phone!.rows).toEqual([]);
  expect(work.inputs!.phone!.complete).toBe(true);
});

it.each(['incomplete', 'foreign_keys', 'foreign_rows', 'primary_mismatch'])(
  'rejects invalid named input: %s',
  (kind) => {
    const work = namedWork();
    if (kind === 'incomplete') work.inputs.phone.complete = false;
    if (kind === 'foreign_keys') work.inputs.phone.processed_keys = [{ pair_id: 'other' }];
    if (kind === 'foreign_rows') Object.assign(work.inputs.phone, { rows: [{ pair_id: 'other' }] });
    if (kind === 'primary_mismatch') work.inputs.pairs = { ...work.inputs.pairs, rows: [] };
    expect(AgentAssignmentSchema.safeParse(work).success).toBe(false);
  }
);

it('accepts named input evidence and checks its host timestamp', () => {
  const work = AgentAssignmentSchema.parse(namedWork());
  const reply = {
    ...outcome('success-empty'),
    rows: [
      {
        pair_id: 'pair-1',
        assessment: 'uncertain',
        _bobsled_confidence: null,
        _bobsled_reason: null,
        _bobsled_evidence: [
          {
            source: 'phone',
            reference: 'pair-1',
            support_excerpt: null,
            retrieved_at: work.inputs!.phone!.retrieved_at,
          },
        ],
      },
    ],
  };
  expect(parseAgentAssignmentOutcome(work, reply).status).toBe('succeeded');
  reply.rows[0]!._bobsled_evidence[0]!.retrieved_at = '2020-01-01T00:00:00Z';
  expect(() => parseAgentAssignmentOutcome(work, reply)).toThrow(/retrieval time/);
});
