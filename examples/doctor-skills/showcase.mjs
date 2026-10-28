import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { publicApi } from '../../scripts/e2e/harness.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
export const id = 'S11';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  await ctx.cli(['skill', 'configure']);
  await ctx.cli(['skill', 'validate']);
  const listed = await ctx.cli(['skill', 'list']);
  assert.match(listed.stdout, /shop-overview/);
  const clean = JSON.parse((await ctx.cli(['doctor', '--json'])).stdout);
  assert.equal(clean.valid, true);
  await ctx.write('models/broken.yml', await ctx.read('broken-model.example.txt'));
  const broken = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(broken.code, 0);
  const unhealthy = JSON.parse(broken.stdout);
  assert.ok(
    unhealthy.checks.some(
      (check) => check.status === 'error' && /missing_source/.test(check.message)
    )
  );
  await rm(path.join(ctx.project, 'models/broken.yml'));
  assert.equal(JSON.parse((await ctx.cli(['doctor', '--json'])).stdout).valid, true);
  const { scanProject } = await publicApi('project-index');
  const index = scanProject(ctx.project);
  assert.equal(index.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.ok(index.entries.length >= 1);
}
