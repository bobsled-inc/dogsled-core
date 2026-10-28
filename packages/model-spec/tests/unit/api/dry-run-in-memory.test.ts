import { describe, expect, it, vi } from 'vitest';

import { dryRunInMemory, wrapDryRunSql } from '../../../src/api/dry-run-project.js';
import {
  TransformSpecSchema,
  type SourceRegistry,
  type SqlRunnerModule,
  type TransformSpec,
} from '../../../src/compiler/index.js';
import type { InMemoryModel } from '../../../src/api/compile-in-memory.js';

/**
 * Validates the file-less `dryRunInMemory` orchestration end-to-end with a
 * fake runner. Real warehouse execution is covered separately by the gated
 * DuckDB harness test.
 */

function model(name: string, sourceRef: string): InMemoryModel {
  const spec = TransformSpecSchema.parse({
    spec_version: '0.2',
    name,
    type: 'model',
    description: `${name} model`,
    grain: 'order_id',
    source: { ref: sourceRef },
    columns: [
      { name: 'order_id', expr: 'order_id' },
      { name: 'order_total', expr: 'order_total' },
    ],
    materialization: { type: 'view' },
  });
  return { name, spec: spec as TransformSpec };
}

function makeSources(): SourceRegistry {
  const map: SourceRegistry = new Map();
  map.set('ecom.raw_orders', 'analytics.raw_orders');
  return map;
}

describe('wrapDryRunSql', () => {
  it('limit0 mode wraps SELECT in WHERE 1 = 0 envelope', () => {
    const wrapped = wrapDryRunSql('SELECT 1 AS x', 'limit0');
    expect(wrapped).toContain('SELECT * FROM (');
    expect(wrapped).toContain('SELECT 1 AS x');
    expect(wrapped).toMatch(/WHERE 1 = 0/);
  });

  it('sample mode appends LIMIT <n>', () => {
    const wrapped = wrapDryRunSql('SELECT 1', 'sample', 7);
    expect(wrapped).toMatch(/LIMIT 7$/);
  });

  it('strips a trailing semicolon before wrapping', () => {
    const wrapped = wrapDryRunSql('SELECT 1 ;', 'limit0');
    // No trailing `;` carried through (would break the wrapping subquery).
    expect(wrapped).not.toMatch(/;\s*\)\s*AS __bms_dry_run/);
    expect(wrapped).toContain('SELECT 1');
  });
});

describe('dryRunInMemory', () => {
  it('runs every draft against the runner with limit0 envelope by default', async () => {
    const runs: string[] = [];
    const runner: SqlRunnerModule = {
      run: async (sql) => {
        runs.push(sql);
        return {};
      },
    };

    const result = await dryRunInMemory({
      models: [model('stg_orders', 'ecom.raw_orders'), model('fct_orders', 'stg_orders')],
      sources: makeSources(),
      dialect: 'duckdb',
      targetSchema: 'analytics',
      runner,
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === 'ok')).toBe(true);
    // Both models ran wrapped SQL.
    expect(runs).toHaveLength(2);
    for (const sql of runs) {
      expect(sql).toMatch(/WHERE 1 = 0/);
    }
    // fct_orders' wrapped SQL should reference the inlined stg_orders CTE,
    // not a physical analytics.stg_orders table — because both are drafts.
    const fctSql = runs.find((s) => s.includes('__cte_stg_orders'));
    expect(fctSql).toBeDefined();
  });

  it('targets subset only — non-target drafts still inlined but not executed', async () => {
    const runs: string[] = [];
    const runner: SqlRunnerModule = {
      run: async (sql) => {
        runs.push(sql);
        return {};
      },
    };

    const result = await dryRunInMemory({
      models: [model('stg_orders', 'ecom.raw_orders'), model('fct_orders', 'stg_orders')],
      sources: makeSources(),
      dialect: 'duckdb',
      targetSchema: 'analytics',
      runner,
      drafts: ['stg_orders', 'fct_orders'],
      targets: ['fct_orders'],
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.modelName).toBe('fct_orders');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('__cte_stg_orders');
  });

  it('surfaces runner errors as failed dry-run results', async () => {
    const runner: SqlRunnerModule = {
      run: vi.fn().mockRejectedValueOnce(new Error('column "order_id" does not exist')),
    };

    const result = await dryRunInMemory({
      models: [model('stg_orders', 'ecom.raw_orders')],
      sources: makeSources(),
      dialect: 'duckdb',
      targetSchema: 'analytics',
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.error).toContain('column "order_id" does not exist');
  });

  it('parse mode uses native dryRun hook when available', async () => {
    const nativeDryRun = vi.fn().mockResolvedValue(undefined);
    const runner: SqlRunnerModule = {
      run: async () => ({}),
      dryRun: nativeDryRun,
    };

    const result = await dryRunInMemory({
      models: [model('stg_orders', 'ecom.raw_orders')],
      sources: makeSources(),
      dialect: 'duckdb',
      targetSchema: 'analytics',
      runner,
      mode: 'parse',
    });

    expect(result.ok).toBe(true);
    expect(nativeDryRun).toHaveBeenCalledTimes(1);
    // Native dry-run receives the bare SELECT, not the wrapped envelope.
    const passed = nativeDryRun.mock.calls[0]?.[0] as string;
    expect(passed).not.toMatch(/WHERE 1 = 0/);
  });

  it('throws on unknown draft/target name', async () => {
    const runner: SqlRunnerModule = { run: async () => ({}) };
    await expect(
      dryRunInMemory({
        models: [model('stg_orders', 'ecom.raw_orders')],
        sources: makeSources(),
        dialect: 'duckdb',
        targetSchema: 'analytics',
        runner,
        drafts: ['unknown_model'],
      })
    ).rejects.toThrow(/not in the provided model set/);
  });
});
