import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { verifyPublicationPolicy } from '../../scripts/release/publication-policy.mjs';

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
);
const prepareSteps = workflow.jobs.prepare.steps;
const policyStep = prepareSteps.find(
  (step) => step.name === 'Require package access to match repository visibility'
);
const pushStep = workflow.jobs.tag.steps.at(-1);
/** GitHub runs a step without an explicit shell as `bash -e`. */
const RUN_SHELL = ['-e', '-c'];

const roots = [];
afterAll(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A reviewed `main` with the release scripts, pushed to a bare remote. */
function repository({ access, version = '0.5.0' }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-visibility-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  for (const directory of [work, bin]) mkdirSync(directory, { recursive: true });
  for (const file of [
    'release/version.mjs',
    'release/auto-release.mjs',
    'release/change-type.mjs',
    'release/package-set.mjs',
    'release/publication-policy.mjs',
    'release/access.mjs',
    'ci/shared.mjs',
    'ci/source-files.mjs',
  ]) {
    const target = path.join(work, 'scripts', file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(new URL(`../../scripts/${file}`, import.meta.url), target);
  }
  const manifest = path.join(work, 'packages/dogsled/package.json');
  mkdirSync(path.dirname(manifest), { recursive: true });
  const writeManifest = (fields) =>
    writeFileSync(
      manifest,
      JSON.stringify({
        name: '@bobsled-inc/dogsled',
        publishConfig: { access },
        version,
        ...fields,
      })
    );
  writeManifest();
  // Only `gh api` reads the visibility; `gh auth setup-git` needs no credential for a local remote.
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1" in
  api) [ -n "$FAKE_VISIBILITY" ] || exit 1; printf '%s\\n' "$FAKE_VISIBILITY" ;;
esac
`,
    { mode: 0o755 }
  );
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.test');
  git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-qm', 'Reviewed base');
  git('push', '-q', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');

  /** The version-only release commit and tag, left only in a bundle. */
  const candidate = (tagVersion) => {
    const tag = `v${tagVersion}`;
    const temp = path.join(root, tag);
    mkdirSync(path.join(temp, 'npm-release'), { recursive: true });
    writeManifest({ version: tagVersion });
    git('commit', '-qam', `Release ${tag}`);
    git('tag', '-a', tag, '-m', tag);
    const commit = git('rev-parse', 'HEAD');
    git('bundle', 'create', path.join(temp, 'npm-release/release.bundle'), `refs/tags/${tag}`);
    git('tag', '-d', tag);
    git('reset', '-q', '--hard', base);
    return { tag, commit, temp };
  };
  const run = (script, env) =>
    spawnSync('bash', [...RUN_SHELL, script], {
      cwd: work,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'bobsled-inc/dogsled-core',
        GITHUB_SHA: base,
        ...env,
      },
    });
  return {
    base,
    git,
    run,
    candidate,
    writeManifest,
    remoteTags: () => git('ls-remote', '--tags', 'origin'),
  };
}

const shared = new Map();
/** Repositories are slow to build, so the cases that leave them unchanged share one per access. */
function sharedRepository(access) {
  if (!shared.has(access)) {
    const r = repository({ access });
    shared.set(access, {
      ...r,
      candidates: new Map(
        ['0.5.1', '0.5.1-preview.1'].map((version) => [version, r.candidate(version)])
      ),
    });
  }
  return shared.get(access);
}

const modes = [
  ['new', '0.5.1'],
  ['auto', '0.5.1'],
  ['preview', '0.5.1-preview.1'],
];
const pairings = [
  ['private', 'restricted', true],
  ['public', 'public', true],
  ['private', 'public', false],
  ['public', 'restricted', false],
  ['internal', 'restricted', false],
  ['', 'public', false],
];

describe('publication policy before the release tag', () => {
  const cases = modes.flatMap(([mode, version]) =>
    pairings.map(([visibility, access, allowed]) => ({
      mode,
      version,
      visibility,
      access,
      allowed,
    }))
  );

  it.each(cases)(
    'prepare: $mode with "$visibility" and $access',
    ({ mode, visibility, access, allowed }) => {
      const r = sharedRepository(access);
      const result = r.run(policyStep.run, {
        RELEASE_MODE: mode,
        RELEASE_POLICY_REF: r.base,
        FAKE_VISIBILITY: visibility,
      });
      expect(result.status === 0, result.stderr).toBe(allowed);
    }
  );

  it.each(cases)(
    'tag: $mode with "$visibility" and $access',
    ({ mode, version, visibility, access, allowed }) => {
      const r = sharedRepository(access);
      const { tag, commit, temp } = r.candidates.get(version);
      const result = r.run(pushStep.run, {
        RELEASE_MODE: mode,
        RELEASE_TAG: tag,
        RELEASE_COMMIT: commit,
        RELEASE_POLICY_REF: commit,
        RUNNER_TEMP: temp,
        FAKE_VISIBILITY: visibility,
      });
      const pushed = r.remoteTags();
      r.git('tag', '-d', tag);
      if (pushed) r.git('push', '-q', '--delete', 'origin', tag);
      expect(result.status === 0, result.stderr).toBe(allowed);
      if (allowed) expect(pushed).toContain(`refs/tags/${tag}`);
      else expect(pushed).toBe('');
    }
  );

  it.each(['restricted', 'public'])(
    'retry reads %s access from the tag and never from main',
    (access) => {
      const r = repository({ access });
      const { tag, commit } = r.candidate('0.5.1');
      r.git('tag', tag, commit);
      r.writeManifest({ publishConfig: { access: access === 'public' ? 'restricted' : 'public' } });
      r.git('commit', '-qam', 'Change access on main');
      for (const [visibility, expectedAccess, allowed] of pairings) {
        if (expectedAccess !== access) continue;
        const result = r.run(policyStep.run, {
          RELEASE_MODE: 'retry',
          RELEASE_POLICY_REF: `refs/tags/${tag}`,
          FAKE_VISIBILITY: visibility,
        });
        expect(result.status === 0, `${visibility} ${result.stderr}`).toBe(allowed);
      }
    }
  );

  it.each([
    ['private', 'restricted', '0.1.0', true],
    ['public', 'public', '0.1.0', false],
    ['private', 'restricted', '0.5.0', false],
  ])('bootstrap with "%s", %s and %s', (visibility, access, version, allowed) => {
    const r = repository({ access, version });
    const result = r.run(policyStep.run, {
      RELEASE_MODE: 'bootstrap',
      RELEASE_POLICY_REF: r.base,
      FAKE_VISIBILITY: visibility,
    });
    expect(result.status === 0, result.stderr).toBe(allowed);
  });

  it('rejects anything but an exact commit or release tag', () => {
    for (const ref of [undefined, '', 'HEAD', 'main', '--help', 'refs/tags/v../x', 'refs/tags/vx'])
      expect(() => verifyPublicationPolicy({ ref, visibility: 'private', mode: 'new' })).toThrow(
        /exact commit or release tag|stable X\.Y\.Z/
      );
  });

  it('rejects another package and unknown access', () => {
    const other = repository({ access: 'restricted' });
    other.writeManifest({ name: 'other' });
    other.git('commit', '-qam', 'Rename');
    const unknown = repository({ access: 'everyone' });
    for (const [r, message] of [
      [other, 'publishable package'],
      [unknown, 'uniformly public or restricted'],
    ]) {
      const result = r.run(policyStep.run, {
        RELEASE_MODE: 'new',
        RELEASE_POLICY_REF: r.git('rev-parse', 'HEAD'),
        FAKE_VISIBILITY: 'private',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
  });
});

describe('publication policy wiring', () => {
  const index = (predicate) => prepareSteps.findIndex(predicate);

  it('checks every mode in prepare with trusted code, before tag contents and planning', () => {
    const policy = prepareSteps.indexOf(policyStep);
    const validate = index((step) => step.name?.startsWith('Validate retry origin'));
    const checkout = index((step) => step.name === 'Check out the validated retry tag');
    expect(policyStep.if).toBeUndefined();
    expect(policyStep['continue-on-error']).toBeUndefined();
    expect(policyStep.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      RELEASE_MODE: '${{ inputs.mode }}',
      RELEASE_POLICY_REF:
        "${{ inputs.mode == 'retry' && format('refs/tags/v{0}', inputs.version) || github.sha }}",
    });
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(policy);
    expect(policy).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(index((step) => step.run === 'pnpm install --frozen-lockfile'));
    expect(checkout).toBeLessThan(index((step) => step.id === 'plan'));
    expect(prepareSteps[validate].if).toBe("inputs.mode == 'retry'");
    expect(prepareSteps[checkout].if).toBe("inputs.mode == 'retry'");
  });

  it('repeats the check on the verified commit right before the only tag push', () => {
    const lines = pushStep.run.trim().split('\n');
    const policy = lines.indexOf('node scripts/release/publication-policy.mjs');
    expect(policy).toBeGreaterThan(
      lines.indexOf('node scripts/release/version.mjs verify-candidate')
    );
    expect(lines.slice(policy + 1)).toEqual([
      'gh auth setup-git',
      'git -c core.hooksPath=/dev/null push origin "refs/tags/$RELEASE_TAG"',
    ]);
    expect(pushStep.env.RELEASE_POLICY_REF).toBe('${{ needs.release-checks-ok.outputs.commit }}');
    expect(pushStep['continue-on-error']).toBeUndefined();
    const pushes = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => / push origin /.test(step.run ?? ''));
    expect(pushes).toEqual([pushStep]);
  });

  it('keeps the publish-time check', () => {
    const steps = workflow.jobs.publish.steps;
    const read = steps.findIndex((step) => step.name === 'Read current repository visibility');
    const publish = steps.findIndex((step) => step.run?.includes('scripts/release/publish.mjs'));
    expect(steps[read].run).toContain('RELEASE_REPOSITORY_VISIBILITY=%s');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(publish);
  });
});
