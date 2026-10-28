import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizeGitHubRelease,
  parseAssetSpecs,
} from '../../scripts/release/finalize-github-release.mjs';

const repo = 'example/toolkit';
const tag = 'v0.2.0';
const commit = 'c'.repeat(40);
const tagObject = 'a'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WRITES = new Set(['create', 'upload', 'edit']);

function fakeGh({ release = null, tagCommit = commit, digests = true, viewError } = {}) {
  const state = { release, calls: [] };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr) => ({ status: 1, stdout: '', stderr });
  const view = () => ({
    tagName: state.release.tagName,
    isDraft: state.release.isDraft,
    isPrerelease: state.release.isPrerelease,
    assets: state.release.assets.map(({ bytes, ...asset }) => ({
      ...asset,
      digest: digests && asset.state === 'uploaded' ? `sha256:${sha256(bytes)}` : null,
    })),
  });
  const add = (spec) => {
    const file = spec.split('#')[0];
    state.release.assets.push({
      name: path.basename(file),
      state: 'uploaded',
      bytes: readFileSync(file),
    });
  };
  state.run = (args) => {
    state.calls.push(args);
    const [command, sub, target] = args;
    if (command === 'api' && sub === `repos/${repo}/git/ref/tags/${tag}`)
      return ok(JSON.stringify({ object: { type: 'tag', sha: tagObject } }));
    if (command === 'api' && sub === `repos/${repo}/git/tags/${tagObject}`)
      return ok(JSON.stringify({ object: { type: 'commit', sha: tagCommit } }));
    if (command !== 'release' || target !== tag) return fail(`unexpected gh ${args.join(' ')}`);
    const specs = args.slice(5).filter((arg) => !arg.startsWith('--'));
    switch (sub) {
      case 'view':
        if (viewError) return fail(viewError);
        return state.release ? ok(JSON.stringify(view())) : fail('release not found');
      case 'create':
        if (state.release) return fail('a release with the same tag name already exists');
        state.release = {
          tagName: tag,
          isDraft: false,
          isPrerelease: args.includes('--prerelease'),
          assets: [],
        };
        specs.forEach(add);
        return ok();
      case 'upload':
        for (const spec of args.slice(5)) {
          const name = path.basename(spec.split('#')[0]);
          if (state.release.assets.some((asset) => asset.name === name))
            return fail(`asset under the same name already exists: [${name}]`);
        }
        args.slice(5).forEach(add);
        return ok();
      case 'download':
        return ok(state.release.assets.find((asset) => asset.name === args[6]).bytes);
      case 'edit':
        if (args.includes('--draft=false')) state.release.isDraft = false;
        return ok();
      default:
        return fail(`unexpected gh ${args.join(' ')}`);
    }
  };
  state.writes = () =>
    state.calls.filter(([command, sub]) => command === 'release' && WRITES.has(sub));
  return state;
}

let dir;
let report;
let sbom;
let assets;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'finalize-release-'));
  report = path.join(dir, 'release-report.json');
  sbom = path.join(dir, 'sbom.json');
  writeFileSync(report, '{"passed":true}\n');
  writeFileSync(sbom, '{"bomFormat":"CycloneDX"}\n');
  assets = [`${report}#npm release artifact report`, `${sbom}#CycloneDX SBOM`];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const uploaded = (file, bytes = readFileSync(file)) => ({
  name: path.basename(file),
  state: 'uploaded',
  bytes,
});
const existing = (overrides = {}) => ({
  tagName: tag,
  isDraft: false,
  isPrerelease: false,
  assets: [uploaded(report), uploaded(sbom)],
  ...overrides,
});
const finalize = (gh, overrides = {}) =>
  finalizeGitHubRelease({ repo, tag, commit, prerelease: false, assets, ...overrides }, gh.run);

describe('idempotent GitHub release finalization', () => {
  it('creates a missing release with notes, the verified tag and both attachments', () => {
    const gh = fakeGh();
    expect(finalize(gh)).toEqual({ tag, commit, created: true, uploaded: [], published: false });
    expect(gh.writes()).toEqual([
      ['release', 'create', tag, '--repo', repo, '--verify-tag', '--generate-notes', ...assets],
    ]);
    expect(gh.release.assets.map((asset) => asset.name)).toEqual([
      'release-report.json',
      'sbom.json',
    ]);
  });

  it('creates previews as prereleases that never become latest', () => {
    const gh = fakeGh();
    finalize(gh, { prerelease: true });
    expect(gh.writes()[0]).toEqual(
      expect.arrayContaining(['--prerelease', '--latest=false', ...assets])
    );
    expect(gh.release.isPrerelease).toBe(true);
  });

  it('uploads only the attachments a previous attempt did not finish', () => {
    const gh = fakeGh({ release: existing({ assets: [uploaded(report)] }) });
    expect(finalize(gh)).toMatchObject({ created: false, uploaded: ['sbom.json'] });
    expect(gh.writes()).toEqual([['release', 'upload', tag, '--repo', repo, assets[1]]]);
  });

  it('publishes a draft left by an interrupted create after completing its attachments', () => {
    const gh = fakeGh({
      release: existing({ isDraft: true, isPrerelease: true, assets: [uploaded(report)] }),
    });
    expect(finalize(gh, { prerelease: true })).toMatchObject({
      uploaded: ['sbom.json'],
      published: true,
    });
    expect(gh.writes()).toEqual([
      ['release', 'upload', tag, '--repo', repo, assets[1]],
      ['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false'],
    ]);
  });

  it.each([true, false])(
    'makes no changes when every attachment matches (digest=%j)',
    (digests) => {
      const gh = fakeGh({ release: existing(), digests });
      expect(finalize(gh)).toEqual({ tag, commit, created: false, uploaded: [], published: false });
      expect(gh.writes()).toEqual([]);
      const downloads = gh.calls.filter(([, sub]) => sub === 'download');
      expect(downloads.length).toBe(digests ? 0 : 4);
    }
  );

  it.each([true, false])(
    'fails loudly without overwriting an attachment whose bytes differ (digest=%j)',
    (digests) => {
      const changed = uploaded(sbom, Buffer.from('{"bomFormat":"other"}\n'));
      const gh = fakeGh({ release: existing({ assets: [uploaded(report), changed] }), digests });
      expect(() => finalize(gh)).toThrow(
        /sbom\.json differs from the reviewed local file.*Refusing to overwrite or delete/
      );
      expect(gh.writes()).toEqual([]);
    }
  );

  it('fails before any release change when the tag points at another commit', () => {
    const gh = fakeGh({ release: existing({ assets: [] }), tagCommit: 'd'.repeat(40) });
    expect(() => finalize(gh)).toThrow(`Tag ${tag} points at ${'d'.repeat(40)}`);
    expect(gh.calls.some(([command, sub]) => command === 'release' && sub === 'view')).toBe(false);
    expect(gh.writes()).toEqual([]);
  });

  it('fails when an existing release targets another tag or prerelease setting', () => {
    const other = fakeGh({ release: existing({ tagName: 'v0.1.0', assets: [] }) });
    expect(() => finalize(other)).toThrow('targets tag v0.1.0');
    const stable = fakeGh({ release: existing({ assets: [] }) });
    expect(() => finalize(stable, { prerelease: true })).toThrow('prerelease=false');
    expect([...other.writes(), ...stable.writes()]).toEqual([]);
  });

  it('fails on an incomplete upload instead of replacing it', () => {
    const partial = { ...uploaded(sbom), state: 'starter' };
    const gh = fakeGh({ release: existing({ assets: [uploaded(report), partial] }) });
    expect(() => finalize(gh)).toThrow('incomplete upload');
    expect(gh.writes()).toEqual([]);
  });

  it('fails closed when the release lookup itself fails', () => {
    const gh = fakeGh({ viewError: 'HTTP 502: Bad Gateway' });
    expect(() => finalize(gh)).toThrow('gh release view failed: HTTP 502');
    expect(gh.writes()).toEqual([]);
  });

  it('rejects malformed inputs before contacting GitHub', () => {
    const gh = fakeGh();
    expect(() => finalize(gh, { tag: 'main' })).toThrow('version tag');
    expect(() => finalize(gh, { commit: 'abc' })).toThrow('full release commit');
    expect(() => finalize(gh, { prerelease: 'true' })).toThrow('boolean');
    expect(() => finalize(gh, { assets: [] })).toThrow('At least one');
    expect(() => parseAssetSpecs([`${report}#a`, `${report}#b`])).toThrow('Duplicate');
    expect(gh.calls).toEqual([]);
  });
});
