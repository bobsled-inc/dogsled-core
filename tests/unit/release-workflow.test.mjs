import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { smokePackedData } from '../../scripts/release/packed-smoke.mjs';
import { incrementVersion } from '../../scripts/release/version.mjs';
import { releaseBumpForChangeType } from '../../scripts/release/change-type.mjs';
import { publicationPolicy } from '../../scripts/release/publication-policy.mjs';

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
);

describe('release workflow boundaries', () => {
  it('requires a manual dispatch in dogsled-core on every job', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    for (const job of Object.values(workflow.jobs))
      expect(job.if).toContain("github.repository == 'bobsled-inc/dogsled-core'");
    expect(workflow.jobs.prepare.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toContain('bootstrap');
  });

  it('isolates protected OIDC publication from repository writes', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.publish.environment).toBe('npm-release');
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.jobs.prepare.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.tag.environment).toBe('npm-release');
    expect(workflow.jobs.tag.permissions).toEqual({ contents: 'write' });
    expect(
      workflow.jobs.tag.steps.every((step) => !/\b(?:pnpm|npm)\s|\binstall\s/.test(step.run ?? ''))
    ).toBe(true);
    expect(workflow.jobs.tag.steps.at(-1).run).toContain('git -c core.hooksPath=/dev/null push');
    expect(workflow.jobs.prepare.steps[0].with.ref).toBe('${{ github.sha }}');
    expect(workflow.jobs.prepare.permissions['id-token']).toBeUndefined();
    expect(workflow.jobs.finalize.permissions['id-token']).toBeUndefined();
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        if (step.uses?.startsWith('actions/checkout@'))
          expect(step.with['persist-credentials']).toBe(false);
        if (step.uses?.startsWith('actions/setup-node@'))
          expect(step.with['package-manager-cache']).toBe(false);
      }
  });

  it('finalizes successful retries without continuing cancelled runs and verifies tags from trusted code', () => {
    expect(workflow.jobs.publish.if).toContain('!cancelled()');
    expect(workflow.jobs.publish.if).not.toContain('always()');
    expect(workflow.jobs.finalize.if).toContain('!cancelled()');
    expect(workflow.jobs.finalize.if).toContain("needs.publish.result == 'success'");
    const tag = workflow.jobs.tag;
    expect(tag.steps[0].with.ref).toBe('${{ github.sha }}');
    const push = tag.steps.at(-1);
    expect(push.run.indexOf('node scripts/release/version.mjs verify-candidate')).toBeLessThan(
      push.run.indexOf('git -c core.hooksPath=/dev/null push')
    );
    expect(push.env.RELEASE_MODE).toBe('${{ inputs.mode }}');
  });

  it('limits the short-lived bootstrap credential to the protected bootstrap step', () => {
    const credentialSteps = workflow.jobs.publish.steps.filter((step) => step.env?.NODE_AUTH_TOKEN);
    expect(credentialSteps).toHaveLength(1);
    expect(credentialSteps[0].if).toBe("inputs.mode == 'bootstrap'");
    expect(credentialSteps[0].env.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_BOOTSTRAP_TOKEN }}');
    const validate = workflow.jobs.prepare.steps.findIndex((step) =>
      step.name?.startsWith('Validate retry origin')
    );
    const install = workflow.jobs.prepare.steps.findIndex(
      (step) => step.run === 'pnpm install --frozen-lockfile'
    );
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(install);
  });

  it('uses restricted direct bootstrap, current visibility and matching prerelease metadata', () => {
    const steps = workflow.jobs.publish.steps;
    const bootstrap = steps.find((step) => step.env?.NODE_AUTH_TOKEN);
    expect(bootstrap.run).toContain('publish.mjs "$RUNNER_TEMP/npm-release" --bootstrap');
    const normal = steps.find((step) => step.if === "inputs.mode != 'bootstrap'");
    expect(normal.env.NPM_READ_TOKEN).toBe('${{ secrets.NPM_READ_TOKEN }}');
    expect(normal.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(normal.run).toBe('node scripts/release/publish.mjs "$RUNNER_TEMP/npm-release"');
    expect(workflow.jobs.finalize.if).not.toContain("inputs.mode != 'bootstrap'");
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toContain('preview');
    const visibility = steps.findIndex(
      (step) => step.name === 'Read current repository visibility'
    );
    expect(steps[visibility].run).toContain('gh api "repos/$GITHUB_REPOSITORY"');
    expect(steps[visibility].run).toContain('private|public');
    expect(visibility).toBeLessThan(steps.indexOf(bootstrap));
    expect(visibility).toBeLessThan(steps.indexOf(normal));
    expect(workflow.jobs.finalize.steps.at(-1).env.RELEASE_PRERELEASE).toBe(
      '${{ needs.prepare.outputs.prerelease }}'
    );
    expect(steps.some((step) => step.run?.includes('npm@11.18.0'))).toBe(true);
    expect(readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim()).toBe('24');
    expect(steps.every((step) => !/npm stage/.test(step.run ?? ''))).toBe(true);
  });

  it('derives provenance from current repository visibility so it turns on at the public flip', () => {
    const source = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/provenance/i);
    const publishSteps = workflow.jobs.publish.steps.filter((step) =>
      step.run?.includes('node scripts/release/publish.mjs')
    );
    expect(publishSteps).toHaveLength(2);
    expect(
      publicationPolicy({ access: 'restricted', visibility: 'private', version: '0.1.1' })
    ).toEqual({ provenance: false, distTag: 'latest' });
    expect(publicationPolicy({ access: 'public', visibility: 'public', version: '0.1.1' })).toEqual(
      { provenance: true, distTag: 'latest' }
    );
  });

  it('finalizes the GitHub release through the re-runnable script from trusted code', () => {
    const finalize = workflow.jobs.finalize;
    expect(finalize.permissions).toEqual({ contents: 'write' });
    expect(finalize.environment).toBeUndefined();
    expect(finalize.steps[0].with.ref).toBe('${{ github.sha }}');
    const step = finalize.steps.at(-1);
    expect(step.run).toContain('node scripts/release/finalize-github-release.mjs');
    expect(step.run).not.toMatch(/gh release (?:create|upload|delete)|--clobber/);
    expect(step.run).toContain('release-report.json#npm release artifact report');
    expect(step.run).toContain('sbom.json#CycloneDX SBOM');
    expect(step.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      RELEASE_TAG: '${{ needs.prepare.outputs.tag }}',
      RELEASE_COMMIT: '${{ needs.prepare.outputs.commit }}',
      RELEASE_PRERELEASE: '${{ needs.prepare.outputs.prerelease }}',
    });
    expect(finalize.steps.every((step) => !step.env?.NPM_READ_TOKEN)).toBe(true);
  });

  it('keeps major change types below 1.0 while the package is 0.x', () => {
    expect(incrementVersion('0.1.4', releaseBumpForChangeType('major'))).toBe('0.2.0');
  });

  it('fails the packed-data gate when the query returns incorrect loaded data', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'packed-data-fixture-'));
    try {
      const run = () => ({ status: 0, stdout: JSON.stringify({ rows: [{ n: 0, total: 0 }] }) });
      expect(() => smokePackedData(root, '@example/toolkit', run)).toThrow('incorrect data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
