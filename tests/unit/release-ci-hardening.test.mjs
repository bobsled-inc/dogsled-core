import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { withRegistryReadAuth } from '../../scripts/release/registry-read-auth.mjs';
import { parsePrivacyExceptions, scanPrivacyFile } from '../../scripts/guards/privacy.mjs';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const release = parse(read('.github/workflows/release.yml'));
const metadata = parse(read('.github/workflows/pr-metadata.yml'));
const dcoRun = metadata.jobs['pr-metadata'].steps.find((step) =>
  step.name?.startsWith('Check DCO')
).run;
const dcoCode = dcoRun.match(/<<'JS'\n([\s\S]*)\nJS\s*$/)[1];
const { validateSignoffs, checkDco } = new Function(
  `${dcoCode.split('const event =')[0]}\nreturn { validateSignoffs, checkDco };`
)();
const commit = (message = 'Fix\n\nSigned-off-by: Example Contributor <author@example.com>') => ({
  sha: 'abc',
  commit: { author: { name: 'Example Contributor', email: 'author@example.com' }, message },
});

describe('release approval and metadata checks', () => {
  it('gates every release on parallel checks and approval before pushing the tag', () => {
    expect(release.jobs.approve.environment).toBe('release-approval');
    expect(release.jobs.tag.environment).toBe('release-tag');
    expect(release.jobs.publish.environment).toBe('npm-release');
    expect(release.jobs['release-checks-ok'].needs).toEqual(
      expect.arrayContaining([
        'release-checks',
        'release-unit',
        'release-packed-catalog',
        'release-audit',
      ])
    );
    expect(release.jobs.approve.needs).toContain('release-checks-ok');
    expect(release.jobs.tag.needs).toContain('approve');
    expect(release.jobs.publish.needs).toContain('tag');
  });

  it('reruns lightweight validation on body and label edits and checks out only trusted base validation code', () => {
    expect(metadata.on.pull_request.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'edited',
      'labeled',
      'unlabeled',
    ]);
    expect(metadata.permissions).toEqual({ contents: 'read' });
    const steps = metadata.jobs['pr-metadata'].steps;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe('${{ github.event.pull_request.base.sha }}');
    expect(checkout.with['sparse-checkout']).not.toContain('tests');
    expect(checkout.with['persist-credentials']).toBe(false);
    expect(metadata.jobs['pr-metadata'].permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(dcoRun).not.toMatch(/checkout|head\.ref|child_process|eval\(|\$\{\{/);
    expect(JSON.stringify(metadata)).not.toContain('secrets.');
  });

  it('requires an author sign-off on each commit and rejects a different identity', () => {
    expect(() => validateSignoffs([commit()], 1)).not.toThrow();
    for (const message of [
      'Unsigned',
      'Signed-off-by: Other <other@example.com>',
      'Signed-off-by: Example Contributor <other@example.com>',
    ])
      expect(() => validateSignoffs([commit(message)], 1)).toThrow('sign-off');
    expect(() => validateSignoffs([commit(), commit('Unsigned')], 2)).toThrow('sign-off');
    expect(() => validateSignoffs([commit()], 2)).toThrow('complete');
    expect(() => validateSignoffs([], 251)).toThrow('complete');
  });

  it('accepts the canonical Dependabot support-address sign-off', () => {
    const entry = {
      author: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' },
      commit: {
        author: {
          name: 'dependabot[bot]',
          email: '49699333+dependabot[bot]@users.noreply.github.com',
        },
        message: 'Bump dependency\n\nSigned-off-by: dependabot[bot] <support@github.com>',
      },
    };
    expect(() => validateSignoffs([entry], 1)).not.toThrow();
    expect(() =>
      validateSignoffs([{ ...entry, commit: { ...entry.commit, message: 'Unsigned' } }], 1)
    ).toThrow('sign-off');
    for (const author of [
      undefined,
      { ...entry.author, login: 'other[bot]' },
      { ...entry.author, id: 1 },
      { ...entry.author, type: 'User' },
    ])
      expect(() => validateSignoffs([{ ...entry, author }], 1)).toThrow('sign-off');
    for (const author of [
      { ...entry.commit.author, name: 'other[bot]' },
      { ...entry.commit.author, email: 'other@example.com' },
    ])
      expect(() =>
        validateSignoffs([{ ...entry, commit: { ...entry.commit, author } }], 1)
      ).toThrow('sign-off');
    for (const message of [
      'Signed-off-by: other[bot] <support@github.com>',
      'Signed-off-by: dependabot[bot] <other@example.com>',
    ])
      expect(() =>
        validateSignoffs([{ ...entry, commit: { ...entry.commit, message } }], 1)
      ).toThrow('sign-off');
    const human = commit('Signed-off-by: Example Contributor <support@github.com>');
    expect(() => validateSignoffs([human], 1)).toThrow('sign-off');
    const ordinaryBot = {
      author: { login: 'other[bot]', id: 1, type: 'Bot' },
      commit: {
        author: { name: 'other[bot]', email: '1+other[bot]@users.noreply.github.com' },
        message: 'Signed-off-by: other[bot] <support@github.com>',
      },
    };
    expect(() => validateSignoffs([ordinaryBot], 1)).toThrow('sign-off');
  });

  it('limits the canonical bot service-address privacy exception to the two reviewed files', () => {
    const exceptions = parsePrivacyExceptions(read('scripts/guards/privacy-exceptions.json'));
    const serviceAddress = 'support@github.com';
    for (const file of [
      '.github/workflows/pr-metadata.yml',
      'tests/unit/release-ci-hardening.test.mjs',
    ]) {
      expect(scanPrivacyFile(file, [serviceAddress], exceptions).get('email-address')).toEqual([]);
      expect(
        scanPrivacyFile(file, [serviceAddress.replace('support', 'other')], exceptions).get(
          'email-address'
        )
      ).toHaveLength(1);
    }
    expect(
      scanPrivacyFile('scripts/ci/unrelated.mjs', [serviceAddress], exceptions).get('email-address')
    ).toHaveLength(1);
  });

  it('reads bounded commit metadata, fails on a changed head, and propagates API errors', async () => {
    const event = {
      repository: { private: false },
      pull_request: { number: 7, commits: 1, head: { sha: 'abc' } },
    };
    const request = vi.fn(async () => [commit()]);
    const args = { event, repository: 'bobsled-inc/dogsled-core', request };
    await checkDco(args);
    expect(request).toHaveBeenCalledWith(
      '/repos/bobsled-inc/dogsled-core/pulls/7/commits?per_page=100&page=1'
    );
    await expect(
      checkDco({ ...args, request: async () => [{ ...commit(), sha: 'changed' }] })
    ).rejects.toThrow('head changed');
    await expect(
      checkDco({
        ...args,
        request: async () => {
          throw new Error('API failed');
        },
      })
    ).rejects.toThrow('API failed');
    request.mockClear();
    await checkDco({ ...args, repository: 'example/staging' });
    await checkDco({ ...args, event: { ...event, repository: { private: true } } });
    expect(request).not.toHaveBeenCalled();
  });

  it('paginates the complete DCO list without exempting maintainer or bot authors', async () => {
    const event = {
      repository: { private: false },
      pull_request: {
        number: 7,
        commits: 101,
        head: { sha: 'abc' },
        author_association: 'OWNER',
        user: { type: 'Bot' },
      },
    };
    const request = vi.fn(async (route) =>
      route.endsWith('page=1') ? Array.from({ length: 100 }, () => commit()) : [commit()]
    );
    await checkDco({ event, repository: 'bobsled-inc/dogsled-core', request });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('accepts Dependabot change types while keeping human PR validation', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'change-type-'));
    try {
      const event = path.join(directory, 'event.json');
      const run = (login, labels = []) => {
        writeFileSync(
          event,
          JSON.stringify({
            pull_request: { user: { login }, body: '', labels: labels.map((name) => ({ name })) },
          })
        );
        return spawnSync(process.execPath, ['scripts/ci/validate-pr-change-type.mjs'], {
          env: { ...process.env, GITHUB_EVENT_PATH: event },
          encoding: 'utf8',
        });
      };
      expect(run('dependabot[bot]').status).toBe(0);
      expect(run('dependabot[bot]', ['dependencies', 'change-type: minor']).status).toBe(0);
      const conflicting = run('dependabot[bot]', ['change-type: patch', 'change-type: major']);
      expect(conflicting.status).toBe(1);
      expect(conflicting.stderr).toContain('At most one change-type label');
      expect(run('contributor').status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('restricted registry read authentication', () => {
  it('uses a private temporary npmrc only for reads and removes it after success or failure', async () => {
    for (const fail of [false, true]) {
      let config;
      const operation = withRegistryReadAuth(
        { visibility: 'private' },
        async (env) => {
          config = env.NPM_CONFIG_USERCONFIG;
          expect(readFileSync(config, 'utf8')).toBe(
            '//registry.npmjs.org/:_authToken=${NPM_READ_TOKEN}\n'
          );
          expect(statSync(config).mode & 0o777).toBe(0o600);
          expect(env.NPM_READ_TOKEN).toBe('test-read-token');
          if (fail) throw new Error('read failure');
          return 'verified';
        },
        { NPM_READ_TOKEN: 'test-read-token' }
      );
      if (fail) await expect(operation).rejects.toThrow('read failure');
      else expect(await operation).toBe('verified');
      expect(existsSync(config)).toBe(false);
    }
  });

  it('fails before publication when a restricted OIDC read credential is missing', async () => {
    const read = vi.fn();
    await expect(withRegistryReadAuth({ visibility: 'private' }, read, {})).rejects.toThrow(
      'NPM_READ_TOKEN'
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('reuses bootstrap auth and permits public reads without a read token', async () => {
    const env = {
      NPM_CONFIG_USERCONFIG: '/tmp/bootstrap.npmrc',
      NODE_AUTH_TOKEN: 'test-bootstrap-token',
    };
    expect(
      await withRegistryReadAuth(
        { visibility: 'private', bootstrap: true },
        async (value) => value,
        env
      )
    ).toBe(env);
    expect(
      await withRegistryReadAuth({ visibility: 'public' }, async (value) => value, {})
    ).toEqual({});
  });
});

describe('reviewed release configuration', () => {
  it('requires owners for manifests, policy, scanners and legal files', () => {
    const owners = read('.github/CODEOWNERS');
    for (const pattern of [
      '/package.json',
      '/packages/*/package.json',
      '/pnpm-lock.yaml',
      '/.npmrc',
      '/scripts/ci/',
      '/tests/structural/',
      '/.gitleaks.toml',
      '/.semgrep.yml',
      '/.secretlint*',
      '/SECURITY.md',
      '/LICENSE',
      '/NOTICE',
    ])
      expect(owners.split('\n')).toContain(`${pattern} @bobsled-inc/dogsled-maintainers`);
    expect([...new Set(owners.match(/@[\w-]+\/[\w-]+/g))]).toEqual([
      '@bobsled-inc/dogsled-maintainers',
    ]);
  });
});
