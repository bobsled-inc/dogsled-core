import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { generateSelectSql } from '../../../src/compiler/codegen.js';
import { buildDag } from '../../../src/compiler/dag.js';
import { parseTransformSpecFromParsed } from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';

const REGISTRY = new Map([
  ['example.raw_companies', 'raw.raw_companies'],
  ['example.raw_edges', 'raw.raw_edges'],
]) as never;

const BASE = {
  spec_version: '0.2' as const,
  name: 'company_tree',
  type: 'model' as const,
  description: 'Corporate hierarchy.',
  grain: 'company_id',
  source: { ref: 'example.raw_companies' },
  columns: [
    { name: 'company_id', expr: 'company_id' },
    { name: 'company_name', expr: 'name' },
  ],
  materialization: { type: 'view' as const },
};

const HIERARCHY = {
  parent_key: 'parent_id',
  child_key: 'company_id',
  max_depth: 20,
};

const parse = (extra: Record<string, unknown>) =>
  TransformSpecSchema.safeParse({ ...BASE, ...extra });

const compile = (extra: Record<string, unknown>, dialect: SupportedDialect = 'duckdb'): string => {
  const parsed = parse(extra);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  const resolved = parseTransformSpecFromParsed(parsed.data, REGISTRY);
  if (!resolved.ok) throw new Error(resolved.error);
  return generateSelectSql(resolved.spec, dialect);
};

const errorsFor = (extra: Record<string, unknown>): string => {
  const parsed = parse(extra);
  if (parsed.success) return '';
  return parsed.error.issues.map((i) => i.message).join(' | ');
};

const RECURSE = {
  max_depth: 10,
  step: {
    source: { join_on: 'source.parent_id = prior.company_id' },
    columns: [
      { name: 'company_id', expr: 'company_id' },
      { name: 'company_name', expr: 'name' },
    ],
  },
};

describe('recurse: compiled shape', () => {
  it('wraps the model in a recursive CTE seeded by its own SELECT', () => {
    const sql = compile({
      where: 'parent_id IS NULL',
      recurse: {
        ...RECURSE,
        step: {
          ...RECURSE.step,
          columns: [
            { name: 'company_id', expr: 'company_id' },
            { name: 'company_name', expr: 'prior.company_name' },
          ],
        },
      },
    });
    expect(sql).toMatch(/^WITH RECURSIVE/);
    expect(sql).toContain('UNION ALL');
    // The anchor is the model's own SELECT, filter included.
    expect(sql).toContain('parent_id IS NULL');
  });

  it('emits UNION ALL, which is the only form Snowflake accepts between the clauses', () => {
    const sql = compile(
      { recurse: recurseTouchingPrior(), where: 'parent_id IS NULL' },
      'snowflake'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).not.toMatch(/UNION(?!\s+ALL)/);
  });

  it('bounds the walk with the declared depth', () => {
    const sql = compile({ recurse: { ...recurseTouchingPrior(), max_depth: 7 } });
    expect(sql).toMatch(/__bms_depth\s*<\s*7/i);
  });

  it('rewrites the authoring aliases onto names no dialect reserves', () => {
    const sql = compile({ recurse: recurseTouchingPrior() });
    // `PRIOR` is Oracle's hierarchical-query keyword and parsers reject it in a
    // qualified reference, so it must not reach the emitted SQL.
    expect(sql).not.toMatch(/\bAS prior\b/i);
    expect(sql).toContain('__bms_prior');
    expect(sql).toContain('__bms_source');
  });

  it('projects step columns in the order the model declares them', () => {
    const sql = compile({
      recurse: {
        max_depth: 5,
        step: {
          source: { join_on: 'source.parent_id = prior.company_id' },
          // Declared in reverse; a set operation matches by position, so codegen
          // must reorder these rather than trust the author's ordering.
          columns: [
            { name: 'company_name', expr: 'prior.company_name' },
            { name: 'company_id', expr: 'company_id' },
          ],
        },
      },
    });
    const step = sql.split('UNION ALL')[1] ?? '';
    expect(step.indexOf('AS company_id')).toBeLessThan(step.indexOf('AS company_name'));
  });

  it('resolves an unqualified step column against the joined row', () => {
    const sql = compile({ recurse: recurseTouchingPrior() });
    expect(sql).toContain('__bms_source.company_id');
  });

  it('applies ORDER BY and LIMIT to the closure, not to the seed rows', () => {
    const sql = compile({
      recurse: recurseTouchingPrior(),
      order_by: [{ column: 'company_id', direction: 'asc' }],
      limit: 10,
    });
    const cteEnd = sql.lastIndexOf(') SELECT');
    expect(sql.indexOf('ORDER BY')).toBeGreaterThan(cteEnd);
    expect(sql.indexOf('LIMIT')).toBeGreaterThan(cteEnd);
  });

  it('joins an explicitly named step source', () => {
    const sql = compile({
      recurse: {
        max_depth: 5,
        step: {
          source: { ref: 'example.raw_edges', join_on: 'source.parent_id = prior.company_id' },
          columns: [
            { name: 'company_id', expr: 'company_id' },
            { name: 'company_name', expr: 'prior.company_name' },
          ],
        },
      },
    });
    expect(sql).toContain('raw.raw_edges');
  });
});

describe('recurse: dialect coverage', () => {
  const SUPPORTED: readonly SupportedDialect[] = [
    'snowflake',
    'bigquery',
    'postgres',
    'duckdb',
    'redshift',
    'mysql',
  ];

  it('compiles on every target that has WITH RECURSIVE', () => {
    for (const dialect of SUPPORTED) {
      expect(() => compile({ recurse: recurseTouchingPrior() }, dialect), dialect).not.toThrow();
    }
  });

  it('refuses a target without WITH RECURSIVE instead of emitting SQL it rejects', () => {
    expect(() => compile({ recurse: recurseTouchingPrior() }, 'databricks')).toThrow(
      /\[unsupported_feature:recursiveCte\]/
    );
  });

  it('concatenates with CONCAT on MySQL, where a pipe is logical OR', () => {
    const sql = compile({ hierarchy: { ...HIERARCHY, emit: { path: 'id_path' } } }, 'mysql');
    expect(sql).toContain('CONCAT(');
    expect(sql).toContain('CAST(');
    expect(sql).not.toMatch(/'\/' \|\|/);
  });

  it("casts to each target's own text type", () => {
    const cases: ReadonlyArray<readonly [SupportedDialect, RegExp]> = [
      ['bigquery', /AS STRING\)/],
      ['mysql', /AS CHAR\)/],
      ['snowflake', /AS VARCHAR\)/],
    ];
    for (const [dialect, pattern] of cases) {
      const sql = compile({ hierarchy: { ...HIERARCHY, emit: { path: 'id_path' } } }, dialect);
      expect(sql, dialect).toMatch(pattern);
    }
  });
});

describe('hierarchy: sugar over recurse', () => {
  it('seeds from parentless rows by default', () => {
    const sql = compile({ hierarchy: HIERARCHY });
    expect(sql).toMatch(/parent_id IS NULL/i);
  });

  it('seeds every row for a cycle audit, because a cycle has no parentless row', () => {
    const sql = compile({
      hierarchy: { ...HIERARCHY, seed: 'all_nodes', emit: { cycle: 'is_cycle' } },
    });
    expect(sql).not.toMatch(/parent_id IS NULL/i);
    expect(sql).toContain('is_cycle');
  });

  it('surfaces root, depth and path under author-chosen names', () => {
    const sql = compile({
      hierarchy: { ...HIERARCHY, emit: { root: 'root_id', depth: 'level', path: 'id_path' } },
    });
    expect(sql).toContain('AS root_id');
    expect(sql).toMatch(/__bms_depth AS level/i);
    expect(sql).toMatch(/__bms_path AS id_path/i);
  });

  it('builds the path even when no cycle flag is requested', () => {
    const sql = compile({ hierarchy: { ...HIERARCHY, emit: { path: 'id_path' } } });
    expect(sql).toContain('__bms_path');
  });

  it('delimits both sides of a key so one id cannot match inside another', () => {
    // Without the trailing delimiter `/5/` matches inside `/51/` and the walk
    // reports a cycle that does not exist.
    const sql = compile({
      hierarchy: { ...HIERARCHY, seed: 'all_nodes', emit: { cycle: 'is_cycle' } },
    });
    expect(sql).toMatch(/'\/' \|\| CAST\([^)]*\) \|\| '\/'/);
  });

  it('stops extending a path once it closed a cycle', () => {
    const sql = compile({
      hierarchy: { ...HIERARCHY, seed: 'all_nodes', emit: { cycle: 'is_cycle' } },
    });
    expect(sql).toMatch(/is_cycle = FALSE/i);
  });

  it('joins on an internal key column, so author aliasing cannot break the walk', () => {
    const sql = compile({
      columns: [
        { name: 'renamed_id', expr: 'company_id' },
        { name: 'company_name', expr: 'name' },
      ],
      hierarchy: HIERARCHY,
    });
    expect(sql).toContain('__bms_node');
  });
});

describe('recursion validation', () => {
  it('requires the step to name exactly the model columns', () => {
    expect(
      errorsFor({
        recurse: {
          max_depth: 5,
          step: {
            source: { join_on: 'source.parent_id = prior.company_id' },
            columns: [{ name: 'company_id', expr: 'prior.company_id' }],
          },
        },
      })
    ).toMatch(/Missing: company_name/);
  });

  it('rejects a step that never reads the previous iteration', () => {
    expect(
      errorsFor({
        recurse: {
          max_depth: 5,
          step: {
            source: { join_on: 'source.parent_id = source.company_id' },
            columns: [
              { name: 'company_id', expr: 'company_id' },
              { name: 'company_name', expr: 'name' },
            ],
          },
        },
      })
    ).toMatch(/this is a join, not a recursion/);
  });

  it('requires a depth bound and keeps it finite', () => {
    expect(errorsFor({ recurse: { step: RECURSE.step } })).not.toBe('');
    expect(errorsFor({ recurse: { ...recurseTouchingPrior(), max_depth: 5000 } })).not.toBe('');
    expect(errorsFor({ recurse: { ...recurseTouchingPrior(), max_depth: 0 } })).not.toBe('');
  });

  it('rejects declaring both operators', () => {
    expect(errorsFor({ recurse: recurseTouchingPrior(), hierarchy: HIERARCHY })).toMatch(
      /mutually exclusive/
    );
  });

  it('rejects materializations the recursive CTE cannot carry', () => {
    for (const type of ['ephemeral', 'incremental'] as const) {
      expect(
        errorsFor({ hierarchy: HIERARCHY, materialization: { type, unique_key: 'company_id' } }),
        type
      ).toMatch(/materialization view or table/);
    }
  });

  it('rejects clauses that cannot compose with the recursive CTE', () => {
    expect(errorsFor({ hierarchy: HIERARCHY, distinct: true })).toMatch(/downstream model/);
    expect(errorsFor({ hierarchy: HIERARCHY, group_by: ['company_id'] })).toMatch(
      /downstream model/
    );
    expect(
      errorsFor({ hierarchy: HIERARCHY, qualify: 'ROW_NUMBER() OVER (ORDER BY company_id) = 1' })
    ).toMatch(/downstream model/);
  });

  it('rejects an emitted name that collides with a declared column', () => {
    expect(errorsFor({ hierarchy: { ...HIERARCHY, emit: { root: 'company_name' } } })).toMatch(
      /collides with an existing column/
    );
  });

  it('rejects a cycle key that is not an output column', () => {
    expect(
      errorsFor({
        recurse: { ...recurseTouchingPrior(), cycle: { on: 'not_a_column' } },
      })
    ).toMatch(/is not one of the model's columns/);
  });

  it('asks for a cycle flag when every row seeds a walk', () => {
    // all_nodes multiplies the work by the row count; a cycle audit is the only
    // thing that pays for it.
    expect(errorsFor({ hierarchy: { ...HIERARCHY, seed: 'all_nodes' } })).toMatch(
      /use seed: roots/
    );
  });
});

describe('folding a recursive model into a downstream query', () => {
  it('lifts RECURSIVE to the outer WITH instead of nesting it', () => {
    // An ephemeral upstream model arrives as raw SQL in the CTE map. When that
    // SQL is a recursive CTE, the keyword marks the whole WITH list, so hoisting
    // has to carry it up: a nested WITH inside a CTE body is legal in DuckDB and
    // Postgres but rejected by Snowflake and BigQuery.
    const cteMap = new Map([
      [
        'raw.raw_companies',
        'WITH RECURSIVE __r AS (SELECT 1 AS company_id UNION ALL SELECT company_id + 1 FROM __r WHERE company_id < 5) SELECT company_id, CAST(NULL AS VARCHAR) AS name FROM __r',
      ],
    ]);
    const parsed = parse({});
    if (!parsed.success) throw new Error('fixture failed to parse');
    const resolved = parseTransformSpecFromParsed(parsed.data, REGISTRY);
    if (!resolved.ok) throw new Error(resolved.error);
    const sql = generateSelectSql(resolved.spec, 'duckdb', cteMap);

    expect(sql).toMatch(/^WITH RECURSIVE/);
    expect(sql).toContain('__r');
    // Exactly one WITH: the inner one was hoisted, not left nested.
    expect(sql.match(/\bWITH\b/gi)?.length).toBe(1);
  });

  it('leaves a non-recursive fold alone', () => {
    const cteMap = new Map([['raw.raw_companies', 'SELECT 1 AS company_id, NULL AS name']]);
    const parsed = parse({});
    if (!parsed.success) throw new Error('fixture failed to parse');
    const resolved = parseTransformSpecFromParsed(parsed.data, REGISTRY);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(generateSelectSql(resolved.spec, 'duckdb', cteMap)).not.toMatch(/WITH RECURSIVE/);
  });
});

describe('column naming across the union inside the CTE', () => {
  // The anchor is `SELECT __anchor.*` over the model's own SELECT, whose aliases
  // are quoted rather than case-folded for a mixed-case or reserved name. A
  // UNION takes its names from the first branch, so the step and the outer
  // projection have to spell them the same way or the outer stops resolving.
  it('quotes a mixed-case column identically in the step and the projection', () => {
    const sql = compile(
      {
        columns: [{ name: 'companyId', expr: 'company_id' }],
        hierarchy: { ...HIERARCHY, emit: { depth: 'lvl' } },
      },
      'postgres'
    );
    expect(sql.match(/AS "companyId"/g)).toHaveLength(2);
    expect(sql).toMatch(/SELECT "companyId", __bms_depth AS lvl FROM/);
    expect(sql).not.toMatch(/\bcompanyid\b/);
  });

  it('quotes a reserved-word column identically', () => {
    const sql = compile(
      { columns: [{ name: 'order', expr: 'company_id' }], hierarchy: HIERARCHY },
      'snowflake'
    );
    expect(sql.match(/AS "ORDER"/g)).toHaveLength(2);
    expect(sql).toMatch(/SELECT "ORDER" FROM/);
  });

  it('quotes an emitted cycle column the same way', () => {
    const sql = compile(
      {
        hierarchy: { ...HIERARCHY, seed: 'all_nodes', emit: { cycle: 'isCycle' } },
      },
      'postgres'
    );
    expect(sql).toContain('AS "isCycle"');
    expect(sql).toContain('"isCycle" = FALSE');
  });
});

describe('reserved compiler namespace', () => {
  // Recursion adds depth, path and node columns and QUALIFY emulation adds a
  // hoisted predicate column, all alongside the model's own. A declared name in
  // that namespace produced a duplicate alias the warehouse resolves silently.
  it('rejects a declared column in the reserved namespace', () => {
    expect(
      errorsFor({
        columns: [
          { name: 'company_id', expr: 'company_id' },
          { name: '__bms_depth', expr: 'x' },
        ],
      })
    ).toMatch(/reserved "__bms_" prefix/);
  });

  it('rejects reserved names on every surface that reaches the output', () => {
    expect(errorsFor({ hierarchy: { ...HIERARCHY, emit: { depth: '__bms_path' } } })).toMatch(
      /reserved "__bms_" prefix/
    );
    expect(errorsFor({ windows: [{ name: '__bms_w', partition_by: ['parent_id'] }] })).toMatch(
      /reserved "__bms_" prefix/
    );
    expect(errorsFor({ derived_columns: [{ name: '__bms_x', expr: 'company_id * 2' }] })).toMatch(
      /reserved "__bms_" prefix/
    );
  });

  it('leaves ordinary names alone, including a single leading underscore', () => {
    expect(
      errorsFor({
        columns: [
          { name: 'company_id', expr: 'company_id' },
          { name: '_private', expr: 'x' },
          { name: 'depth', expr: 'y' },
        ],
      })
    ).toBe('');
  });
});

describe('recursion and the model DAG', () => {
  const writeProject = (specs: ReadonlyArray<Record<string, unknown>>): string[] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-model-spec-recursion-dag-'));
    return specs.map((spec) => {
      const filePath = path.join(dir, `${spec.name as string}.yml`);
      fs.writeFileSync(filePath, stringify(spec), 'utf-8');
      return filePath;
    });
  };

  it('does not treat a recursive model as a cycle', () => {
    // `prior` names the in-progress result, not a model, so the DAG stays
    // acyclic. Reaching for a self-referencing `source.ref` instead is what the
    // cycle check rejects, and why recursion belongs inside one model.
    const files = writeProject([{ ...BASE, hierarchy: HIERARCHY }]);
    const dag = buildDag(files);
    expect(dag.ok, dag.ok ? '' : dag.error).toBe(true);
    if (dag.ok) {
      expect(dag.order.find((n) => n.name === 'company_tree')?.refs ?? []).not.toContain(
        'company_tree'
      );
    }
  });

  it('records an explicitly named step source as a dependency', () => {
    const upstream = {
      spec_version: '0.2',
      name: 'edges',
      type: 'model',
      description: 'Edge list.',
      grain: 'company_id',
      source: { ref: 'example.raw_edges' },
      columns: [
        { name: 'company_id', expr: 'company_id' },
        { name: 'parent_id', expr: 'parent_id' },
      ],
      materialization: { type: 'view' },
    };
    const files = writeProject([
      upstream,
      {
        ...BASE,
        recurse: {
          max_depth: 5,
          step: {
            source: { ref: 'edges', join_on: 'source.parent_id = prior.company_id' },
            columns: [
              { name: 'company_id', expr: 'company_id' },
              { name: 'company_name', expr: 'prior.company_name' },
            ],
          },
        },
      },
    ]);
    const dag = buildDag(files);
    expect(dag.ok, dag.ok ? '' : dag.error).toBe(true);
    if (dag.ok) {
      expect(dag.order.find((n) => n.name === 'company_tree')?.refs).toContain('edges');
    }
  });
});

function recurseTouchingPrior() {
  return {
    max_depth: 10,
    step: {
      source: { join_on: 'source.parent_id = prior.company_id' },
      columns: [
        { name: 'company_id', expr: 'company_id' },
        { name: 'company_name', expr: 'prior.company_name' },
      ],
    },
  };
}
