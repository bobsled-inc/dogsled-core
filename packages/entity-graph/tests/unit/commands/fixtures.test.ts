import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findEntityGraphPackageRoot,
  resolveFixtureSourcePath,
} from '../../../src/commands/fixtures.js';

const temporaryDirectories: string[] = [];

function installedPackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-graph-fixtures-'));
  temporaryDirectories.push(root);
  const packageRoot = path.join(root, 'node_modules', '@bobsled-inc', 'entity-graph');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@bobsled-inc/entity-graph' })
  );
  return packageRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('entity graph fixtures', () => {
  it('finds the package root from a bundled dist file in an installed package', () => {
    const packageRoot = installedPackageRoot();
    expect(findEntityGraphPackageRoot(path.join(packageRoot, 'dist'))).toBe(packageRoot);
  });

  it('prefers the fixture shipped inside an installed package', () => {
    const packageRoot = installedPackageRoot();
    const shipped = path.join(packageRoot, 'fixtures', 'b2b-company-master');
    fs.mkdirSync(shipped, { recursive: true });
    expect(resolveFixtureSourcePath('b2b-company-master', packageRoot)).toBe(shipped);
  });

  it('reports a source-checkout-only fixture as missing from an installed package', () => {
    const packageRoot = installedPackageRoot();
    expect(resolveFixtureSourcePath('entity-resolution-sdk', packageRoot)).toBeUndefined();
  });

  it('falls back to the source checkout layout', () => {
    const packageRoot = findEntityGraphPackageRoot();
    expect(resolveFixtureSourcePath('b2b-company-master', packageRoot)).toBe(
      path.join(packageRoot, 'tests/fixtures/specs/resolutions')
    );
    expect(resolveFixtureSourcePath('entity-resolution-sdk', packageRoot)).toBe(
      path.resolve(packageRoot, '../../examples/entity-resolution-sdk')
    );
  });
});
