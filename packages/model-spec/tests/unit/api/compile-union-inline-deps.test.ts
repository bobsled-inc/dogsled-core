import { describe, expect, it } from 'vitest';

import {
  compileInMemory,
  type CompileInMemoryOptions,
  type InMemoryModel,
} from '../../../src/api/compile-in-memory.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

function model(name: string, source: string, extra: Record<string, unknown> = {}): InMemoryModel {
  return {
    name,
    spec: TransformSpecSchema.parse({
      spec_version: '0.2',
      type: 'model',
      name,
      description: 'Synthetic source-only SQL model.',
      grain: 'id',
      source: { ref: source },
      columns: [{ name: 'id', expr: 't0.id', type: 'VARCHAR' }],
      materialization: { type: 'view' },
      ...extra,
    }),
  };
}

const directory = model('prepared_directory', 'example.directory');
const mentions = model('prepared_mentions', 'example.mentions');
const combined = model('combined_records', directory.name, {
  union: [{ ref: mentions.name, columns: [{ name: 'id', expr: 'id', type: 'VARCHAR' }] }],
});

function compile(
  models: InMemoryModel[] = [combined, mentions, directory],
  options: Partial<CompileInMemoryOptions> = {}
): string {
  const result = compileInMemory({
    models,
    sources: new Map([
      ['example.directory', 'EXAMPLE_DB.RAW.DIRECTORY'],
      ['example.mentions', 'EXAMPLE_DB.RAW.MENTIONS'],
    ]),
    dialect: 'snowflake',
    targetDatabase: 'EXAMPLE_DB',
    targetSchema: 'NEW_OUTPUT_SCHEMA',
    selectOnly: true,
    inlineDeps: true,
    ...options,
  });
  expect(result.ok, JSON.stringify(result.results)).toBe(true);
  const compiled = result.results.find((r) => r.modelName === 'combined_records');
  if (!compiled?.ok) throw new Error('Expected combined_records SELECT');
  return compiled.sql;
}

describe('UNION dependency inlining', () => {
  it('inlines both preparation models without referencing an uncreated output schema', () => {
    const sql = compile();
    expect(sql).toContain('__CTE_PREPARED_DIRECTORY AS (');
    expect(sql).toContain('__CTE_PREPARED_MENTIONS AS (');
    expect(sql).toMatch(/UNION ALL SELECT ID AS ID FROM __CTE_PREPARED_MENTIONS/);
    expect(sql).toContain('EXAMPLE_DB.RAW.DIRECTORY');
    expect(sql).toContain('EXAMPLE_DB.RAW.MENTIONS');
    expect(sql).not.toContain('NEW_OUTPUT_SCHEMA');
    expect(sql).not.toMatch(/\b(CREATE|INSERT|MERGE)\b/);
  });

  it('honors a named dependency set for a dependency referenced only through UNION', () => {
    const sql = compile(undefined, { inlineDeps: new Set(['PREPARED_MENTIONS']) });
    expect(sql).toContain('__CTE_PREPARED_MENTIONS AS (');
    expect(sql).not.toContain('__CTE_PREPARED_DIRECTORY');
    expect(sql).toContain('"EXAMPLE_DB"."NEW_OUTPUT_SCHEMA"."PREPARED_DIRECTORY"');
    expect(sql).not.toContain('"NEW_OUTPUT_SCHEMA"."PREPARED_MENTIONS"');
  });

  it('keeps unselected UNION dependencies physical', () => {
    const sql = compile(undefined, { inlineDeps: new Set(['prepared_directory']) });
    expect(sql).toContain('__CTE_PREPARED_DIRECTORY AS (');
    expect(sql).not.toContain('__CTE_PREPARED_MENTIONS');
    expect(sql).toContain('"EXAMPLE_DB"."NEW_OUTPUT_SCHEMA"."PREPARED_MENTIONS"');
  });

  it('uses the full dependency for UNION when a shared join pre-aggregates it', () => {
    const aggregated = model('combined_records', directory.name, {
      joins: [
        {
          ref: mentions.name,
          type: 'left',
          on: 't0.id = t1.id',
          pre_aggregate: {
            group_by: ['id'],
            columns: [{ name: 'mention_count', expr: 'count(*)' }],
          },
        },
      ],
      union: combined.spec.union,
    });
    const sql = compile([aggregated, directory, mentions]);
    expect(sql).toContain('LEFT JOIN __PA_T1 AS T1');
    expect(sql).toContain('UNION ALL SELECT ID AS ID FROM __CTE_PREPARED_MENTIONS');
    expect(sql.match(/__CTE_PREPARED_MENTIONS AS \(/g)).toHaveLength(1);
  });

  it('aliases an inlined UNION branch when it reuses the main projection', () => {
    const reused = model('combined_records', directory.name, { union: [{ ref: mentions.name }] });
    const sql = compile([reused, directory, mentions]);
    expect(sql).toContain('UNION ALL SELECT T0.ID AS ID FROM __CTE_PREPARED_MENTIONS AS T0');
  });

  it('hoists nested dependencies and deduplicates shared source, join, and UNION refs', () => {
    const nestedMentions = model('nested_mentions', mentions.name, {
      union: [{ ref: directory.name, columns: [{ name: 'id', expr: 'id' }] }],
    });
    const result = model('combined_records', directory.name, {
      joins: [{ ref: mentions.name, type: 'left', on: 't0.id = t1.id' }],
      union: [
        { ref: nestedMentions.name, columns: [{ name: 'id', expr: 'id' }] },
        { ref: directory.name, columns: [{ name: 'id', expr: 'id' }] },
        { ref: mentions.name, columns: [{ name: 'id', expr: 'id' }] },
      ],
    });
    const sql = compile([result, nestedMentions, mentions, directory]);
    expect(sql.match(/\bWITH\b/g)).toHaveLength(1);
    for (const name of ['PREPARED_DIRECTORY', 'PREPARED_MENTIONS', 'NESTED_MENTIONS']) {
      expect(sql.match(new RegExp(`__CTE_${name} AS \\(`, 'g'))).toHaveLength(1);
    }
    expect(sql).toContain('LEFT JOIN __CTE_PREPARED_MENTIONS AS T1');
    expect(sql).toContain('FROM __CTE_NESTED_MENTIONS');
    expect(sql.match(/\bUNION ALL\b/g)).toHaveLength(4);
    expect(sql).not.toContain('NEW_OUTPUT_SCHEMA');
  });

  it('honors a named set inside an inlined UNION dependency', () => {
    const nested = model('nested_mentions', mentions.name);
    const result = model('combined_records', directory.name, {
      union: [{ ref: nested.name, columns: [{ name: 'id', expr: 'id' }] }],
    });
    const sql = compile([result, nested, mentions, directory], {
      inlineDeps: new Set(['nested_mentions']),
    });
    expect(sql).toContain('__CTE_NESTED_MENTIONS AS (');
    expect(sql).not.toContain('__CTE_PREPARED_MENTIONS');
    expect(sql).not.toContain('__CTE_PREPARED_DIRECTORY');
    expect(sql).toContain('"NEW_OUTPUT_SCHEMA"."PREPARED_MENTIONS"');
    expect(sql).toContain('FROM __CTE_NESTED_MENTIONS');
  });

  it.each([true, false])('preserves branch star exclusions (inlineDeps=%s)', (inlineDeps) => {
    const columns = [
      { name: 'id', expr: 't0.id', type: 'VARCHAR' },
      { name: 'internal_debug', expr: "'debug'", type: 'VARCHAR' },
    ];
    const preparedDirectory = model(directory.name, 'example.directory', { columns });
    const preparedMentions = model(mentions.name, 'example.mentions', { columns });
    const result = model('combined_records', directory.name, {
      include_all_columns: true,
      exclude_columns: ['internal_debug'],
      columns: [],
      union: [
        { ref: mentions.name, include_all_columns: true, exclude_columns: ['internal_debug'] },
      ],
    });
    const sql = compile([result, preparedMentions, preparedDirectory], { inlineDeps });
    expect(sql).toContain('UNION ALL SELECT * EXCLUDE (INTERNAL_DEBUG) FROM');
    expect(sql).toContain(
      inlineDeps ? 'FROM __CTE_PREPARED_MENTIONS' : '"NEW_OUTPUT_SCHEMA"."PREPARED_MENTIONS"'
    );
  });

  it.each([true, false])(
    'preserves branch projections and filters (inlineDeps=%s)',
    (inlineDeps) => {
      const projected = model('combined_records', directory.name, {
        union: [
          {
            ref: mentions.name,
            columns: [{ name: 'id', expr: "concat(id, '_mention')", type: 'VARCHAR' }],
            filter: "id <> 'omitted'",
          },
        ],
      });
      const sql = compile([projected, mentions, directory], { inlineDeps });
      expect(sql).toContain("CONCAT(ID, '_mention') AS ID");
      expect(sql).toContain("WHERE (ID <> 'omitted')");
      expect(sql).toContain(
        inlineDeps ? 'FROM __CTE_PREPARED_MENTIONS' : '"NEW_OUTPUT_SCHEMA"."PREPARED_MENTIONS"'
      );
    }
  );

  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    '%s resolves inlined UNION relations and preserves disabled-inlining qualification',
    (dialect) => {
      const inlineSql = compile(undefined, { dialect });
      expect(inlineSql.toLowerCase()).toContain('from __cte_prepared_mentions');
      expect(inlineSql.toLowerCase()).not.toContain('new_output_schema');
      const physicalSql = compile(undefined, { dialect, inlineDeps: false });
      expect(physicalSql.toLowerCase()).not.toContain('__cte_');
      const quoted =
        dialect === 'bigquery' || dialect === 'databricks' || dialect === 'mysql' ? '`' : '"';
      const schema = dialect === 'mysql' ? 'example_db' : 'new_output_schema';
      expect(physicalSql.toLowerCase()).toContain(
        `${quoted}${schema}${quoted}.${quoted}prepared_mentions${quoted}`
      );
    }
  );
});
