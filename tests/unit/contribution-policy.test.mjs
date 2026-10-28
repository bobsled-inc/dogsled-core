import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/contribution-policy.yml', import.meta.url), 'utf8')
);
const run = workflow.jobs.policy.steps.find((step) => step.run).run;
const code = run.match(/<<'JS'\n([\s\S]*)\nJS\s*$/)[1];
const { changedLineCount, applyContributionPolicy } = new Function(
  `${code.split('const event =')[0]}\nreturn { changedLineCount, applyContributionPolicy };`
)();
const file = (filename, additions, deletions = 0, previous_filename) => ({
  filename,
  additions,
  deletions,
  previous_filename,
});
const event = (author_association = 'NONE') => ({
  repository: { private: false },
  pull_request: { number: 42, author_association },
});
const botComment = {
  user: { login: 'github-actions[bot]', type: 'Bot' },
  body: '<!-- dogsled-contribution-policy -->',
};

function api(files, comments = []) {
  return vi.fn(async (method, route) => {
    if (method === 'POST') return {};
    return route.includes('/files?') ? files : comments;
  });
}
const apply = (request, options = {}) =>
  applyContributionPolicy({
    request,
    event: event(),
    repository: 'bobsled-inc/dogsled-core',
    ...options,
  });

describe('public metadata-only contribution policy', () => {
  it('counts additions and deletions, excluding lockfiles in any directory', () => {
    expect(
      changedLineCount([
        file('src/a.ts', 7, 6),
        file('pnpm-lock.yaml', 500),
        file('nested/package-lock.json', 100),
        file('yarn.lock', 100),
        file('bun.lockb', 100),
      ])
    ).toBe(13);
    expect(changedLineCount([file('src/pnpm-lock.yaml.ts', 4)])).toBe(4);
  });

  it('does not hide a code file renamed into a lockfile', () => {
    expect(changedLineCount([file('pnpm-lock.yaml', 1, 15, 'src/a.ts')])).toBe(16);
    expect(changedLineCount([file('nested/pnpm-lock.yaml', 100, 0, 'pnpm-lock.yaml')])).toBe(0);
  });

  it.each([-1, NaN, 1.5, '13'])('rejects malformed API counts: %j', (n) => {
    expect(() => changedLineCount([file('src/a.ts', n)])).toThrow('count');
  });

  it.each([0, 12])('does not write at or below twelve lines: %i', async (n) => {
    const request = api([file('src/a.ts', n), file('pnpm-lock.yaml', 1000)]);
    await apply(request);
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('labels and comments once above twelve lines without closing the PR', async () => {
    const request = api([file('src/a.ts', 7, 6)]);
    await apply(request);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toEqual([
      [
        'POST',
        '/repos/bobsled-inc/dogsled-core/issues/42/labels',
        { labels: ['contribution-policy'] },
      ],
      [
        'POST',
        '/repos/bobsled-inc/dogsled-core/issues/42/comments',
        expect.objectContaining({ body: expect.stringContaining('/CONTRIBUTING.md') }),
      ],
    ]);
    expect(request.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  });

  it('does not repeat its bot notice, but a copied user marker cannot suppress it', async () => {
    const request = api([file('a.ts', 13)], [botComment]);
    await apply(request);
    expect(
      request.mock.calls.filter(
        ([method, route]) => method === 'POST' && route.endsWith('/comments')
      )
    ).toHaveLength(0);
    const user = api(
      [file('a.ts', 13)],
      [{ ...botComment, user: { login: 'outside-user', type: 'User' } }]
    );
    await apply(user);
    expect(
      user.mock.calls.filter(([method, route]) => method === 'POST' && route.endsWith('/comments'))
    ).toHaveLength(1);
  });

  it('counts across changed-file pages and checks older bot comments', async () => {
    const request = vi.fn(async (method, route) => {
      if (method === 'POST') return {};
      if (route.includes('/files?'))
        return route.endsWith('page=1')
          ? Array.from({ length: 100 }, () => file('pnpm-lock.yaml', 100))
          : [file('a.ts', 13)];
      return route.endsWith('page=1')
        ? Array.from({ length: 100 }, () => ({ body: 'older comment' }))
        : [botComment];
    });
    await apply(request);
    expect(request.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(4);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'skips trusted association %s',
    async (association) => {
      const request = vi.fn();
      await apply(request, { event: event(association) });
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('skips Dependabot without attempting labels or comments', async () => {
    const request = vi.fn();
    await apply(request, {
      event: {
        ...event(),
        pull_request: { ...event().pull_request, user: { login: 'dependabot[bot]' } },
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(workflow.jobs.policy.if).toContain(
      "github.event.pull_request.user.login != 'dependabot[bot]'"
    );
  });

  it('never calls the API outside the public repository', async () => {
    const request = vi.fn();
    await apply(request, { repository: 'example/staging' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([true, undefined, 'false'])(
    'does not run for private or unknown visibility %j',
    async (privateValue) => {
      const request = vi.fn();
      await apply(request, { event: { ...event(), repository: { private: privateValue } } });
      expect(request).not.toHaveBeenCalled();
      expect(workflow.jobs.policy.if).toContain('github.event.repository.private == false');
    }
  );

  it('runs only trusted inline metadata code with narrowly scoped permissions', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request_target']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.policy.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });
    expect(workflow.jobs.policy.if).toContain("github.repository == 'bobsled-inc/dogsled-core'");
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const actions = workflow.jobs.policy.steps.filter((step) => step.uses);
    expect(actions).toHaveLength(1);
    expect(actions[0].uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(actions[0].with).toEqual({ 'node-version': '24', 'package-manager-cache': false });
    expect(run).not.toMatch(/checkout|head\.sha|head\.ref|child_process|eval\(|\$\{\{/);
    expect(code).not.toMatch(/\.patch|\.diff|\.title|\.head/);
  });
});
