import assert from 'node:assert/strict';
import { command } from '../../scripts/e2e/harness.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { mockApi, postgres, postgresFlags, postgresSql } from '../../scripts/e2e/services.mjs';
import { showcaseData } from '../../scripts/e2e/mock-data.mjs';
export const id = 'S14';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const port = await postgres();
  ctx.env.SHOWCASE_PG_PORT = String(port);
  await command(process.execPath, ['configure-postgres.mjs'], { cwd: ctx.project, env: ctx.env });
  ctx.env.SHOWCASE_PG_PASSWORD = 'unused-local-only';
  await postgresSql('CREATE SCHEMA IF NOT EXISTS pipeline');
  const { datasets } = showcaseData('postgres-pipeline');
  const api = await mockApi(ctx, datasets);
  try {
    await ctx.cli([
      'pipeline',
      '--integration',
      'shop_api',
      '--dest',
      'postgres',
      ...postgresFlags(port, 'pipeline'),
      '--log-format',
      'json',
    ]);
    assert.equal(await postgresSql('SELECT count(*) FROM pipeline.staff'), '200');
    assert.equal(await postgresSql('SELECT count(*) FROM pipeline.departments'), '10');
    assert.equal(
      await postgresSql(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='pipeline' AND column_name='_bobsled_loaded_at'"
      ),
      '2'
    );
    assert.equal(
      await postgresSql(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='pipeline' AND (column_name LIKE '_bobsled_%' OR column_name LIKE '_track_%')"
      ),
      '0'
    );
    await ctx.cli(['model', 'validate', '--integration', 'local_pg']);
    assert.equal(
      JSON.parse((await ctx.cli(['model', 'run', '--integration', 'local_pg', '--json'])).stdout)
        .ok,
      true
    );
    await ctx.cli([
      'model',
      'expect',
      'run',
      '--integration',
      'local_pg',
      '--runner',
      './runner.mjs',
      '--json',
    ]);
    assert.equal(
      await postgresSql(
        'SELECT count(*) || chr(44) || sum(headcount) FROM pipeline.department_headcount'
      ),
      '10,200'
    );
    assert.equal(await postgresSql('SELECT count(*) FROM pipeline.salary_band'), '200');
    api.assertAuth();
  } finally {
    await api.close();
  }
}
