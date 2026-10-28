import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
assert.equal(process.env.NPM_TOKEN, undefined);
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
assert.equal(existsSync('/consumer/.npmrc'), false);
assert.equal(existsSync('/suite/pnpm-workspace.yaml'), false);
assert.equal(existsSync('/suite/node_modules'), false);
const lock = JSON.parse(readFileSync('/consumer/package-lock.json', 'utf8'));
let bundled = 0;
for (const [name, info] of Object.entries(lock.packages)) {
  if (!name.includes('node_modules/@bobsled-inc/') || name === 'node_modules/@bobsled-inc/dogsled')
    continue;
  assert.equal(info.inBundle, true, `Internal package was not bundled: ${name}`);
  assert.ok(
    !info.resolved?.startsWith('https:'),
    `Internal package fetched from a registry: ${name}`
  );
  bundled++;
}
assert.ok(bundled >= 15);
process.stdout.write(
  `Clean install verified: ${bundled} internal packages came from the tarball; no private registry fetches.\n`
);
const { execFileSync } = await import('node:child_process');
for (const command of [
  ['extract', 'run'],
  ['load', 'run'],
  ['model', 'compile'],
  ['entity-graph', 'status'],
  ['embed', 'run'],
]) {
  const help = execFileSync(process.execPath, [process.env.DOGSLED_E2E_CLI, ...command, '--help'], {
    encoding: 'utf8',
  });
  assert.match(
    help,
    new RegExp(`^Usage: dogsled ${command.join(' ')}\\b`, 'm'),
    `dogsled ${command.join(' ')} --help printed no usage`
  );
}
process.stdout.write(
  'Delegated command help verified for extract, load, model, entity-graph and embed.\n'
);
