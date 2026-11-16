import assert from 'node:assert/strict';
import { cp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiProject, mockApi } from '../../scripts/e2e/services.mjs';
import { cliPath, command, jsonLines } from '../../scripts/e2e/harness.mjs';

export const id = 'S01';
export async function run(ctx) {
  await ctx.cli(['init', 'readme-shop', '--duckdb']);
  assert.match(await ctx.read('readme-shop/.dogsled/config.yml'), /dest: duckdb/);
  await ctx.cli(['doctor'], { cwd: path.join(ctx.project, 'readme-shop') });

  await ctx.cli(['init', 'my-project']);
  const cwd = path.join(ctx.project, 'my-project');
  assert.match(await ctx.read('my-project/.dogsled/config.yml'), /dest: ducklake/);
  const fixture = fileURLToPath(new URL('./', import.meta.url));
  for (const name of [
    'data',
    'extractor.yml',
    'model-spec.yml',
    'integrations',
    'resources',
    'sources',
    'models',
    'lake-models.mjs',
  ]) {
    await cp(path.join(fixture, name), path.join(cwd, name), { recursive: true });
  }
  await mkdir(path.join(cwd, 'node_modules/@bobsled-inc'), { recursive: true });
  await symlink(
    path.dirname(path.dirname(cliPath)),
    path.join(cwd, 'node_modules/@bobsled-inc/bobsled-core'),
    'dir'
  );
  await ctx.cli(['extract', 'validate', 'local_files'], { cwd });
  for (const resource of ['customers', 'products', 'orders']) {
    const extracted = await ctx.cli(['extract', 'run', '--integration', 'local_files', resource], {
      cwd,
    });
    assert.equal(jsonLines(extracted.stdout).filter((row) => row.type === 'RECORD').length, 25);
    await ctx.cli(
      [
        'load',
        'run',
        '--dest',
        'ducklake',
        '--ducklake-catalog-url',
        'ducklake:.dogsled/lake/catalog.ducklake',
        '--target-schema',
        'bronze',
        '--log-format',
        'json',
      ],
      { cwd, input: extracted.stdout }
    );
  }
  await ctx.cli(['model', 'validate', '--integration', 'local_lake'], { cwd });
  await command(process.execPath, ['lake-models.mjs'], { cwd, env: ctx.env });
  const result = await ctx.cli(
    [
      'query',
      "INSTALL ducklake; LOAD ducklake; ATTACH 'ducklake:.dogsled/lake/catalog.ducklake' AS lake; SELECT count(*) AS n, sum(amount) AS total, count(_dogsled_loaded_at) AS stamped FROM lake.bronze.orders",
      '--db-path',
      'query.duckdb',
    ],
    { cwd }
  );
  const row = JSON.parse(result.stdout).rows[0];
  assert.equal(Number(row.n), 25);
  assert.equal(Number(row.total), 3250);
  assert.equal(Number(row.stamped), 25);
  const modeled = await ctx.cli(
    [
      'query',
      "LOAD ducklake; ATTACH 'ducklake:.dogsled/lake/catalog.ducklake' AS lake; SELECT count(*) AS n FROM lake.bronze.order_summary",
      '--db-path',
      'query.duckdb',
    ],
    { cwd }
  );
  assert.equal(Number(JSON.parse(modeled.stdout).rows[0].n), 25);
  await ctx.cli(['doctor', '--json'], { cwd });
  const api = await mockApi(ctx, {
    posts: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `post-${i + 1}` })),
  });
  const apiRoot = path.join(ctx.project, 'api-query');
  const query = {
    ...ctx,
    project: apiRoot,
    write: (name, value) => ctx.write(`api-query/${name}`, value),
    cli: (args, options) => ctx.cli(args, { cwd: apiRoot, ...options }),
  };
  try {
    await apiProject(query, { posts: { id: 'integer', name: 'string' } });
    await query.write('sources/posts.yml', {
      spec_version: '0.2',
      type: 'source',
      name: 'posts',
      source_type: 'api_resource',
      integration: 'shop_api',
      resource: 'posts',
      connection: 'shop_api',
      mode: 'live',
      schema: {
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'STRING' },
        ],
      },
    });
    const extracted = await query.cli(['extract', 'run', '--integration', 'shop_api', 'posts']);
    await ctx.cli(
      [
        'load',
        'run',
        '--dest',
        'ducklake',
        '--ducklake-catalog-url',
        'ducklake:.dogsled/lake/catalog.ducklake',
        '--target-schema',
        'bronze',
      ],
      { cwd, input: extracted.stdout }
    );
    const result = JSON.parse(
      (await query.cli(['source-query', 'SELECT count(*) AS n FROM sources.posts'])).stdout
    );
    assert.equal(Number(result.rows[0].n), 100);
    const loaded = await ctx.cli(
      [
        'query',
        "LOAD ducklake; ATTACH 'ducklake:.dogsled/lake/catalog.ducklake' AS lake; SELECT count(*) AS n FROM lake.bronze.posts",
        '--db-path',
        'query.duckdb',
      ],
      { cwd }
    );
    assert.equal(Number(JSON.parse(loaded.stdout).rows[0].n), 100);
    api.assertAuth();
    for (const output of ctx.outputs)
      assert.doesNotMatch(output.stdout + output.stderr, /\b(?:Track|Bobsled)\b/);
  } finally {
    await api.close();
  }
}
