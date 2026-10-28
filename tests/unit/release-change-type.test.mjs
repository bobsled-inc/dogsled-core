import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHANGE_TYPES,
  parseChangeType,
  releaseBumpForChangeType,
} from '../../scripts/release/change-type.mjs';
import { publishAccessForPackages } from '../../scripts/release/access.mjs';
import {
  incrementVersion,
  previewVersion,
  assertReleaseVersion,
  bootstrapVersion,
  currentPackageVersion,
  releaseBaseVersion,
  stampVersion,
} from '../../scripts/release/version.mjs';
import { publicationPolicy } from '../../scripts/release/publication-policy.mjs';

function bodyFor(changeType) {
  return `## Change Type

- [${changeType ? 'x' : ' '}] \`${changeType ?? 'patch'}\`

## Summary

Test`;
}

describe('release change types', () => {
  it.each([
    ['major', 'major'],
    ['minor', 'minor'],
    ['patch', 'patch'],
    ['internal', 'patch'],
    ['documentation', 'patch'],
    ['tests', 'patch'],
    ['dependencies', 'patch'],
    ['performance', 'patch'],
    ['skip-release', null],
  ])('maps %s to %s', (changeType, bump) => {
    expect(releaseBumpForChangeType(changeType)).toBe(bump);
  });

  it('parses exactly one selected checkbox', () => {
    expect(parseChangeType(bodyFor('minor'))).toBe('minor');
  });

  it('rejects missing selections', () => {
    expect(() => parseChangeType(bodyFor(null))).toThrow('Exactly one');
  });

  it('keeps the accepted values explicit', () => {
    expect(CHANGE_TYPES).toHaveLength(9);
  });

  it.each([
    ['0.20.224', 'patch', '0.20.225'],
    ['0.20.224', 'minor', '0.21.0'],
    ['0.20.224', 'major', '0.21.0'],
    ['1.2.3', 'major', '2.0.0'],
  ])('increments %s with %s to %s', (version, bump, expected) => {
    expect(incrementVersion(version, bump)).toBe(expected);
  });

  it('advances preview tags without affecting stable bump selection', () => {
    expect(previewVersion('0.1.0', ['v0.1.1-preview.1'], '0.1.1-preview.2')).toBe(
      '0.1.1-preview.2'
    );
    expect(releaseBaseVersion('0.1.0', ['v0.1.1-preview.2'])).toBe('0.1.0');
    expect(() => previewVersion('0.1.0', ['v0.1.1-preview.2'], '0.1.1-preview.2')).toThrow(
      'advance'
    );
    expect(() => previewVersion('0.1.1', [], '0.1.1-preview.3')).toThrow('advance');
  });

  it.each([
    '1.0.0-preview.1',
    '0.1.1-beta.1',
    '0.1.1-preview.01',
    '0.01.1-preview.1',
    '0.1.1-preview.1+build',
    '../branch',
  ])('rejects unsupported preview %s', (version) => {
    expect(() => previewVersion('0.1.0', [], version)).toThrow('0.x.y-preview.N');
    expect(() => assertReleaseVersion(version)).toThrow();
  });

  it('bootstraps exactly 0.1.0 once without bumping', () => {
    expect(bootstrapVersion('0.1.0', [])).toBe('0.1.0');
    expect(() => bootstrapVersion('0.62.0', [])).toThrow('0.1.0');
    expect(() => bootstrapVersion('0.1.0', ['v0.1.0'])).toThrow('first stable');
  });

  it('prepares the reviewed package for its first restricted publication', () => {
    const version = currentPackageVersion();
    expect(bootstrapVersion(version, [])).toBe('0.1.0');
    expect(
      publicationPolicy({ access: 'restricted', visibility: 'private', version, bootstrap: true })
    ).toEqual({ provenance: false, distTag: 'latest' });
  });

  it('uses the newest release tag when main package manifests are older', () => {
    expect(releaseBaseVersion('0.20.224', ['v0.20.225', 'v0.19.999', 'not-a-release'])).toBe(
      '0.20.225'
    );
  });

  it('uses the package version when it is newer than every release tag', () => {
    expect(releaseBaseVersion('0.20.224', ['v0.20.223'])).toBe('0.20.224');
  });
});

describe('release package access', () => {
  const packageWithAccess = (access) => ({ packageJson: { publishConfig: { access } } });

  it.each(['restricted', 'public'])('accepts a uniform %s release', (access) => {
    expect(publishAccessForPackages([packageWithAccess(access), packageWithAccess(access)])).toBe(
      access
    );
  });

  it('rejects mixed package visibility', () => {
    expect(() =>
      publishAccessForPackages([packageWithAccess('restricted'), packageWithAccess('public')])
    ).toThrow('uniformly public or restricted');
  });

  it.each([[[]], [[packageWithAccess('private')]], [[{ packageJson: {} }]]])(
    'rejects missing or unsupported package visibility',
    (packages) => {
      expect(() => publishAccessForPackages(packages)).toThrow('uniformly public or restricted');
    }
  );
});

describe('stampVersion', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('writes the new version, preserving all other fields', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'stamp-version-test-'));
    const pkgPath = path.join(tempDir, 'package.json');
    const original = {
      name: '@bobsled-inc/dogsled',
      version: '0.62.0',
      description: 'CLI',
      private: false,
    };
    writeFileSync(pkgPath, `${JSON.stringify(original, null, 2)}\n`);

    stampVersion('0.0.0-test.1', pkgPath);

    const result = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(result.version).toBe('0.0.0-test.1');
    expect(result.name).toBe(original.name);
    expect(result.description).toBe(original.description);
    expect(result.private).toBe(original.private);
  });

  it('overwrites an existing prerelease version', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'stamp-version-test-'));
    const pkgPath = path.join(tempDir, 'package.json');
    writeFileSync(pkgPath, `${JSON.stringify({ name: 'x', version: '0.0.0-old.1' }, null, 2)}\n`);

    stampVersion('0.0.0-new.2', pkgPath);

    expect(JSON.parse(readFileSync(pkgPath, 'utf8')).version).toBe('0.0.0-new.2');
  });
});
