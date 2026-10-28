import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { mockApi, postgresFlags } from '../../scripts/e2e/services.mjs';
import { copyProject } from '../../scripts/e2e/fixtures.mjs';
import { showcaseData } from '../../scripts/e2e/mock-data.mjs';
export const id = 'S23';
export async function run(ctx) {
  await copyProject(ctx, new URL('./', import.meta.url));
  const password = `synthetic-${randomUUID()}`;
  const token = `synthetic-${randomUUID()}`;
  ctx.env.FAKE_DB_PASSWORD = password;
  const { datasets } = showcaseData('secret-redaction');
  const api = await mockApi(ctx, datasets, { token });
  try {
    await ctx.cli([
      'pipeline',
      '--integration',
      'shop_api',
      '--resource',
      'events',
      '--dest',
      'duckdb',
      '--db-path',
      'data.duckdb',
      '--verbose',
      '--log-format',
      'json',
    ]);
    api.assertAuth();
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const failure = await ctx.cli(
      [
        'pipeline',
        '--integration',
        'shop_api',
        '--resource',
        'events',
        '--full-refresh',
        '--dest',
        'postgres',
        ...postgresFlags(port),
        '--postgres-password',
        '$FAKE_DB_PASSWORD',
        '--log-format',
        'json',
      ],
      { expected: null }
    );
    assert.notEqual(failure.code, 0);
    const table = await ctx.sql('SELECT * FROM events');
    const texts = [
      ...ctx.outputs.flatMap((result) => [result.stdout, result.stderr]),
      JSON.stringify(table),
    ];
    for (const name of await readdir(ctx.project, { recursive: true, withFileTypes: true })) {
      if (!name.isFile()) continue;
      const data = await readFile(path.join(name.parentPath, name.name));
      for (const secret of [password, token])
        assert.ok(
          !data.includes(Buffer.from(secret)),
          'Resolved credential persisted in a project file'
        );
    }
    for (const text of texts)
      for (const secret of [password, token])
        assert.ok(
          !text.includes(secret),
          'Resolved credential appeared in output, state, config, or data'
        );
    assert.match(await ctx.read('integrations/shop_api.yml'), /SHOWCASE_API_TOKEN/);
  } finally {
    await api.close();
  }
}
