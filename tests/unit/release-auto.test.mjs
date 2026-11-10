import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';

import {
  autoReleaseRange,
  autoReleaseSummary,
  createGitHubReader,
  decideMergedPullRequest,
  mergeDecisionSummary,
  mergedPullRequestForCommit,
  notifySummary,
  resolveAutoRelease,
} from '../../scripts/release/auto-release.mjs';
import {
  releaseBaseVersion,
  verifyReleaseCandidate,
  writeGithubOutput,
} from '../../scripts/release/version.mjs';

const body = (changeType) => `## Summary\n\nTest\n\n## Change Type\n\n- [x] \`${changeType}\`\n`;
const merged = (number, changeType, extra = {}) => ({
  number,
  title: `Change ${number}`,
  body: body(changeType),
  user: { login: 'maintainer' },
  merged_at: '2026-11-04T00:00:00Z',
  base: { ref: 'main' },
  ...extra,
});

describe('automatic release range', () => {
  let root;
  let git;
  const sha = {};
  let pullsBySha;

  const commit = (name, message, file = name) => {
    writeFileSync(path.join(root, file), `${name}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
    sha[name] = git(['rev-parse', 'HEAD']);
  };
  const releaseCommit = (name, version, tag) => {
    git(['checkout', '-q', '--detach']);
    writeFileSync(
      path.join(root, 'packages/dogsled/package.json'),
      `${JSON.stringify({ name: '@bobsled-inc/dogsled', version }, null, 2)}\n`
    );
    git(['commit', '-q', '-am', `Release ${tag}`]);
    sha[name] = git(['rev-parse', 'HEAD']);
    git(['tag', '-a', tag, '-m', tag]);
    git(['checkout', '-q', 'main']);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'auto-release-range-'));
    const run = (args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Example Maintainer',
          '-c',
          'user.email=maintainer@example.com',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'tag.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    git = run;
    git(['init', '-q', '-b', 'main']);
    mkdirSync(path.join(root, 'packages/dogsled'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/dogsled/package.json'),
      `${JSON.stringify({ name: '@bobsled-inc/dogsled', version: '0.1.0' }, null, 2)}\n`
    );
    commit('initial', 'Initial');
    git(['tag', '-a', 'v0.1.0', '-m', 'v0.1.0']);
    commit('fix', 'Fix a bug (#1)');
    releaseCommit('release1', '0.1.1', 'v0.1.1');
    commit('internal', 'Tidy CI (#2)');
    releaseCommit('preview', '0.1.2-preview.1', 'v0.1.2-preview.1');
    git(['checkout', '-q', '-b', 'feature']);
    commit('feature1', 'Add part one', 'feature-one');
    commit('feature2', 'Add part two', 'feature-two');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #3']);
    sha.merge = git(['rev-parse', 'HEAD']);
    commit('docs1', 'Document one', 'docs-one');
    commit('docs2', 'Document two', 'docs-two');
    git(['revert', '--no-edit', sha.fix]);
    sha.revert = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'unrelated', sha.initial]);
    commit('side1', 'Side one', 'side-one');
    commit('side2', 'Side two', 'side-two');
    git(['tag', '-a', 'v0.1.9', '-m', 'v0.1.9']);
    git(['checkout', '-q', 'main']);

    pullsBySha = {
      [sha.internal]: [
        merged(2, 'internal'),
        { ...merged(9, 'major'), merged_at: null },
        merged(10, 'major', { base: { ref: 'other' } }),
      ],
      [sha.merge]: [merged(3, 'minor')],
      [sha.feature1]: [merged(3, 'minor')],
      [sha.feature2]: [merged(3, 'minor')],
      [sha.docs1]: [merged(4, 'documentation')],
      [sha.docs2]: [merged(4, 'documentation')],
      [sha.revert]: [merged(5, 'patch', { title: 'Revert "Fix a bug"' })],
    };
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const lookup = (overrides = {}) =>
    vi.fn(async (commitSha) => overrides[commitSha] ?? pullsBySha[commitSha] ?? []);

  it('walks first-parent main from the last stable tag parent, ignoring preview tags', async () => {
    const tags = git(['tag', '--list', 'v*']).split('\n');
    expect(
      releaseBaseVersion(
        '0.1.0',
        tags.filter((tag) => tag !== 'v0.1.9')
      )
    ).toBe('0.1.1');
    const listPullRequests = lookup();
    const plan = await resolveAutoRelease({ previousVersion: '0.1.1', git, listPullRequests });
    expect(plan.tag).toBe('v0.1.1');
    expect(plan.base).toBe(sha.fix);
    expect(plan.head).toBe(sha.revert);
    expect(plan.commits).toEqual([sha.internal, sha.merge, sha.docs1, sha.docs2, sha.revert]);
    expect(listPullRequests).not.toHaveBeenCalledWith(sha.feature1);
    expect(plan.pullRequests).toEqual([
      {
        number: 2,
        title: 'Change 2',
        changeType: 'internal',
        bump: 'patch',
        commits: [sha.internal],
      },
      { number: 3, title: 'Change 3', changeType: 'minor', bump: 'minor', commits: [sha.merge] },
      {
        number: 4,
        title: 'Change 4',
        changeType: 'documentation',
        bump: 'patch',
        commits: [sha.docs1, sha.docs2],
      },
      {
        number: 5,
        title: 'Revert "Fix a bug"',
        changeType: 'patch',
        bump: 'patch',
        commits: [sha.revert],
      },
    ]);
    expect(plan.bump).toBe('minor');
    expect(plan.breaking).toEqual([]);
  });

  it('starts from a bootstrap tag that sits directly on main', () => {
    const range = autoReleaseRange({ previousVersion: '0.1.0', git });
    expect(range.base).toBe(sha.initial);
    expect(range.commits[0]).toBe(sha.fix);
    expect(range.commits).not.toContain(sha.release1);
  });

  it('reports breaking pull requests and the major bump', async () => {
    const plan = await resolveAutoRelease({
      previousVersion: '0.1.1',
      git,
      listPullRequests: lookup({ [sha.merge]: [merged(3, 'major')] }),
    });
    expect(plan.bump).toBe('major');
    expect(plan.breaking).toEqual([3]);
    expect(autoReleaseSummary(plan, '0.2.0')).toContain('**Breaking:**');
  });

  it('produces no release when every merged pull request is skip-release', async () => {
    const plan = await resolveAutoRelease({
      previousVersion: '0.1.1',
      git,
      listPullRequests: lookup({
        [sha.internal]: [merged(2, 'skip-release')],
        [sha.merge]: [merged(3, 'skip-release')],
        [sha.docs1]: [merged(4, 'skip-release')],
        [sha.docs2]: [merged(4, 'skip-release')],
        [sha.revert]: [merged(5, 'skip-release')],
      }),
    });
    expect(plan.bump).toBeNull();
    expect(autoReleaseSummary(plan, '0.1.1')).toContain('Result: no release.');
  });

  it('fails without guessing when a commit has no merged pull request or an invalid type', async () => {
    await expect(
      resolveAutoRelease({
        previousVersion: '0.1.1',
        git,
        listPullRequests: lookup({ [sha.docs1]: [] }),
      })
    ).rejects.toThrow(`Commit ${sha.docs1} must belong to exactly one pull request`);
    await expect(
      resolveAutoRelease({
        previousVersion: '0.1.1',
        git,
        listPullRequests: lookup({
          [sha.merge]: [{ ...merged(3, 'minor'), body: '## Change Type\n\n' }],
        }),
      })
    ).rejects.toThrow('PR #3: Exactly one change-type checkbox');
  });

  it('verifies an auto release candidate like a new release', () => {
    expect(() =>
      verifyReleaseCandidate({ commit: sha.release1, base: sha.fix, mode: 'auto' }, root)
    ).not.toThrow();
    expect(() =>
      verifyReleaseCandidate({ commit: sha.release1, base: sha.initial, mode: 'auto' }, root)
    ).toThrow('parent must equal');
  });

  it('rejects missing tags and tags outside main history', () => {
    expect(() => autoReleaseRange({ previousVersion: '0.4.0', git })).toThrow(
      'needs the stable tag v0.4.0'
    );
    expect(() => autoReleaseRange({ previousVersion: '0.1.9', git })).toThrow(
      'not based on the checked-out main history'
    );
  });
});

describe('automatic release decisions', () => {
  const mergeSha = 'a'.repeat(40);

  it('decides the merged pull request of the triggering merge commit', () => {
    expect(decideMergedPullRequest(mergeSha, [merged(7, 'performance')])).toEqual({
      number: 7,
      title: 'Change 7',
      changeType: 'performance',
      bump: 'patch',
    });
    expect(
      decideMergedPullRequest(mergeSha, [
        merged(8, 'patch', { user: { login: 'dependabot[bot]' }, body: '' }),
      ]).changeType
    ).toBe('dependencies');
    expect(() =>
      decideMergedPullRequest(mergeSha, [{ ...merged(7, 'patch'), merged_at: null }])
    ).toThrow('found 0');
  });

  it('refuses to choose between several merged pull requests for one commit', () => {
    const only = merged(2, 'patch');
    expect(
      mergedPullRequestForCommit(mergeSha, [only, { ...merged(1, 'minor'), merged_at: null }])
    ).toBe(only);
    expect(() => mergedPullRequestForCommit(mergeSha, [merged(1, 'minor'), only])).toThrow(
      'found 2'
    );
  });

  it('escapes author-controlled titles in summaries', () => {
    const summary = mergeDecisionSummary(
      { number: 7, title: 'Pipe | <img src=x>\n# Heading', changeType: 'minor', bump: 'minor' },
      'dry-run'
    );
    expect(summary).toContain('Pipe \\| \\<img src=x\\> \\# Heading');
    expect(summary).toContain('Dry run: Release would be dispatched');
    expect(
      mergeDecisionSummary({ number: 7, title: 'x', changeType: 'tests', bump: null }, 'on')
    ).toContain('No release.');
  });

  it('reads the GitHub API with a bounded authenticated request and surfaces failures', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ number: 1 }) }));
    const read = createGitHubReader({ repository: 'example/repo', token: 'test-token', fetchImpl });
    await expect(read('/pulls/1')).resolves.toEqual({ number: 1 });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/example/repo/pulls/1');
    expect(options.headers.authorization).toBe('Bearer test-token');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const failing = createGitHubReader({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    await expect(failing('/pulls/2')).rejects.toThrow('failed (404)');
    expect(() => createGitHubReader({ repository: 'bad', token: 'x' })).toThrow('owner/repository');
    expect(() => createGitHubReader({ repository: 'example/repo' })).toThrow('GH_TOKEN');
  });

  it('accepts auto mode when verifying a release candidate', () => {
    expect(() => verifyReleaseCandidate({ commit: 'x', base: 'y', mode: 'auto' })).toThrow(
      'exact commit identities'
    );
    expect(() =>
      verifyReleaseCandidate({ commit: 'a'.repeat(40), base: 'a'.repeat(40), mode: 'other' })
    ).toThrow('new, auto, preview or bootstrap');
  });

  it('escapes Slack special characters in notification summaries so titles cannot inject pings or links', () => {
    const plan = {
      pullRequests: [
        {
          number: 1,
          title: 'Fix <script> & <!channel> injection',
          changeType: 'patch',
          bump: 'patch',
        },
        { number: 2, title: 'Normal change', changeType: 'patch', bump: 'patch' },
      ],
      bump: 'patch',
      breaking: [],
    };
    const text = notifySummary(plan, '0.1.8', 'https://github.com/example/repo');
    expect(text).toContain('Release v0.1.8?');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&amp;');
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('<https://github.com/example/repo/pull/1|#1>');
    expect(text).toContain('<https://github.com/example/repo/pull/2|#2>');
    expect(text).toContain('2 changes, including');
  });

  it('uses a random delimiter for multiline GitHub outputs so author-controlled values cannot escape', () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'ghoutput-'));
    const outputFile = path.join(outputDir, 'GITHUB_OUTPUT');
    writeFileSync(outputFile, '');
    const origEnv = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputFile;
    try {
      // A malicious title that tries to close a fixed delimiter and inject output
      const malicious =
        'ghadelimiter_notify_summary\nrelease=true\nversion=9.9.9\nghadelimiter_notify_summary';
      writeGithubOutput({ notify_summary: `line one\n${malicious}\nline two` });
      const written = readFileSync(outputFile, 'utf8');
      // The delimiter must be random (UUID-based), not the attacker's fixed pattern
      const delimiterMatch = written.match(/^notify_summary<<(ghadelimiter_[0-9a-f-]{36})$/m);
      expect(delimiterMatch).not.toBeNull();
      const delimiter = delimiterMatch[1];
      // The attacker's fake delimiter does not match the real one
      expect(delimiter).not.toBe('ghadelimiter_notify_summary');
      // The real delimiter appears exactly twice: opening and closing
      const delimiterOccurrences = written.split(delimiter).length - 1;
      expect(delimiterOccurrences).toBe(2);
      // The injected key=value lines are safely inside the block, not outside it
      const afterClose = written.split(delimiter).at(-1);
      expect(afterClose.trim()).toBe('');
    } finally {
      process.env.GITHUB_OUTPUT = origEnv;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
