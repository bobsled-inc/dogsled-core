import assert from 'node:assert/strict';
import { buildDuckDbRunner, CustomRunnerRegistry } from '@bobsled-inc/dogsled/connections';
import { runProject } from '@bobsled-inc/dogsled/model-spec/project';

const customRunners = new CustomRunnerRegistry();
customRunners.register('duckdb', 'memory', async (integration) => {
  const runner = await buildDuckDbRunner(integration);
  await runner.run('INSTALL ducklake');
  await runner.run('LOAD ducklake');
  await runner.run("ATTACH 'ducklake:.dogsled/lake/catalog.ducklake' AS lake");
  await runner.run('USE lake');
  return runner;
});
const result = await runProject(process.cwd(), { integration: 'local_lake', customRunners });
assert.equal(result.ok, true, JSON.stringify(result));
process.stdout.write(JSON.stringify({ ok: result.ok }) + '\n');
