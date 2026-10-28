import assert from 'node:assert/strict';
import { jsonLines } from '../../scripts/e2e/harness.mjs';
import { mockApi } from '../../scripts/e2e/services.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { showcaseData } from '../../scripts/e2e/mock-data.mjs';
export const id = 'S04';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const { datasets, advance } = showcaseData('incremental-cursors');
  const api = await mockApi(ctx, datasets);
  try {
    const args = [
      'pipeline',
      '--integration',
      'shop_api',
      '--resource',
      'events',
      '--dest',
      'duckdb',
      '--db-path',
      'data.duckdb',
      '--log-format',
      'json',
    ];
    const first = await ctx.cli(args);
    assert.equal(
      jsonLines(first.stderr).find((row) => row.type === 'PIPELINE_SUMMARY')
        .total_records_extracted,
      100
    );
    const state = JSON.parse(await ctx.read('.extractor/state.json'));
    assert.equal(state.streams['shop_api/events'].cursor_value, '100');
    advance();
    const second = await ctx.cli(args);
    assert.equal(
      jsonLines(second.stderr).find((row) => row.type === 'PIPELINE_SUMMARY')
        .total_records_extracted,
      50
    );
    const result = await ctx.sql(
      'SELECT count(*) AS n, count(DISTINCT id) AS unique_ids FROM events'
    );
    assert.equal(Number(result.rows[0].n), 150);
    assert.equal(Number(result.rows[0].unique_ids), 150);
    assert.ok(api.requests.some((request) => request.since === '100'));
    api.assertAuth();
  } finally {
    await api.close();
  }
}
