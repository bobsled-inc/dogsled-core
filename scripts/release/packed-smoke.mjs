import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function smokePackedData(scratch, packageName, run = spawnSync) {
  const project = path.join(scratch, 'packed-data-smoke');
  for (const directory of ['data', 'integrations', 'resources/local_files'])
    mkdirSync(path.join(project, directory), { recursive: true });
  const writeJson = (file, value) => writeFileSync(path.join(project, file), JSON.stringify(value));
  writeFileSync(path.join(project, 'data/rows.csv'), 'id,amount\n1,10\n2,20\n');
  writeJson('extractor.yml', {
    integrations_dir: 'integrations',
    resources_dir: 'resources',
    state_dir: '.extractor',
    output_dir: 'output',
  });
  writeJson('integrations/local_files.yml', {
    spec_version: '1',
    type: 'integration',
    name: 'local_files',
    source_type: 'local',
    connection: { base_directory: 'data' },
    auth: { type: 'none' },
  });
  writeJson('resources/local_files/rows.yml', {
    spec_version: '1',
    type: 'resource',
    name: 'rows',
    integration: 'local_files',
    source: { path: 'rows.csv', format: 'csv', options: { header: true } },
    replication: { method: 'full_refresh' },
    extract: { table: { primary_key: ['id'], load_strategy: 'full_refresh' } },
    output: { id: { type: 'integer' }, amount: { type: 'integer' } },
  });
  const bin = path.join(scratch, 'node_modules', ...packageName.split('/'), 'bin/cli.mjs');
  const cli = (args, input) => {
    const result = run(process.execPath, [bin, ...args], {
      cwd: project,
      encoding: 'utf8',
      input,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Packed data smoke failed: ${args[0]} ${result.stderr ?? ''}`);
    return result.stdout;
  };
  const records = cli(['extract', 'run', '--integration', 'local_files', 'rows']);
  cli(['load', 'run', '--dest', 'duckdb', '--db-path', 'smoke.duckdb'], records);
  const result = JSON.parse(
    cli([
      'query',
      'SELECT count(*) AS n, sum(amount) AS total FROM rows',
      '--db-path',
      'smoke.duckdb',
    ])
  );
  const row = result.rows?.[0];
  if (Number(row?.n) !== 2 || Number(row?.total) !== 30)
    throw new Error('Packed CSV → DuckDB → query returned incorrect data.');
  return { rows: 2, total: 30 };
}
