import { cp, mkdir, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliPath, publicApi } from './harness.mjs';
export async function copyProject(ctx, url) {
  const directory = fileURLToPath(url);
  await mkdir(ctx.project, { recursive: true });
  for (const name of await readdir(directory)) {
    if (['README.md', 'showcase.mjs'].includes(name)) continue;
    await cp(path.join(directory, name), path.join(ctx.project, name), { recursive: true });
  }
  await mkdir(path.join(ctx.project, 'node_modules/@bobsled-inc'), { recursive: true });
  await symlink(
    path.dirname(path.dirname(cliPath)),
    path.join(ctx.project, 'node_modules/@bobsled-inc/dogsled'),
    'dir'
  );
}
export async function duckdb(ctx, action, db = 'data.duckdb') {
  const { buildDuckDbRunner } = await publicApi('connections');
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'local_duckdb',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: path.join(ctx.project, db) },
  });
  try {
    return await action(runner);
  } finally {
    await runner.close?.();
  }
}
