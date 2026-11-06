import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { copyProject, duckdb } from '../../scripts/e2e/fixtures.mjs';
export const id = 'S15';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  ctx.env.SHOWCASE_MODEL_KEY = 'synthetic-test-model-key';
  await duckdb(ctx, async (runner) => {
    await runner.run(
      "CREATE TABLE pairs AS SELECT 'pair-' || lpad(CAST(i AS VARCHAR), 3, '0') AS pair_id, 'Fictional evidence only' AS evidence FROM range(1,21) AS t(i)"
    );
  });
  const args = [
    'model',
    'run',
    '+pair_assessments',
    '--integration',
    'local',
    '--agent-executor',
    './mock-executor.mjs',
    '--agent-run-id',
    'showcase-resume',
    '--agent-tokens-per-assignment',
    '8192',
    '--json',
  ];
  const crashed = await ctx.cli(args, { env: { ...ctx.env, SHOWCASE_CRASH: '1' }, expected: null });
  assert.notEqual(crashed.code, 0);
  const before = (
    await ctx.read('calls.jsonl').catch(() => {
      throw new Error(`Executor did not start: ${crashed.stdout} ${crashed.stderr}`);
    })
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    before.filter((call) => call.event === 'accepted').length,
    10,
    crashed.stdout + crashed.stderr
  );

  const resumed = JSON.parse((await ctx.cli([...args, '--agent-resume'])).stdout);
  assert.equal(resumed.ok, true);
  const rows = (await ctx.sql('SELECT * FROM pair_assessments ORDER BY pair_id')).rows;
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((row) => row.pair_id)).size, 20);
  assert.ok(
    rows.every(
      (row) =>
        row._dogsled_run_id && row._dogsled_evidence && Number(row._dogsled_confidence) === 0.9
    )
  );
  const calls = (await ctx.read('calls.jsonl')).trim().split('\n').map(JSON.parse);
  const accepted = calls.filter((call) => call.event === 'accepted');
  assert.equal(accepted.length, 20);
  assert.equal(new Set(accepted.map((call) => call.pair)).size, 20);
  assert.equal(
    accepted.reduce((sum, call) => sum + call.tokens, 0),
    2000
  );
  const tables = (await ctx.sql('SELECT table_schema, table_name FROM information_schema.tables'))
    .rows;
  const files = await readdir(ctx.project, { recursive: true });
  assert.ok(files.some((name) => /run-[a-f0-9]{64}\.duckdb$/.test(name)));
  assert.ok(tables.some((row) => row.table_schema === '_dogsled_agentic_publication'));
  await ctx.cli([...args, '--agent-resume']);
  assert.equal((await ctx.read('calls.jsonl')).trim().split('\n').length, calls.length);
}
