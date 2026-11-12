import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The long-lived rename branch gets normal CI, but never main's release,
// release health or Husky jobs.
const RENAME_BRANCH = 'rename/bobsled-core';
const MAIN_ONLY = "github.ref == 'refs/heads/main'";

const workflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));

describe('rename branch isolation', () => {
  it('runs CI on pushes to and pull requests into the rename branch', () => {
    const ci = workflow('ci.yml');
    expect(ci.on.push.branches).toEqual(['main', RENAME_BRANCH]);
    expect(ci.on.pull_request.branches).toEqual(['main', RENAME_BRANCH]);
  });

  it('releases on merge to main only', () => {
    expect(workflow('release-on-merge.yml').on).toEqual({ push: { branches: ['main'] } });
  });

  it('keeps release, tagging and Husky notifications on main', () => {
    const release = workflow('release.yml');
    for (const job of ['prepare', 'tag', 'notify', 'release-status'])
      expect(release.jobs[job].if).toContain(MAIN_ONLY);
    // Every other release job waits on prepare, which never runs off main.
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === 'prepare') continue;
      expect([job.needs].flat()).toContain('prepare');
    }
    // Jobs that run after failures (!cancelled()) must still require a successful prepare.
    for (const job of ['publish', 'finalize'])
      expect(release.jobs[job].if).toContain("needs.prepare.result == 'success'");
  });

  it('runs the release health audit and its Husky report on main only', () => {
    const health = workflow('release-health.yml');
    expect(health.jobs.audit.if).toContain(MAIN_ONLY);
    expect(health.jobs.report.needs).toBe('audit');
    // A skipped audit has empty outputs, so the report (and Husky) is skipped too.
    expect(health.jobs.report.if).toContain("needs.audit.outputs.mode == 'on'");
  });
});
