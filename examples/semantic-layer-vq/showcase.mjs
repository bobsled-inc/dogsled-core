import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { prepare } from '../models-full/showcase.mjs';
import { publicApi } from '../../scripts/e2e/harness.mjs';
import { mockApi } from '../../scripts/e2e/services.mjs';
export const id = 'S07';
export const limitations = [
  'Known limitation: VQ CLI reads API sources; warehouse-backed VQs and dedicated list/validate commands are not supported.',
];
export async function run(ctx) {
  await prepare(ctx);
  for (const name of ['metrics', 'relationships'])
    await cp(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(ctx.project, name), {
      recursive: true,
    });
  await ctx.cli(['model', 'validate', '--integration', 'local_duckdb']);
  const { loadProject, loadVqsDirectory, VqSpecSchema } = await publicApi('model-spec/project');
  const project = await loadProject(ctx.project);
  assert.equal(project.entities.metrics.size, 2);
  assert.equal(project.entities.relationships.size, 1);
  const datasets = {};
  for (const name of ['orders', 'customers', 'products', 'categories'])
    datasets[name] = (await ctx.sql(`SELECT * FROM ${name}`)).rows;
  const api = await mockApi(ctx, datasets);
  const apiRoot = path.join(ctx.project, 'api-query');
  const query = {
    ...ctx,
    project: apiRoot,
    write: (name, value) => ctx.write(`api-query/${name}`, value),
    cli: (args, options) => ctx.cli(args, { cwd: apiRoot, ...options }),
  };
  try {
    await copyProject(query, new URL('./api-query/', import.meta.url));
    const vqs = await loadVqsDirectory(apiRoot, 'vqs');
    assert.equal(vqs.size, 2);
    assert.equal(vqs.get('revenue_by_customer').parameters.length, 2);
    for (const vq of vqs.values()) assert.equal(VqSpecSchema.safeParse(vq).success, true);
    const revenue = JSON.parse(
      (
        await query.cli([
          'vq',
          'revenue_by_customer',
          '--param',
          'start_date=2025-01-01',
          '--param',
          'end_date=2025-12-31',
        ])
      ).stdout
    );
    assert.equal(revenue.rows.length, 50);
    assert.equal(
      revenue.rows.reduce((sum, row) => sum + Number(row.total_revenue), 0),
      50500
    );
    const products = JSON.parse(
      (await query.cli(['vq', 'top_products', '--param', 'category=electronics'])).stdout
    );
    assert.equal(products.rows.length, 4);
    assert.ok(products.rows.every((row) => row.category === 'electronics'));
    const invalid = await query.cli(
      [
        'vq',
        'revenue_by_customer',
        '--param',
        'start_date=not-a-date',
        '--param',
        'end_date=2025-12-31',
      ],
      { expected: 2 }
    );
    assert.match(invalid.stdout + invalid.stderr, /YYYY-MM-DD date/);
  } finally {
    await api.close();
  }
}
