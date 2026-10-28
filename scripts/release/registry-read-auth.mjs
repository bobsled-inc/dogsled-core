import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function withRegistryReadAuth(request, read, env = process.env) {
  if (request.visibility !== 'private' || request.bootstrap) return read(env);
  if (!env.NPM_READ_TOKEN) throw new Error('Restricted OIDC releases require NPM_READ_TOKEN.');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'npm-integrity-'));
  const config = path.join(directory, '.npmrc');
  try {
    writeFileSync(config, '//registry.npmjs.org/:_authToken=${NPM_READ_TOKEN}\n', { mode: 0o600 });
    return await read({ ...env, NPM_CONFIG_USERCONFIG: config });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
