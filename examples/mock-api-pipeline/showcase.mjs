import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { jsonLines } from '../../scripts/e2e/harness.mjs';
import { mockApi } from '../../scripts/e2e/services.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { showcaseData } from '../../scripts/e2e/mock-data.mjs';
export const id = 'S03';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const { datasets } = showcaseData('mock-api-pipeline');
  const api = await mockApi(ctx, datasets);
  try {
    await ctx.cli(['extract', 'validate', 'shop_api']);
    await ctx.cli(['extract', 'health-check', 'shop_api', '--resource', 'products']);
    const result = await ctx.cli([
      'pipeline',
      '--integration',
      'shop_api',
      '--dest',
      'duckdb',
      '--db-path',
      'data.duckdb',
      '--batch',
      '--batch-format',
      'jsonl',
      '--batch-size',
      '100',
      '--log-format',
      'json',
    ]);
    const summary = jsonLines(result.stderr).find((row) => row.type === 'PIPELINE_SUMMARY');
    assert.ok(summary, 'Versioned pipeline summary is required');
    assert.equal(summary.failed, 0);
    assert.equal(summary.total_streams, 3);
    assert.equal(summary.total_records_extracted, 550);
    for (const [table, rows] of Object.entries(datasets)) {
      const result = await ctx.sql(`SELECT count(*) AS n FROM ${table}`);
      assert.equal(Number(result.rows[0].n), rows.length);
    }
    const files = await readdir(ctx.project, { recursive: true });
    assert.ok(files.some((name) => name.endsWith('.jsonl')));
    assert.equal(api.requests.filter((request) => request.path === '/orders').length, 5);
    api.assertAuth();
    const selected = await ctx.cli([
      'pipeline',
      '--integration',
      'shop_api',
      '--resource',
      'products',
      '--dest',
      'duckdb',
      '--db-path',
      'selected.duckdb',
      '--log-format',
      'json',
    ]);
    assert.equal(
      jsonLines(selected.stderr).find((row) => row.type === 'PIPELINE_SUMMARY').total_streams,
      1
    );
  } finally {
    await api.close();
  }
}
