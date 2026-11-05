import { checkOntologyRoundtrip } from './ontology-check.mjs';
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { publicApi } from '../../scripts/e2e/harness.mjs';
export const id = 'S12';
const vq = {
  spec_version: '0.2',
  type: 'vq',
  name: 'revenue',
  nlq: 'What is fictional revenue?',
  sql: 'SELECT SUM(total) FROM {revenue_report}',
};
export const limitations = [
  'Known limitation: OSI does not record provenance for fully mapped native files.',
];
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  await checkOntologyRoundtrip(ctx);
  const api = await publicApi('model-spec/project');
  const original = await api.loadProject(ctx.project);
  const before = await api.compileProject(ctx.project);
  assert.equal(before.ok, true);
  const exported = JSON.parse(
    (
      await ctx.cli([
        'model',
        'ossie',
        'export',
        '--all',
        '--name',
        'shop',
        '--ossie-version',
        '0.2.0.dev0',
        '--out',
        'shop.ossie.yml',
        '--json',
      ])
    ).stdout
  );
  assert.equal(exported.ready, true, JSON.stringify(exported.diagnostics));
  assert.match(await ctx.read('shop.ossie.yml'), /DOGSLED/);
  const extension = exported.files[0].document.custom_extensions.find(
    (entry) => entry.vendor_name === 'DOGSLED'
  );
  assert.deepEqual(JSON.parse(extension.data).verified_queries, [vq]);
  assert.doesNotMatch(await ctx.read('shop.ossie.yml'), /\bTRACK\b/);
  const imported = JSON.parse(
    (await ctx.cli(['model', 'ossie', 'import', 'shop.ossie.yml', '--out', 'converted', '--json']))
      .stdout
  );
  assert.equal(imported.ready, true, JSON.stringify(imported.diagnostics));
  assert.equal(imported.files.filter((file) => file.document.type === 'model').length, 3);
  assert.equal(imported.files.filter((file) => file.document.type === 'metric').length, 2);
  assert.deepEqual(
    imported.files.filter((file) => file.document.type === 'vq').map((file) => file.document),
    [vq]
  );
  assert.ok(
    imported.files
      .filter((file) => file.document.type === 'model')
      .every((file) => file.document.columns.some((column) => column.semantic_expression))
  );
  await cp(
    path.join(ctx.project, 'integrations'),
    path.join(ctx.project, 'converted/integrations'),
    { recursive: true }
  );
  await ctx.cli(['model', 'validate', '--integration', 'local_duckdb'], {
    cwd: path.join(ctx.project, 'converted'),
  });
  const after = await api.compileProject(path.join(ctx.project, 'converted'));
  assert.equal(after.ok, true);
  const sql = (result) =>
    result.byIntegration
      .flatMap((group) => group.results.filter((entry) => entry.ok).map((entry) => entry.sql))
      .sort();
  assert.deepEqual(sql(after), sql(before));
  const roundtrip = await api.loadProject(path.join(ctx.project, 'converted'));
  assert.deepEqual(
    [...roundtrip.entities.metrics.keys()].sort(),
    [...original.entities.metrics.keys()].sort()
  );
  assert.deepEqual([...roundtrip.entities.vqs.keys()], [...original.entities.vqs.keys()]);
}
