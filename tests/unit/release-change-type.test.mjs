import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHANGE_TYPES,
  autoReleaseBumpForChangeType,
  changeTypeForPullRequest,
  highestBump,
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

  it.each([
    ['major', 'major'],
    ['minor', 'minor'],
    ['patch', 'patch'],
    ['performance', 'patch'],
    ['dependencies', null],
    ['internal', 'patch'],
    ['documentation', 'patch'],
    ['tests', 'patch'],
    ['skip-release', null],
  ])('automatically releases %s as %s', (changeType, bump) => {
    expect(autoReleaseBumpForChangeType(changeType)).toBe(bump);
  });

  it('maps every accepted change type for automatic releases', () => {
    for (const changeType of CHANGE_TYPES)
      expect(() => autoReleaseBumpForChangeType(changeType)).not.toThrow();
    expect(() => autoReleaseBumpForChangeType('feature')).toThrow('Unsupported change type');
  });

  it.each([
    [[], null],
    [[null, null], null],
    [[null, 'patch'], 'patch'],
    [['patch', 'minor', null], 'minor'],
    [['major', 'patch', 'minor'], 'major'],
  ])('takes the highest of %j as %s', (bumps, expected) => {
    expect(highestBump(bumps)).toBe(expected);
  });

  it('rejects an unknown bump', () => {
    expect(() => highestBump(['patch', 'feature'])).toThrow('Unsupported release bump');
  });

  it('parses exactly one selected checkbox', () => {
    expect(parseChangeType(bodyFor('minor'))).toBe('minor');
  });

  it('rejects missing selections', () => {
    expect(() => parseChangeType(bodyFor(null))).toThrow('Exactly one');
    expect(() => parseChangeType('')).toThrow('empty');
    expect(() => parseChangeType('## Summary\n\nNo type')).toThrow('not found');
  });

  it('rejects two selections', () => {
    const body = '## Change Type\n\n- [x] `patch`\n- [X] `minor`\n\n## Notes\n';
    expect(() => parseChangeType(body)).toThrow('Found 2: patch, minor');
  });

  it('rejects an unknown selection', () => {
    expect(() => parseChangeType('## Change Type\n\n- [x] `feature`\n')).toThrow(
      'Invalid change-type label: "feature"'
    );
  });

  it('ignores checkboxes outside the Change Type section', () => {
    const body = '## Checklist\n\n- [x] `major`\n\n## Change Type\n\n- [x] `tests`\n';
    expect(parseChangeType(body)).toBe('tests');
  });

  it('treats Dependabot pull requests as dependency updates and parses everyone else', () => {
    expect(changeTypeForPullRequest({ user: { login: 'dependabot[bot]' }, body: '' })).toBe(
      'dependencies'
    );
    expect(
      changeTypeForPullRequest({ user: { login: 'contributor' }, body: bodyFor('major') })
    ).toBe('major');
    expect(() => changeTypeForPullRequest({ user: { login: 'contributor' }, body: null })).toThrow(
      'empty'
    );
  });

  const dependabot = (...names) => ({
    user: { login: 'dependabot[bot]' },
    body: '',
    labels: names.map((name) => ({ name })),
  });

  it.each([
    [['dependencies'], 'dependencies'],
    [['dependencies', 'change-type: patch'], 'patch'],
    [['change-type: minor'], 'minor'],
    [['Change-Type: Major', 'javascript'], 'major'],
  ])('reads the change type of a Dependabot PR from labels %j as %s', (labels, changeType) => {
    expect(changeTypeForPullRequest(dependabot(...labels))).toBe(changeType);
  });

  it('rejects conflicting change-type labels on a Dependabot PR', () => {
    expect(() =>
      changeTypeForPullRequest(dependabot('change-type: patch', 'change-type: minor'))
    ).toThrow('At most one change-type label may be set on a Dependabot PR. Found 2');
  });

  it('ignores change-type labels on other PRs and reads their description', () => {
    expect(
      changeTypeForPullRequest({
        user: { login: 'contributor' },
        body: bodyFor('dependencies'),
        labels: [{ name: 'change-type: major' }],
      })
    ).toBe('dependencies');
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

  it('keeps the package on a releasable version after the 0.1.0 bootstrap', () => {
    const version = currentPackageVersion();
    expect(() => assertReleaseVersion(version)).not.toThrow();
    expect(() => bootstrapVersion(version, ['v0.1.0'])).toThrow();
    expect(
      publicationPolicy({ access: 'restricted', visibility: 'private', version })
    ).toMatchObject({ provenance: false });
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
      name: '@bobsled-inc/bobsled-core',
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
