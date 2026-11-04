import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReleaseVersion,
  verifyRetryTag,
  verifyReleaseCandidate,
} from '../../scripts/release/version.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-retry-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.test');
  mkdirSync(path.join(root, 'packages/dogsled'), { recursive: true });
  const manifest = path.join(root, 'packages/dogsled/package.json');
  writeFileSync(manifest, '{"version":"0.1.0"}');
  git('add', '.');
  git('commit', '-qm', 'Reviewed base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  return { root, git, manifest, base };
}
describe('retry release ancestry', () => {
  it('runs trusted tag verification and publish entrypoints without dependencies installed', () => {
    const r = repository();
    for (const file of [
      'release/version.mjs',
      'release/auto-release.mjs',
      'release/change-type.mjs',
      'release/package-set.mjs',
      'ci/shared.mjs',
      'ci/source-files.mjs',
      'release/publish.mjs',
      'release/registry-integrity.mjs',
      'release/registry-read-auth.mjs',
      'release/publication-policy.mjs',
      'release/access.mjs',
      'security/lib.mjs',
    ]) {
      const target = path.join(r.root, 'scripts', file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(new URL('../../scripts/' + file, import.meta.url), target);
    }
    const env = {
      ...process.env,
      RELEASE_COMMIT: r.base,
      GITHUB_SHA: r.base,
      RELEASE_MODE: 'bootstrap',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'bobsled-inc/dogsled-core',
    };
    const tag = spawnSync(process.execPath, ['scripts/release/version.mjs', 'verify-candidate'], {
      cwd: r.root,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(tag.stderr).toBe('');
    expect(tag.status).toBe(0);
    writeFileSync(
      r.manifest,
      JSON.stringify({ name: '@bobsled-inc/dogsled', version: '0.1.0', private: false })
    );
    const output = path.join(r.root, 'outputs');
    const preview = spawnSync(
      process.execPath,
      ['scripts/release/version.mjs', 'prepare-preview'],
      {
        cwd: r.root,
        env: { ...env, RELEASE_VERSION: '0.1.1-preview.1', GITHUB_OUTPUT: output },
        encoding: 'utf8',
        timeout: 15000,
      }
    );
    expect(preview.status).toBe(0);
    expect(JSON.parse(readFileSync(r.manifest, 'utf8')).version).toBe('0.1.1-preview.1');
    expect(readFileSync(output, 'utf8')).toContain('prerelease=true');
    expect(readFileSync(output, 'utf8')).toContain('tag=v0.1.1-preview.1');
    const publish = spawnSync(process.execPath, ['scripts/release/publish.mjs'], {
      cwd: r.root,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(publish.status).toBe(1);
    expect(publish.stderr).toContain('Usage: node scripts/release/publish.mjs');
    expect(publish.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('validates the version before using a tag', () => {
    expect(() => assertReleaseVersion('../branch')).toThrow('stable X.Y.Z');
  });
  it('accepts a bootstrap tag on reviewed main', () => {
    const r = repository();
    r.git('tag', 'v0.1.0');
    expect(verifyRetryTag('0.1.0', r.root)).toBe(r.base);
  });
  it('accepts only the release manifest commit after reviewed main', () => {
    const r = repository();
    writeFileSync(r.manifest, '{"version":"0.1.1"}');
    r.git('add', '.');
    r.git('commit', '-qm', 'Version only');
    r.git('tag', 'v0.1.1');
    expect(verifyRetryTag('0.1.1', r.root)).toBe(r.git('rev-parse', 'HEAD'));
  });
  it('rejects changed scripts even when the manifest is the only changed file', () => {
    const r = repository();
    writeFileSync(
      r.manifest,
      JSON.stringify({ version: '0.1.1', scripts: { build: 'unreviewed' } })
    );
    r.git('add', '.');
    r.git('commit', '-qm', 'Changed script');
    r.git('tag', 'v0.1.1');
    expect(() => verifyRetryTag('0.1.1', r.root)).toThrow('only version');
    expect(() =>
      verifyReleaseCandidate(
        { commit: r.git('rev-parse', 'HEAD'), base: r.base, mode: 'new' },
        r.root
      )
    ).toThrow('only version');
  });
  it('accepts only the dispatched bootstrap or its version-only child before pushing', () => {
    const r = repository();
    expect(() =>
      verifyReleaseCandidate({ commit: r.base, base: r.base, mode: 'bootstrap' }, r.root)
    ).not.toThrow();
    writeFileSync(r.manifest, '{"version":"0.1.1"}');
    r.git('add', '.');
    r.git('commit', '-qm', 'Version only');
    const commit = r.git('rev-parse', 'HEAD');
    expect(() =>
      verifyReleaseCandidate({ commit, base: r.base, mode: 'new' }, r.root)
    ).not.toThrow();
    expect(() =>
      verifyReleaseCandidate({ commit, base: r.base, mode: 'bootstrap' }, r.root)
    ).toThrow('equal the dispatched');
    expect(() => verifyReleaseCandidate({ commit, base: commit, mode: 'new' }, r.root)).toThrow(
      'parent must equal'
    );
  });
  it('accepts a preview version-only tag and rejects a stable/preview mode mismatch', () => {
    const r = repository();
    writeFileSync(r.manifest, '{"version":"0.1.1-preview.1"}');
    r.git('add', '.');
    r.git('commit', '-qm', 'Preview version');
    r.git('tag', 'v0.1.1-preview.1');
    const commit = r.git('rev-parse', 'HEAD');
    expect(verifyRetryTag('0.1.1-preview.1', r.root)).toBe(commit);
    expect(() =>
      verifyReleaseCandidate({ commit, base: r.base, mode: 'preview' }, r.root)
    ).not.toThrow();
    expect(() => verifyReleaseCandidate({ commit, base: r.base, mode: 'new' }, r.root)).toThrow(
      'mode differs'
    );
    r.git('tag', 'v0.1.2-preview.1');
    expect(() => verifyRetryTag('0.1.2-preview.1', r.root)).toThrow('manifest version');
  });

  it('rejects other file changes in the release commit', () => {
    const r = repository();
    writeFileSync(path.join(r.root, 'runtime.js'), 'changed');
    r.git('add', '.');
    r.git('commit', '-qm', 'Unreviewed code');
    r.git('tag', 'v0.1.1');
    expect(() => verifyRetryTag('0.1.1', r.root)).toThrow('may change only');
  });
  it('rejects a release whose parent is outside reviewed main', () => {
    const r = repository();
    writeFileSync(path.join(r.root, 'runtime.js'), 'changed');
    r.git('add', '.');
    r.git('commit', '-qm', 'Unreviewed parent');
    writeFileSync(r.manifest, '{"version":"0.1.1"}');
    r.git('add', '.');
    r.git('commit', '-qm', 'Version');
    r.git('tag', 'v0.1.1');
    expect(() => verifyRetryTag('0.1.1', r.root)).toThrow('parent is not on reviewed main');
  });
});
