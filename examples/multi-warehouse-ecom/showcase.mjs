import assert from 'node:assert/strict';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { command, publicApi } from '../../scripts/e2e/harness.mjs';
import { postgres, postgresSql } from '../../scripts/e2e/services.mjs';
export const id = 'S22';
export const limitations = [
  'Known limitation: warehouse VQ definitions are executed with query; the VQ CLI currently requires API-source references.',
];
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const port = await postgres();
  Object.assign(ctx.env, {
    SHOWCASE_PG_HOST: '127.0.0.1',
    SHOWCASE_PG_USER: 'postgres',
    SHOWCASE_PG_PASSWORD: 'unused-local-only',
  });
  await postgresSql('CREATE SCHEMA IF NOT EXISTS ecommerce');
  ctx.env.SHOWCASE_PG_PORT = String(port);
  await command(process.execPath, ['configure-postgres.mjs'], { cwd: ctx.project, env: ctx.env });
  const destinations = JSON.parse(await ctx.read('destinations.json'));
  await ctx.cli([
    'pipeline',
    '--integration',
    'local_exports',
    '--resource',
    'customers',
    'products',
    'orders',
    '--destinations-json',
    JSON.stringify(destinations),
    '--log-format',
    'json',
  ]);
  for (const [table, count] of [
    ['customers', 8],
    ['products', 6],
    ['orders', 16],
  ]) {
    assert.equal(Number((await ctx.sql(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), count);
    assert.equal(Number(await postgresSql(`SELECT count(*) FROM ecommerce.${table}`)), count);
  }
  await ctx.cli(['model', 'validate']);
  assert.equal(JSON.parse((await ctx.cli(['model', 'run', '--json'])).stdout).ok, true);
  const mixed = (
    await ctx.sql('SELECT count(*) AS n, SUM(amount) AS total FROM mixed_order_report')
  ).rows[0];
  assert.equal(Number(mixed.n), 16);
  assert.equal(Number(mixed.total), 1360);
  assert.equal(
    await postgresSql(
      'SELECT count(*) || chr(44) || SUM(amount) FROM ecommerce.postgres_order_summary'
    ),
    '16,1360'
  );
  const { loadProject } = await publicApi('model-spec/project');
  const project = await loadProject(ctx.project);
  assert.equal(project.entities.metrics.size, 2);
  assert.equal(project.entities.relationships.size, 2);
  const vq = project.entities.vqs.get('shop_revenue');
  assert.ok(vq);
  const result = (await ctx.sql(vq.sql)).rows[0];
  assert.equal(Number(result.orders), 16);
  assert.equal(Number(result.revenue), 1360);
}
