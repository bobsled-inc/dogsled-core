import { deepEqual, equal, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it } from 'vitest';

import {
  isForbiddenPackageEntry,
  packageImportSpecifiers,
} from '../../scripts/security/release-policy.mjs';

describe('release package entry policy', () => {
  it('rejects private source, test, instruction, review, and environment files', () => {
    for (const entry of [
      'package/src/index.ts',
      'package/test/unit.test.js',
      'package/tests/unit.test.js',
      'package/AGENTS.md',
      'package/CLAUDE.md',
      'package/.env',
      'package/config/.env.production',
      'package/.security-review/report.json',
    ]) {
      equal(isForbiddenPackageEntry(entry), true, entry);
    }
  });

  it('allows only the root AGENTS.md of an example Project', () => {
    equal(isForbiddenPackageEntry('package/examples/retail/AGENTS.md'), false);
    for (const entry of [
      'package/dist/AGENTS.md',
      'package/examples/AGENTS.md',
      'package/examples/retail/nested/AGENTS.md',
      'package/examples/retail/CLAUDE.md',
      'package/examples/retail/.security-review/report.json',
      'package/examples/AGENTS.md/CLAUDE.md',
      'other/examples/retail/AGENTS.md',
    ]) {
      equal(isForbiddenPackageEntry(entry), true, entry);
    }
  });

  it('allows intentional public APIs whose filenames contain test-like words', () => {
    for (const entry of [
      'package/dist/test-stubs.js',
      'package/dist/test-stubs.d.ts',
      'package/dist/contest.js',
    ]) {
      equal(isForbiddenPackageEntry(entry), false, entry);
    }
  });

  it('allows source files from bundled third-party dependencies', () => {
    for (const entry of [
      'package/node_modules/zod/src/index.ts',
      'package/node_modules/zod/tests/basic.test.ts',
    ]) {
      equal(isForbiddenPackageEntry(entry), false, entry);
    }
  });
});

describe('package import smoke policy', () => {
  it('enumerates explicit public export subpaths', () => {
    deepEqual(
      packageImportSpecifiers({
        name: '@bobsled-inc/example',
        exports: {
          '.': './dist/index.js',
          './runtime': './dist/runtime.js',
          './features/*': './dist/features/*.js',
        },
      }),
      ['@bobsled-inc/example', '@bobsled-inc/example/runtime']
    );
  });

  it('smokes the package root for conditional root exports', () => {
    deepEqual(
      packageImportSpecifiers({
        name: '@bobsled-inc/example',
        exports: { import: './dist/index.js', default: './dist/index.js' },
      }),
      ['@bobsled-inc/example']
    );
  });
});

describe('release CLI smoke targets', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkgJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/dogsled/package.json'), 'utf8')
  );
  const releaseSrc = readFileSync(path.join(repoRoot, 'scripts/security/release.mjs'), 'utf8');

  it('package declares at least one bin entry', () => {
    ok(pkgJson.bin, 'packages/dogsled/package.json must declare bin');
    const binNames = Object.keys(pkgJson.bin);
    ok(binNames.length > 0, 'at least one bin entry required');
  });

  it('release script loads and runs in deferred mode', () => {
    const result = execFileSync(process.execPath, ['scripts/security/release.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = JSON.parse(result);
    equal(output.status, 'deferred');
    ok(output.packageCount >= 1, 'reports at least one package');
  });

  it('release script reads bin entries from the manifest, not hard-coded paths', () => {
    ok(
      releaseSrc.includes('stagedManifest.bin'),
      'release.mjs must read bin entries from stagedManifest.bin'
    );
    // The only hard-coded .bin/ path allowed is the one declared in package.json.
    // Any other .bin/<name> literal means a retired CLI name leaked back in.
    const binPattern = /\.bin['"],\s*['"]([a-z-]+)['"]/g;
    const hardCodedBins = [...releaseSrc.matchAll(binPattern)].map((m) => m[1]);
    const declared = new Set(Object.keys(pkgJson.bin));
    for (const name of hardCodedBins) {
      ok(
        declared.has(name),
        `release.mjs hard-codes .bin/${name} which is not in package.json bin`
      );
    }
  });
});
