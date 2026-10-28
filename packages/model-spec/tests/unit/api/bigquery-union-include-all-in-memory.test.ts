import { describe, expect, it } from 'vitest';

import { compileInMemory, type InMemoryModel } from '../../../src/api/compile-in-memory.js';
import { dryRunInMemory } from '../../../src/api/dry-run-project.js';
import {
  buildInMemorySourceEntryRegistry,
  SourceSpecSchema,
  TransformSpecSchema,
  type SourceRegistry,
  type SourceSpec,
  type SqlRunnerModule,
  type TransformSpec,
} from '../../../src/compiler/index.js';

/**
 * Regression: BigQuery union models with `include_all_columns: true` tripped
 * the `bigquery_union_drift_guard` whenever the host used the file-less
 * `compileInMemory` / `dryRunInMemory` surfaces, because neither accepted a
 * `SourceEntryRegistry`. The fix wires `entryRegistry` through both surfaces
 * and adds `buildInMemorySourceEntryRegistry` so callers can build one from
 * parsed `SourceSpec`s.
 */

function makeSourceSpec(name: string, connection: string, table: string): SourceSpec {
  return SourceSpecSchema.parse({
    spec_version: '0.2',
    name,
    type: 'source',
    source_type: 'warehouse_table',
    connection,
    table,
    schema: {
      columns: [
        { name: 'row_id', type: 'STRING' },
        { name: 'amount', type: 'NUMERIC' },
      ],
    },
  }) as SourceSpec;
}

function makeUnionModel(): InMemoryModel {
  const spec = TransformSpecSchema.parse({
    spec_version: '0.2',
    name: 'all_chat_feedback',
    type: 'model',
    description: 'Customer chat feedback across every credit-warehouse source.',
    grain: 'row_id',
    source: { ref: 'dogsled_managed.acme__chat_feedback' },
    include_all_columns: true,
    columns: [{ name: 'source_system', expr: "'acme'" }],
    union: [
      {
        ref: 'dogsled_managed.globex__chat_feedback',
        include_all_columns: true,
        columns: [{ name: 'source_system', expr: "'globex'" }],
      },
    ],
    materialization: { type: 'view' },
  } satisfies Record<string, unknown>);
  return { name: 'all_chat_feedback', spec: spec as TransformSpec };
}

function makeBigQuerySourceRegistry(): SourceRegistry {
  // Mirrors the host application's pre-fix wiring: `SourceRegistry` is the
  // ref → fully-qualified table name map, but no column metadata is supplied.
  const map: SourceRegistry = new Map();
  map.set('dogsled_managed.acme__chat_feedback', 'lake.acme__chat_feedback');
  map.set('dogsled_managed.globex__chat_feedback', 'lake.globex__chat_feedback');
  return map;
}

describe('buildInMemorySourceEntryRegistry', () => {
  it('produces a registry keyed by `connection.name` from parsed SourceSpecs', () => {
    const specs = [
      makeSourceSpec('acme__chat_feedback', 'dogsled_managed', 'lake.acme__chat_feedback'),
      makeSourceSpec('globex__chat_feedback', 'dogsled_managed', 'lake.globex__chat_feedback'),
    ];
    const result = buildInMemorySourceEntryRegistry(specs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entryRegistry.size).toBe(2);
    const entry = result.entryRegistry.get('dogsled_managed.acme__chat_feedback');
    expect(entry?.kind).toBe('warehouse_table');
    expect(entry?.columns.map((c) => c.name)).toEqual(['row_id', 'amount']);
    expect(result.registry.get('dogsled_managed.acme__chat_feedback')).toBe(
      'lake.acme__chat_feedback'
    );
  });

  it('rejects duplicate refs with a structured error', () => {
    const dup = makeSourceSpec('x', 'h', 'h.x');
    const result = buildInMemorySourceEntryRegistry([dup, dup]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Duplicate source ref/);
  });
});

describe('compileInMemory — BigQuery union with include_all_columns', () => {
  const sources = makeBigQuerySourceRegistry();
  const model = makeUnionModel();
  const sourceSpecs = [
    makeSourceSpec('acme__chat_feedback', 'dogsled_managed', 'lake.acme__chat_feedback'),
    makeSourceSpec('globex__chat_feedback', 'dogsled_managed', 'lake.globex__chat_feedback'),
  ];

  it('trips the bigquery_union_drift_guard when entryRegistry is omitted', () => {
    const result = compileInMemory({
      models: [model],
      sources,
      dialect: 'bigquery',
      targetSchema: 'lakehouse',
      selectOnly: true,
    });
    expect(result.ok).toBe(false);
    const failure = result.results.find((r) => !r.ok);
    expect(failure?.ok).toBe(false);
    if (failure?.ok) return;
    expect(failure?.error).toMatch(/bigquery_union_drift_guard/);
  });

  it('compiles cleanly when entryRegistry is supplied', () => {
    const registry = buildInMemorySourceEntryRegistry(sourceSpecs);
    if (!registry.ok) throw new Error(registry.error);

    const result = compileInMemory({
      models: [model],
      sources,
      dialect: 'bigquery',
      targetSchema: 'lakehouse',
      selectOnly: true,
      entryRegistry: registry.entryRegistry,
    });

    expect(result.ok).toBe(true);
    const compiled = result.results[0];
    expect(compiled?.ok).toBe(true);
    if (!compiled?.ok) return;
    // Canonical projection emits SAFE_CAST per column on every UNION ALL arm.
    expect(compiled.sql).toMatch(/UNION ALL/);
    expect(compiled.sql).toMatch(/SAFE_CAST/);
    // The first arm's source_system literal stays distinct from the branch's.
    expect(compiled.sql).toContain("'acme'");
    expect(compiled.sql).toContain("'globex'");
  });
});

describe('dryRunInMemory — BigQuery union with include_all_columns', () => {
  const sources = makeBigQuerySourceRegistry();
  const model = makeUnionModel();
  const sourceSpecs = [
    makeSourceSpec('acme__chat_feedback', 'dogsled_managed', 'lake.acme__chat_feedback'),
    makeSourceSpec('globex__chat_feedback', 'dogsled_managed', 'lake.globex__chat_feedback'),
  ];

  it('surfaces the drift guard as a failed result when entryRegistry is omitted', async () => {
    const runs: string[] = [];
    const runner: SqlRunnerModule = {
      run: async (sql) => {
        runs.push(sql);
        return {};
      },
    };

    const result = await dryRunInMemory({
      models: [model],
      sources,
      dialect: 'bigquery',
      targetSchema: 'lakehouse',
      runner,
    });

    expect(result.ok).toBe(false);
    expect(runs).toHaveLength(0);
    const failure = result.results.find((r) => r.status === 'failed');
    expect(failure?.error).toMatch(/bigquery_union_drift_guard/);
  });

  it('dry-runs end-to-end when entryRegistry is supplied', async () => {
    const registry = buildInMemorySourceEntryRegistry(sourceSpecs);
    if (!registry.ok) throw new Error(registry.error);

    const runs: string[] = [];
    const runner: SqlRunnerModule = {
      run: async (sql) => {
        runs.push(sql);
        return {};
      },
    };

    const result = await dryRunInMemory({
      models: [model],
      sources,
      dialect: 'bigquery',
      targetSchema: 'lakehouse',
      runner,
      entryRegistry: registry.entryRegistry,
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe('ok');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/WHERE 1 = 0/);
    expect(runs[0]).toMatch(/UNION ALL/);
  });
});
