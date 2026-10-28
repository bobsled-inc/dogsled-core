import { buildDuckDbRunner } from '@bobsled-inc/dogsled/connections';
async function withRunner(method, sql) {
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'local_duckdb',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: './data.duckdb' },
  });
  try {
    return await runner[method](sql);
  } finally {
    await runner.close?.();
  }
}
export const run = (sql) => withRunner('run', sql);
export const query = (sql) => withRunner('query', sql);
