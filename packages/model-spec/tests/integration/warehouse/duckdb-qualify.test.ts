/**
 * QUALIFY emulation checked for equivalence against the native clause.
 *
 * Postgres and MySQL have no QUALIFY, so the compiler hoists the predicate's
 * window expressions into the SELECT list and filters them from a wrapping
 * subquery. The emulated form is plain ANSI SQL, so DuckDB runs it as happily as
 * it runs its own native clause, which makes it possible to execute both against
 * one dataset and require identical rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateSelectSql } from '../../../src/compiler/codegen.js';
import { parseTransformSpecFromParsed } from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

import { createDuckDbHarness, type WarehouseTestHarness } from './harness.js';
import { requireWarehouseEnv, warehouseEnabled } from './setup.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';

requireWarehouseEnv('duckdb');
const RUN = warehouseEnabled('duckdb');

describe.skipIf(!RUN)('duckdb: QUALIFY emulation equivalence', () => {
  let harness: WarehouseTestHarness;

  beforeEach(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
    await harness.runner.run(
      `CREATE TABLE "${harness.schema}"."raw_events" (
         user_id INTEGER, status VARCHAR, created_at INTEGER)`
    );
    await harness.runner.run(
      `INSERT INTO "${harness.schema}"."raw_events" VALUES
        (1, 'new', 1), (1, 'active', 2),
        (2, 'new', 1), (2, 'churned', 2),
        (3, 'new', 1), (3, 'active', 2)`
    );
  });

  afterEach(async () => {
    await harness.teardown();
  });

  const compile = (extra: Record<string, unknown>, dialect: SupportedDialect): string => {
    const spec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'latest_event',
      type: 'model',
      description: 'Latest event per user.',
      grain: 'user_id',
      source: { ref: 'duckdb.events' },
      columns: [
        { name: 'user_id', expr: 'user_id' },
        { name: 'status', expr: 'status' },
      ],
      materialization: { type: 'view' },
      ...extra,
    });
    const registry = new Map([['duckdb.events', `${harness.schema}.raw_events`]]);
    const resolved = parseTransformSpecFromParsed(spec, registry as never);
    if (!resolved.ok) throw new Error(resolved.error);
    return generateSelectSql(resolved.spec, dialect);
  };

  const run = async (sql: string): Promise<string[]> => {
    const query = harness.runner.query;
    if (!query) throw new Error('DuckDB harness runner has no query support');
    const rows = (await query(sql)) as Array<Record<string, unknown>>;
    return rows.map((r) => `${String(r.user_id)}=${String(r.status)}`).sort();
  };

  const LATEST = 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1';

  it('emulated qualify returns exactly what the native clause returns', async () => {
    const native = await run(compile({ qualify: LATEST }, 'duckdb'));
    const emulated = await run(compile({ qualify: LATEST }, 'postgres'));
    expect(native).toEqual(['1=active', '2=churned', '3=active']);
    expect(emulated).toEqual(native);
  });

  it('emulated dedupe returns exactly what the native clause returns', async () => {
    const dedupe = {
      dedupe: {
        keys: ['user_id'],
        strategy: 'keep_last',
        order_by: [{ column: 'created_at', direction: 'asc' }],
      },
    };
    const native = await run(compile(dedupe, 'duckdb'));
    const emulated = await run(compile(dedupe, 'postgres'));
    expect(native).toEqual(['1=active', '2=churned', '3=active']);
    expect(emulated).toEqual(native);
  });

  it('filters before applying LIMIT, which the transpiler rewrite got wrong', async () => {
    // The normalisation pass rewrites QUALIFY into a subquery for Postgres-family
    // targets and moves LIMIT inside it, taking rows before the window filter.
    // Both compiled forms must filter first and then take two rows.
    const withLimit = {
      qualify: LATEST,
      order_by: [{ column: 'user_id', direction: 'asc' }],
      limit: 2,
    };
    const native = await run(compile(withLimit, 'duckdb'));
    const emulated = await run(compile(withLimit, 'postgres'));
    expect(native).toHaveLength(2);
    expect(emulated).toEqual(native);
  });

  it('produces a union whose branches match in width', async () => {
    // The hoisted helper column used to be rendered into every branch arm, so
    // the first branch had N columns and the rest had N+1. That compiled clean
    // and the warehouse rejected it.
    await harness.runner.run(
      `CREATE TABLE "${harness.schema}"."raw_more" (user_id INTEGER, status VARCHAR, created_at INTEGER)`
    );
    await harness.runner.run(`INSERT INTO "${harness.schema}"."raw_more" VALUES (9, 'extra', 1)`);
    const spec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'latest_plus',
      type: 'model',
      description: 'Latest event per user plus an extra source.',
      grain: 'user_id',
      source: { ref: 'duckdb.events' },
      columns: [
        { name: 'user_id', expr: 'user_id' },
        { name: 'status', expr: 'status' },
      ],
      qualify: LATEST,
      union: [{ ref: 'duckdb.more' }],
      materialization: { type: 'view' },
    });
    const registry = new Map([
      ['duckdb.events', `${harness.schema}.raw_events`],
      ['duckdb.more', `${harness.schema}.raw_more`],
    ]);
    const resolved = parseTransformSpecFromParsed(spec, registry as never);
    if (!resolved.ok) throw new Error(resolved.error);

    const rows = await run(generateSelectSql(resolved.spec, 'postgres'));
    expect(rows).toEqual(['1=active', '2=churned', '3=active', '9=extra']);
  });

  it('resolves window columns the model does not project', async () => {
    // `created_at` drives the ordering but is not an output column. The hoisted
    // window expression stays in the original SELECT, so it still reads it.
    const sql = compile({ qualify: LATEST }, 'postgres');
    expect(sql).not.toMatch(/\bQUALIFY\b/);
    expect(await run(sql)).toEqual(['1=active', '2=churned', '3=active']);
  });
});
