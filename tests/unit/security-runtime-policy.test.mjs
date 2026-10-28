import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function runPolicy(url) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-policy-'));
  roots.push(root);
  for (const relative of [
    'security/policy.mjs',
    'security/lib.mjs',
    'ci/shared.mjs',
    'ci/source-files.mjs',
  ]) {
    const target = path.join(root, 'scripts', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(new URL('../../scripts/' + relative, import.meta.url), target);
  }
  mkdirSync(path.join(root, 'packages/demo/src'), { recursive: true });
  writeFileSync(path.join(root, 'packages/demo/src/client.ts'), `fetch(${JSON.stringify(url)});\n`);
  writeFileSync(
    path.join(root, 'EXPORT-MANIFEST.json'),
    JSON.stringify({ files: [{ path: 'packages/demo/src/client.ts' }] })
  );
  const result = spawnSync(process.execPath, ['scripts/security/policy.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, ...JSON.parse(result.stdout) };
}

describe('operator-controlled runtime network policy', () => {
  it.each([
    'https://dogsledai.com',
    'https://dogsled.cloud',
    'https://dogsledai.com/events',
    'https://api.dogsledai.com/query',
    'https://telemetry.dogsled.ai/collect',
    'https://events.dogsled.cloud/collect',
    'https://dogsled.co/api',
    'https://dogsled.com/api',
    'https://dogsled.it/api',
    'https://api.bobsled.co/query',
  ])('rejects an undeclared maintainer endpoint: %s', (url) => {
    const report = runPolicy(url);
    expect(report.status).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({ rule: 'bobsled-operated-runtime-endpoint' }),
    ]);
  });

  it.each(['https://api.example.com/query', 'https://dogsledai.com.example.org/query'])(
    'allows an unrelated operator endpoint: %s',
    (url) => {
      const report = runPolicy(url);
      expect(report.status).toBe(0);
      expect(report.findings).toEqual([]);
    }
  );
});
