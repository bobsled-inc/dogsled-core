import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { command, jsonLines, publicApi } from '../../scripts/e2e/harness.mjs';
import { mockApi, postgres, postgresSql } from '../../scripts/e2e/services.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { showcaseData } from '../../scripts/e2e/mock-data.mjs';
export const id = 'S05';
export const limitations = [
  'Known limitation: named pipeline destinations do not support DuckLake; the golden-path quickstart verifies the direct DuckLake loader.',
];
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const port = await postgres();
  ctx.env.SHOWCASE_PG_PASSWORD = 'unused-local-only';
  await postgresSql('CREATE SCHEMA IF NOT EXISTS fanout');
  const { datasets } = showcaseData('fan-out');
  const api = await mockApi(ctx, datasets);
  try {
    ctx.env.SHOWCASE_PG_PORT = String(port);
    await command(process.execPath, ['configure-postgres.mjs'], { cwd: ctx.project, env: ctx.env });
    const destinations = JSON.parse(await ctx.read('destinations.json'));
    const result = await ctx.cli([
      'pipeline',
      '--integration',
      'shop_api',
      '--resource',
      'customers',
      '--destinations-json',
      JSON.stringify(destinations),
      '--output-dir',
      'archive',
      '--log-format',
      'json',
    ]);
    const summary = jsonLines(result.stderr).find((row) => row.type === 'PIPELINE_SUMMARY');
    assert.equal(summary.failed, 0);
    assert.equal(Number((await ctx.sql('SELECT count(*) AS n FROM customers')).rows[0].n), 200);
    assert.equal(await postgresSql('SELECT count(*) FROM fanout.customers'), '200');
    assert.equal(
      await postgresSql('SELECT count(_dogsled_loaded_at) FROM fanout.customers'),
      '200'
    );
    const files = (await readdir(path.join(ctx.project, 'archive'), { recursive: true })).filter(
      (name) => name.endsWith('.jsonl')
    );
    let count = 0;
    for (const name of files)
      count += (await readFile(path.join(ctx.project, 'archive', name), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean).length;
    assert.equal(count, 200);
    assert.equal(api.requests.filter((request) => request.path === '/customers').length, 2);
    api.assertAuth();
    const { BobsledConfigSchema } = await publicApi('manifest');
    assert.equal(
      BobsledConfigSchema.safeParse({
        destinations: { lake: { type: 'ducklake', catalog_url: 'ducklake:catalog.ducklake' } },
        pipelines: {},
      }).success,
      false
    );
  } finally {
    await api.close();
  }
}
