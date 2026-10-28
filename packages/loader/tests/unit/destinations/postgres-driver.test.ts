import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('initializes the default pg pool in a real ESM process without a database', () => {
  const directory = path.resolve(import.meta.dirname, '../../..');
  const module = pathToFileURL(path.join(directory, 'src/runtime/destinations/postgres.ts')).href;
  const source = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { Pool } = require('pg');
    const queries = [];
    let releases = 0;
    Pool.prototype.connect = async () => ({ query: async (sql) => { queries.push(sql); return { rows: [], rowCount: 0 }; }, release() { releases++; } });
    Pool.prototype.end = async () => {};
    const { PostgresDestination } = await import(${JSON.stringify(module)});
    const destination = new PostgresDestination({ host: '127.0.0.1', database: 'example', username: 'example', password: 'synthetic-local-only' });
    await destination.initialize();
    await destination.close();
    assert.deepEqual(queries, ['CREATE SCHEMA IF NOT EXISTS "public"']);
    assert.equal(releases, 1);
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH },
    }
  );
  expect(result.status, result.stderr).toBe(0);
}, 20000);
