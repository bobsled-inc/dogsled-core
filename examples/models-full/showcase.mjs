import assert from 'node:assert/strict';
import { copyProject, duckdb } from '../../scripts/e2e/fixtures.mjs';
export const id = 'S06';
export async function prepare(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  await ctx.cli([
    'model',
    'seed',
    'load',
    '--dialect',
    'duckdb',
    '--schema',
    'main',
    '--runner',
    './runner.mjs',
    '--json',
  ]);
  await duckdb(
    ctx,
    async (runner) => {
      await runner.run(
        'CREATE TABLE benchmarks AS SELECT i AS customer_id, 1000 AS target FROM range(1, 51) AS t(i)'
      );
    },
    'auxiliary.duckdb'
  );
  await ctx.cli(['model', 'validate', '--integration', 'local_duckdb']);
  const result = await ctx.cli(['model', 'run', '--integration', 'local_duckdb', '--json']);
  assert.equal(JSON.parse(result.stdout).ok, true);
}
export async function run(ctx) {
  await prepare(ctx);
  const counts = await ctx.sql(
    'SELECT (SELECT count(*) FROM order_summary) AS orders, (SELECT count(*) FROM product_stats) AS categories, (SELECT count(*) FROM cross_engine_report) AS mixed'
  );
  assert.equal(Number(counts.rows[0].orders), 100);
  assert.equal(Number(counts.rows[0].categories), 5);
  assert.equal(Number(counts.rows[0].mixed), 50);
  const expected = await ctx.cli([
    'model',
    'expect',
    'run',
    '--integration',
    'local_duckdb',
    '--runner',
    './runner.mjs',
    '--json',
  ]);
  const expectations = JSON.parse(expected.stdout);
  assert.equal(expectations.ok, true);
  assert.equal(expectations.expectations.length, 4);
  assert.ok(
    expectations.expectations.every(
      (entry) => entry.executed && entry.status === 'passed' && entry.violation_count === 0
    )
  );
  const lineage = JSON.parse(
    (await ctx.cli(['model', 'lineage', '--integration', 'local_duckdb', '--json'])).stdout
  );
  const upstream = lineage.integrations
    .flatMap((group) => group.column_lineage)
    .find((item) => item.model === 'customer_lifetime' && item.column === 'total_spent');
  assert.ok(upstream?.upstream.some((entry) => entry.column === 'amount'));
  await duckdb(ctx, async (runner) => {
    await runner.run(
      "INSERT INTO orders SELECT i, 1, 1, 10, DATE '2025-04-10' + CAST(i - 100 AS INTEGER), 'delivered' FROM range(101,111) AS t(i)"
    );
  });
  await ctx.cli(['model', 'run', 'daily_revenue', '--integration', 'local_duckdb', '--json']);
  const result = await ctx.sql(
    'SELECT count(*) AS n, count(DISTINCT order_date) AS unique_dates, SUM(total_revenue) AS total FROM daily_revenue'
  );
  assert.equal(Number(result.rows[0].n), 110);
  assert.equal(Number(result.rows[0].unique_dates), 110);
  assert.equal(Number(result.rows[0].total), 50600);
}
