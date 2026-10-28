import { describe, expect, it } from 'vitest';

import { generateSelectSql } from '../../../src/compiler/codegen.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type { ResolvedTransformSpec } from '../../../src/compiler/parser.js';

const NATIVE: readonly SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'duckdb',
  'redshift',
  'databricks',
];
const EMULATED: readonly SupportedDialect[] = ['postgres', 'pgvector', 'mysql'];

const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec =>
  ({
    name: 'latest_event',
    description: 'Latest event per user.',
    grain: 'user_id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_events',
    source: { fqTableName: 'RAW.RAW_EVENTS', alias: 't0' },
    joins: [],
    columns: [
      { name: 'user_id', expr: 'user_id' },
      { name: 'status', expr: 'status' },
    ],
    materialization: 'view',
    ...overrides,
  }) as ResolvedTransformSpec;

const LATEST = 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1';

describe('QUALIFY on targets that have the clause', () => {
  it('emits the clause directly', () => {
    for (const dialect of NATIVE) {
      const sql = generateSelectSql(makeSpec({ qualify: LATEST }), dialect);
      expect(sql, dialect).toMatch(/\bQUALIFY\b/i);
      expect(sql, dialect).not.toContain('__bms_qualify_0');
    }
  });

  it('still allows include_all_columns', () => {
    const sql = generateSelectSql(
      makeSpec({ qualify: LATEST, includeAllColumns: true, columns: [] }),
      'snowflake'
    );
    expect(sql).toMatch(/SELECT \*/);
  });
});

describe('QUALIFY emulation', () => {
  it('hoists the window expression and filters it from a wrapping subquery', () => {
    for (const dialect of EMULATED) {
      const sql = generateSelectSql(makeSpec({ qualify: LATEST }), dialect);
      expect(sql, dialect).not.toMatch(/\bQUALIFY\b/i);
      expect(sql, dialect).toContain('AS __bms_qualify_0');
      expect(sql, dialect).toContain('WHERE __bms_qualify_0 = 1');
    }
  });

  it('computes the window inside the original SELECT, so it still reads unprojected columns', () => {
    // `created_at` is not an output column. Computing the window one level out
    // would leave it out of scope and silently change which row survives.
    const sql = generateSelectSql(makeSpec({ qualify: LATEST }), 'postgres');
    const inner = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(') AS __bms_qualified'));
    expect(inner).toContain('created_at');
  });

  it('projects exactly the declared columns, not the helper', () => {
    const sql = generateSelectSql(makeSpec({ qualify: LATEST }), 'postgres');
    expect(sql.slice(0, sql.indexOf('FROM'))).toBe('SELECT user_id, status ');
  });

  it('gives each window function in the predicate its own alias', () => {
    const sql = generateSelectSql(
      makeSpec({
        qualify:
          'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1 AND ' +
          'COUNT(*) OVER (PARTITION BY user_id) > 1',
      }),
      'postgres'
    );
    expect(sql).toContain('AS __bms_qualify_0');
    expect(sql).toContain('AS __bms_qualify_1');
    expect(sql).toMatch(/WHERE __bms_qualify_0 = 1 AND __bms_qualify_1 > 1/);
  });

  it('wraps without hoisting when the predicate names a windowed column alias', () => {
    // `qualify: rn = 1` over a windowed output column is a normal pattern, and a
    // select alias is not visible to WHERE, so the wrap alone does the work.
    const sql = generateSelectSql(
      makeSpec({
        columns: [
          { name: 'user_id', expr: 'user_id' },
          { name: 'rn', expr: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC)' },
        ],
        qualify: 'rn = 1',
      }),
      'postgres'
    );
    expect(sql).not.toContain('__bms_qualify_0');
    expect(sql).toContain('AS __bms_qualified WHERE rn = 1');
  });

  it('resolves a named window declared on the model', () => {
    const sql = generateSelectSql(
      makeSpec({
        windows: [
          {
            name: 'w',
            partitionBy: ['user_id'],
            orderBy: [{ column: 'created_at', direction: 'desc' }],
          },
        ],
        qualify: 'ROW_NUMBER() OVER w = 1',
      }),
      'postgres'
    );
    expect(sql).toContain('WINDOW w AS (');
    expect(sql).toContain('ROW_NUMBER() OVER w AS __bms_qualify_0');
  });

  it('keeps ORDER BY and LIMIT outside the wrap, where they apply to the filtered rows', () => {
    const sql = generateSelectSql(
      makeSpec({
        qualify: LATEST,
        orderBy: [{ column: 'user_id', direction: 'asc' }],
        limit: 5,
      }),
      'postgres'
    );
    const wrapEnd = sql.indexOf('AS __bms_qualified');
    expect(sql.indexOf('ORDER BY user_id')).toBeGreaterThan(wrapEnd);
    expect(sql.indexOf('LIMIT 5')).toBeGreaterThan(wrapEnd);
  });

  it('refuses include_all_columns, which would return the helper column', () => {
    expect(() =>
      generateSelectSql(
        makeSpec({ qualify: LATEST, includeAllColumns: true, columns: [] }),
        'postgres'
      )
    ).toThrow(/include_all_columns/);
  });

  it('refuses a predicate the parser cannot see into', () => {
    expect(() =>
      generateSelectSql(
        makeSpec({ qualify: 'raw_sql(ROW_NUMBER() OVER (PARTITION BY user_id) = 1)' }),
        'postgres'
      )
    ).toThrow(/opaque to the expression parser/);
  });

  it('composes with a CTE, which stays visible inside the wrap', () => {
    const cteMap = new Map([['RAW.RAW_EVENTS', 'SELECT 1 AS user_id, 1 AS created_at']]);
    const sql = generateSelectSql(makeSpec({ qualify: LATEST }), 'postgres', cteMap);
    expect(sql).toMatch(/^WITH /);
    expect(sql.indexOf('WITH ')).toBeLessThan(sql.indexOf('__bms_qualified'));
  });
});

describe('dedupe', () => {
  const DEDUPE = {
    keys: ['user_id'],
    strategy: 'keep_first',
    order_by: [{ column: 'created_at', direction: 'desc' }],
  };

  it('emits QUALIFY ROW_NUMBER natively', () => {
    const sql = generateSelectSql(makeSpec({ dedupe: DEDUPE } as never), 'snowflake');
    expect(sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY USER_ID/i);
  });

  it('works on targets without QUALIFY, where it previously could not compile', () => {
    for (const dialect of EMULATED) {
      const sql = generateSelectSql(makeSpec({ dedupe: DEDUPE } as never), dialect);
      expect(sql, dialect).toContain('ROW_NUMBER() OVER (PARTITION BY user_id');
      expect(sql, dialect).toContain('WHERE __bms_qualify_0 = 1');
    }
  });

  it('inverts the ordering for keep_last on both paths', () => {
    const spec = makeSpec({
      dedupe: {
        keys: ['user_id'],
        strategy: 'keep_last',
        order_by: [{ column: 'created_at', direction: 'asc' }],
      },
    } as never);
    expect(generateSelectSql(spec, 'snowflake')).toMatch(/ORDER BY CREATED_AT DESC/i);
    expect(generateSelectSql(spec, 'postgres')).toMatch(/ORDER BY created_at DESC/i);
  });

  it('carries explicit null placement into the emulated form', () => {
    const sql = generateSelectSql(
      makeSpec({
        dedupe: {
          keys: ['user_id'],
          strategy: 'keep_first',
          order_by: [{ column: 'created_at', direction: 'desc', nulls: 'last' }],
        },
      } as never),
      'postgres'
    );
    expect(sql).toContain('NULLS LAST');
  });

  it('still rejects declaring both qualify and dedupe', () => {
    expect(() =>
      generateSelectSql(makeSpec({ qualify: LATEST, dedupe: DEDUPE } as never), 'postgres')
    ).toThrow(/cannot set both/);
  });
});

describe('emulation composes with the rest of the model', () => {
  it('keeps the hoisted helper out of set-operation branches', () => {
    // Branch arms render from the declared column list. Rendering them from the
    // augmented list gave every arm after the first an extra column, so the
    // UNION had mismatched arity and the warehouse rejected it at run time.
    const sql = generateSelectSql(
      makeSpec({
        qualify: LATEST,
        union: [
          {
            ref: 'other',
            fqTableName: 'RAW.OTHER',
            operation: 'union_all',
            columns: [
              { name: 'user_id', expr: 'user_id' },
              { name: 'status', expr: 'status' },
            ],
          },
        ],
      } as Partial<ResolvedTransformSpec>),
      'postgres'
    );
    const branch = sql.slice(sql.indexOf('UNION ALL'));
    expect(branch).not.toContain('__bms_qualify_0');
    expect(sql.match(/__bms_qualify_0/g)).toHaveLength(2);
  });

  it('spells a mixed-case column the same way on both sides of the wrap', () => {
    // The inner SELECT quotes a mixed-case alias; case-folding it in the outer
    // projection left it referencing a column that does not exist.
    const sql = generateSelectSql(
      makeSpec({ columns: [{ name: 'userId', expr: 'user_id' }], qualify: LATEST }),
      'postgres'
    );
    expect(sql).toContain('AS "userId"');
    expect(sql).toMatch(/^SELECT "userId" FROM/);
  });

  it('quotes a reserved-word column consistently', () => {
    const sql = generateSelectSql(
      makeSpec({ columns: [{ name: 'order', expr: 'user_id' }], qualify: LATEST }),
      'postgres'
    );
    expect(sql).toMatch(/^SELECT "order" FROM/);
  });

  it('applies DISTINCT on the wrap, where SQL applies it relative to QUALIFY', () => {
    // Left on the inner SELECT it would deduplicate on the hoisted predicate
    // column too, so rows differing only in row number survive.
    const sql = generateSelectSql(
      makeSpec({
        columns: [{ name: 'status', expr: 'status' }],
        distinct: true,
        qualify: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) <= 2',
      }),
      'postgres'
    );
    expect(sql).toMatch(/^SELECT DISTINCT status FROM \(SELECT status/);
    expect(sql).not.toMatch(/SELECT DISTINCT status AS status/);
  });
});

describe('clause position is unchanged for models that use neither new operator', () => {
  const withUnion = (extra: Partial<ResolvedTransformSpec>): ResolvedTransformSpec =>
    makeSpec({
      columns: [{ name: 'user_id', expr: 'user_id' }],
      union: [
        {
          ref: 'other',
          fqTableName: 'RAW.OTHER',
          operation: 'union_all',
          columns: [{ name: 'user_id', expr: 'user_id' }],
        },
      ],
      ...extra,
    } as Partial<ResolvedTransformSpec>);

  it('keeps ORDER BY and LIMIT where they have always been relative to a union', () => {
    // Collecting these into a deferred suffix for recursion moved them across
    // the union, pivot and unpivot steps and changed what existing models
    // emitted. Only a recursive model defers them now.
    const sql = generateSelectSql(
      withUnion({ orderBy: [{ column: 'user_id', direction: 'asc' }], limit: 5 }),
      'duckdb'
    );
    expect(sql.indexOf('ORDER BY')).toBeLessThan(sql.indexOf('UNION'));
    expect(sql.indexOf('LIMIT')).toBeLessThan(sql.indexOf('UNION'));
  });

  it('keeps OFFSET with LIMIT', () => {
    const sql = generateSelectSql(withUnion({ limit: 5, offset: 10 }), 'duckdb');
    expect(sql).toMatch(/LIMIT 5 OFFSET 10 UNION ALL/);
  });

  it('keeps LIMIT ahead of a pivot, so the pivot sees the limited rows', () => {
    const sql = generateSelectSql(
      makeSpec({
        columns: [{ name: 'user_id', expr: 'user_id' }],
        limit: 10,
        pivot: {
          column: 'status',
          values: ['a', 'b'],
          aggregate: 'count',
          value_column: 'user_id',
        },
      } as Partial<ResolvedTransformSpec>),
      'duckdb'
    );
    expect(sql.indexOf('LIMIT 10')).toBeLessThan(sql.indexOf('PIVOT'));
  });

  it('keeps LIMIT ahead of an unpivot', () => {
    const sql = generateSelectSql(
      makeSpec({
        columns: [{ name: 'user_id', expr: 'user_id' }],
        limit: 10,
        unpivot: { columns: ['user_id'], field_name: 'k', value_name: 'v' },
      } as Partial<ResolvedTransformSpec>),
      'duckdb'
    );
    expect(sql.indexOf('LIMIT 10')).toBeLessThan(sql.indexOf('UNPIVOT'));
  });
});
