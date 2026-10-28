import { resolveRunner } from '@bobsled-inc/dogsled/connections';
async function withRunner(method, sql) {
  const runner = await resolveRunner({
    spec_version: '1',
    type: 'integration',
    name: 'local_pg',
    source_type: 'postgres',
    connection: {
      host: '127.0.0.1',
      port: Number(process.env.SHOWCASE_PG_PORT),
      database: 'showcase',
      schema: 'pipeline',
      ssl: { mode: 'disable' },
    },
    auth: { type: 'password', user: 'postgres', password: 'unused-local-only' },
  });
  try {
    return await runner[method](sql);
  } finally {
    await runner.close?.();
  }
}
export const run = (sql) => withRunner('run', sql);
export const query = (sql) => withRunner('query', sql);
