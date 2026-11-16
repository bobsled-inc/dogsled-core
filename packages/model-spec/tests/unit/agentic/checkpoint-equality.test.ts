import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isExactJson, jsonEqual } from '../../../src/agentic/json-equal.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import {
  AgentAssignmentSchema,
  parseAgentAssignmentOutcome,
  parseAttemptOutcome,
} from '../../../src/agentic/assignment.js';
import {
  AGENTIC_MAX_BYTES,
  AgenticJudgmentSchema,
  createAgenticRowSchema,
  isBoundedAgenticJson,
} from '../../../src/agentic/rows.js';
import { AgenticColumnsSchema, type AgenticColumn } from '../../../src/agentic/model.js';
import { assignment } from './fixtures.js';

const result = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
};

describe('canonical JSON equality', () => {
  const shared = { rows: [{ id: 'a', values: [1, 2] }] };
  const holes = [1, , 3];
  const pairs: [unknown, unknown][] = [
    [
      { a: 1, b: [1, 2] },
      { b: [1, 2], a: 1 },
    ],
    [{ a: undefined, b: 1 }, { b: 1 }],
    [
      [1, undefined],
      [1, null],
    ],
    [holes, [1, 3]],
    [holes, [1, null, 3]],
    [
      { toJSON: 5, a: 1 },
      { a: 1, toJSON: 5 },
    ],
    [new Date(0), '1970-01-01T00:00:00.000Z'],
    [0, -0],
    [null, undefined],
    [1, '1'],
    [{ a: { b: [{ c: 'x' }] } }, { a: { b: [{ c: 'y' }] } }],
    [{ x: shared }, { x: shared }],
    [
      { x: shared, y: 1 },
      { x: structuredClone(shared), y: 1 },
    ],
    [{ x: shared }, { x: { rows: [{ id: 'a', values: [1, 2, 3] }] } }],
    [[], {}],
    [Object.create(null), {}],
    [{ a: 1, b: 2 }, Object.defineProperty({ a: 1, c: 3 }, 'b', { value: 2, enumerable: false })],
  ];
  it.each(pairs.map((pair, index) => [index, ...pair]))(
    'agrees with digest comparison (case %s)',
    (_index, left, right) => {
      const digests = digestAgenticState(left) === digestAgenticState(right);
      expect(jsonEqual(left, right)).toBe(digests);
      expect(jsonEqual(right, left)).toBe(digests);
    }
  );
});

describe('attempt outcome validation for a parsed assignment', () => {
  const work = AgentAssignmentSchema.parse(assignment());
  const outcome = (attempt_id: string, rows: unknown[] = [row()]) => ({
    contract_version: 2,
    attempt_id,
    status: 'succeeded',
    usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    rows,
  });
  const row = (pair_id = 'pair-1') => ({
    pair_id,
    assessment: 'Synthetic assessment.',
    _bobsled_evidence: null,
    _bobsled_confidence: null,
    _bobsled_reason: null,
  });
  const ids = ['attempt-2', '  attempt-2 ', '   ', '', 'x'.repeat(1024), 'x'.repeat(1025)];
  it.each(ids)('matches revalidating the whole assignment (attempt %#)', (attemptId) => {
    for (const value of [
      outcome(attemptId.trim()),
      outcome(attemptId),
      outcome('another-attempt'),
      outcome(attemptId.trim(), [row('outside')]),
      { status: 'succeeded' },
    ]) {
      expect(result(() => parseAttemptOutcome(work, attemptId, value))).toEqual(
        result(() => parseAgentAssignmentOutcome({ ...work, attempt_id: attemptId }, value))
      );
    }
  });
  it('checks the bounded total that a longer attempt ID can exceed', () => {
    const columns = [
      ...work.input.columns,
      { name: 'note', type: 'string' as const, nullable: false },
    ];
    const base = {
      ...work,
      input: { ...work.input, columns, rows: [{ pair_id: 'pair-1', note: '' }] },
    };
    const room = AGENTIC_MAX_BYTES - Buffer.byteLength(JSON.stringify(base)) - 8;
    const large = AgentAssignmentSchema.parse({
      ...base,
      input: { ...base.input, rows: [{ pair_id: 'pair-1', note: 'n'.repeat(room) }] },
    });
    const long = 'a'.repeat(1024);
    expect(isBoundedAgenticJson({ ...large, attempt_id: long })).toBe(false);
    const expected = result(() =>
      parseAgentAssignmentOutcome({ ...large, attempt_id: long }, outcome(long))
    );
    expect(expected.error).toMatch(/^ZodError/);
    expect(result(() => parseAttemptOutcome(large, long, outcome(long)))).toEqual(expected);
  });
});

/** Row schema construction before shared fields, kept to compare exported JSON Schema. */
function previousRowSchema(columns: readonly AgenticColumn[], findings: boolean) {
  const scalar: Record<AgenticColumn['type'], z.ZodType> = {
    string: z.string(),
    integer: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    number: z.number(),
    boolean: z.boolean(),
    timestamp: z.iso.datetime({ offset: true }),
    date: z.iso.date(),
    array: z.array(z.json()),
    object: z.record(z.string(), z.json()),
  };
  const metadata: Record<string, z.ZodType> = AgenticJudgmentSchema.shape;
  const shape: Record<string, z.ZodType> = {};
  for (const column of AgenticColumnsSchema.parse(columns)) {
    const schema = Object.hasOwn(metadata, column.name)
      ? metadata[column.name]!
      : scalar[column.type];
    shape[column.name] = column.nullable ? schema.nullable() : schema;
  }
  if (findings) Object.assign(shape, AgenticJudgmentSchema.shape);
  return z
    .unknown()
    .refine((value): boolean => isBoundedAgenticJson(value), {
      message: 'Expected bounded JSON data',
      abort: true,
    })
    .pipe(z.object(shape).strict());
}

describe('shared row field schemas', () => {
  it('exports the same JSON Schema as rows built with their own fields', () => {
    const columns: AgenticColumn[] = [
      { name: 'id', type: 'string', nullable: false },
      { name: 'tags', type: 'array', nullable: false },
      { name: 'extra', type: 'array', nullable: true },
      { name: 'attributes', type: 'object', nullable: true },
      { name: 'score', type: 'number', nullable: true },
      { name: '_bobsled_reason', type: 'object', nullable: true },
    ];
    for (const findings of [false, true]) {
      expect(JSON.stringify(createAgenticRowSchema(columns, findings).toJSONSchema())).toBe(
        JSON.stringify(previousRowSchema(columns, findings).toJSONSchema())
      );
    }
  });
  const columns = [
    { name: 'id', type: 'string' as const, nullable: false },
    { name: 'count', type: 'integer' as const, nullable: true },
    { name: 'at', type: 'timestamp' as const, nullable: false },
    { name: 'tags', type: 'array' as const, nullable: true },
    { name: '_bobsled_reason', type: 'object' as const, nullable: true },
  ];
  const rows = [
    { id: 'a', count: 1, at: '2026-01-01T00:00:00Z', tags: ['x'], _bobsled_reason: null },
    { id: 'a', count: null, at: '2026-01-01T00:00:00Z', tags: null, _bobsled_reason: null },
    { id: 'a', count: 1.5, at: '2026-01-01T00:00:00Z', tags: [], _bobsled_reason: null },
    { id: 'a', count: 1, at: 'yesterday', tags: [], _bobsled_reason: null },
    { id: 'a', count: 1, at: '2026-01-01T00:00:00Z', tags: [], _bobsled_reason: { summary: '' } },
    { id: 'a', count: 1, at: '2026-01-01T00:00:00Z', tags: [], _bobsled_reason: null, extra: 1 },
  ];
  it('validates rows identically across schemas and parse modes', () => {
    const first = createAgenticRowSchema(columns);
    const second = createAgenticRowSchema(columns);
    expect(first).not.toBe(second);
    expect(rows.map((value) => first.safeParse(value).success)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    for (const value of rows) {
      const expected = first.safeParse(value);
      expect(second.safeParse(value, { jitless: true })).toEqual(expected);
    }
  });
});

describe('isExactJson', () => {
  const shared = Object.freeze({ a: [1, { b: 2 }] });
  // Scrutiny aside, both modes must tell different JSON apart.
  it.each([false, true])('tells different JSON apart with plain %s', (plain) => {
    const same: [unknown, unknown][] = [
      [1, 1],
      ['a', 'a'],
      [null, null],
      [{}, {}],
      [[], []],
      [
        { a: 1, b: [2] },
        { b: [2], a: 1 },
      ],
      [shared, shared],
      [{ x: shared }, { x: shared }],
    ];
    for (const [left, right] of same) expect(isExactJson(left, right, plain)).toBe(true);
    const different: [unknown, unknown][] = [
      [1, 2],
      [1, '1'],
      [null, 0],
      [null, {}],
      [{}, null],
      [{}, []],
      [[], {}],
      [{ 0: 1 }, [1]],
      [[1], { 0: 1 }],
      [[1], [1, 2]],
      [[1, 2], [1]],
      [
        [1, 2],
        [1, 3],
      ],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ a: 1 }, { b: 1 }],
      [{ a: { b: 1 } }, { a: { b: 2 } }],
    ];
    for (const [left, right] of different) expect(isExactJson(left, right, plain)).toBe(false);
  });

  it('refuses a value that is not plain JSON unless told it is', () => {
    class Point {
      x = 1;
    }
    class List extends Array {}
    const hidden = Object.defineProperty({ x: 1 }, 'toJSON', { value: () => ({ x: 2 }) });
    const symbol = { x: 1, [Symbol('extra')]: 2 };
    const list = Object.assign([1], { extra: 2 });
    for (const [expected, value] of [
      [{ x: 1 }, new Point()],
      [{ x: 1 }, Object.assign(Object.create(null), { x: 1 })],
      [{ x: 1 }, hidden],
      [{ x: 1 }, symbol],
      [[1], List.from([1])],
      [[1], list],
    ] as const) {
      expect(isExactJson(expected, value)).toBe(false);
    }
  });
});
