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
const onMergeSource = readFileSync(
  new URL('../../.github/workflows/release-on-merge.yml', import.meta.url),
  'utf8'
);
const onMerge = parse(onMergeSource);

const ci = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

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
    expect(workflow.jobs.prepare.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(workflow.jobs.tag.environment).toBe('release-tag');
    expect(workflow.jobs.tag.permissions).toEqual({ contents: 'write' });
    expect(
      workflow.jobs.tag.steps.every((step) => !/\b(?:pnpm|npm)\s|\binstall\s/.test(step.run ?? ''))
    ).toBe(true);
    expect(workflow.jobs.tag.steps.at(-1).run).toContain('git -c core.hooksPath=/dev/null push');
    expect(workflow.jobs.prepare.steps[0].with.ref).toBe('${{ github.sha }}');
    expect(workflow.jobs.prepare.permissions['id-token']).toBeUndefined();
    expect(workflow.jobs.finalize.permissions['id-token']).toBeUndefined();
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        if (step.uses?.startsWith('actions/checkout@'))
          expect(step.with['persist-credentials']).toBe(false);
        if (step.uses?.startsWith('actions/setup-node@'))
          expect(step.with['package-manager-cache']).toBe(false);
      }
  });

  it('disables package-manager caching in every release job', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/setup-node@')) {
          expect(step.with?.cache ?? step.with?.['package-manager-cache']).toSatisfy(
            (value) => value === false || value === 'false' || value === undefined,
            `${name} must not cache packages`
          );
        }
      }
    }
  });

  it('finalizes successful retries without continuing cancelled runs and verifies tags from trusted code', () => {
    expect(workflow.jobs.publish.if).toContain('!cancelled()');
    expect(workflow.jobs.publish.if).not.toContain('always()');
    expect(workflow.jobs.publish.if).toContain("needs.approve.result == 'success'");
    expect(workflow.jobs.publish.if).toContain("needs.release-checks-ok.result == 'success'");
    expect(workflow.jobs.finalize.if).toContain('!cancelled()');
    expect(workflow.jobs.finalize.if).toContain("needs.publish.result == 'success'");
    const tag = workflow.jobs.tag;
    expect(tag.steps[0].with.ref).toBe('${{ github.sha }}');
    const push = tag.steps.at(-1);
    expect(push.run.indexOf('node scripts/release/version.mjs verify-candidate')).toBeLessThan(
      push.run.indexOf('git -c core.hooksPath=/dev/null push')
    );
    expect(push.env.RELEASE_MODE).toBe('${{ inputs.mode }}');
    expect(push.env.RELEASE_COMMIT).toBe('${{ needs.release-checks-ok.outputs.commit }}');
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
      RELEASE_COMMIT: '${{ needs.release-checks-ok.outputs.commit }}',
      RELEASE_PRERELEASE: '${{ needs.prepare.outputs.prerelease }}',
      RELEASE_BREAKING: '${{ needs.prepare.outputs.breaking }}',
      RELEASE_BREAKING_PRS: '${{ needs.prepare.outputs.breaking_prs }}',
    });
    expect(finalize.steps.every((step) => !step.env?.NPM_READ_TOKEN)).toBe(true);
  });

  it('plans auto releases from merged pull requests and gates parallel jobs on the release output', () => {
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual([
      'new',
      'auto',
      'preview',
      'retry',
      'bootstrap',
    ]);
    const steps = workflow.jobs.prepare.steps;
    const plan = steps.findIndex((step) => step.id === 'plan');
    expect(steps[plan].run).toContain('auto) node scripts/release/version.mjs prepare-auto ;;');
    expect(steps[plan].env.GH_TOKEN).toBe('${{ github.token }}');
    expect(workflow.jobs.prepare.outputs.release).toBe('${{ steps.plan.outputs.release }}');
    for (const name of [
      'release-checks',
      'release-unit',
      'release-packed-catalog',
      'release-audit',
    ]) {
      expect(workflow.jobs[name].if).toContain("needs.prepare.outputs.release == 'true'");
      expect(workflow.jobs[name].needs).toContain('prepare');
    }
    expect(workflow.jobs.approve.if).toContain("needs.prepare.outputs.release == 'true'");
    expect(workflow.jobs.notify.if).toContain("needs.prepare.outputs.release == 'true'");
    expect(workflow.jobs.tag.if).toContain("needs.prepare.outputs.release == 'true'");
    expect(workflow.jobs.tag.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.publish.if).toContain("needs.prepare.outputs.release == 'true'");
    expect(workflow.concurrency).toEqual({ group: 'npm-release', 'cancel-in-progress': false });
  });

  it('keeps one human approval, before the tag', () => {
    expect(workflow.jobs.approve.environment).toBe('release-approval');
    expect(workflow.jobs.tag.environment).toBe('release-tag');
    expect(workflow.jobs.publish.environment).toBe('npm-release');
    expect(workflow.jobs.prepare.environment).toBeUndefined();
    expect(workflow.jobs.notify.environment).toBeUndefined();
    expect(workflow.jobs['release-checks-ok'].environment).toBeUndefined();
    expect(workflow.jobs.finalize.environment).toBeUndefined();
    expect(workflow.jobs.approve.needs).toContain('release-checks-ok');
    expect(workflow.jobs.tag.needs).toContain('approve');
    expect(workflow.jobs.publish.needs).toContain('approve');
  });

  it('runs release checks in parallel and gates approval on a single pass', () => {
    const gate = workflow.jobs['release-checks-ok'];
    expect(gate.if).toContain('always()');
    expect(gate.needs).toEqual(
      expect.arrayContaining([
        'prepare',
        'release-checks',
        'release-unit',
        'release-packed-catalog',
        'release-audit',
      ])
    );
    expect(gate.outputs.commit).toBe('${{ needs.release-audit.outputs.commit }}');
    const step = gate.steps[0];
    expect(step.env.CHECKS).toBe('${{ needs.release-checks.result }}');
    expect(step.env.UNIT).toBe('${{ needs.release-unit.result }}');
    expect(step.env.PACKED).toBe('${{ needs.release-packed-catalog.result }}');
    expect(step.env.AUDIT).toBe('${{ needs.release-audit.result }}');
    expect(workflow.jobs.notify.needs).toContain('release-checks-ok');
    expect(workflow.jobs.approve.needs).toContain('release-checks-ok');
    expect(workflow.jobs.tag.needs).toContain('release-checks-ok');
    expect(workflow.jobs.publish.needs).toContain('release-checks-ok');
  });

  it('mirrors ci.yml check steps and unit matrix without caching', () => {
    const releaseChecks = workflow.jobs['release-checks'];
    const releaseUnit = workflow.jobs['release-unit'];
    expect(releaseChecks.steps.some((step) => step.run === 'pnpm security:fast')).toBe(true);
    expect(releaseChecks.steps.some((step) => step.run === 'pnpm skills:check')).toBe(true);
    expect(releaseChecks.steps.some((step) => step.run === 'pnpm build')).toBe(true);
    expect(releaseChecks.steps.some((step) => step.run === 'pnpm check')).toBe(true);
    expect(releaseChecks.steps.some((step) => step.run === 'pnpm test:structural')).toBe(true);
    expect(
      releaseChecks.steps.some((step) => step.run?.includes('third-party-notices.mjs --check'))
    ).toBe(true);
    expect(releaseUnit.strategy.matrix.leg).toEqual(ci.jobs.unit.strategy.matrix.leg);
    expect(releaseUnit.strategy['fail-fast']).toBe(false);
    const unitRun = releaseUnit.steps.find((step) => step.env?.UNIT_LEG);
    expect(unitRun.run).toBe('pnpm "test:unit:ci:$UNIT_LEG"');
  });

  it('builds the tarball and tag in release-audit and uploads a verified artifact', () => {
    const audit = workflow.jobs['release-audit'];
    expect(audit.outputs.commit).toBe('${{ steps.candidate.outputs.commit }}');
    expect(audit.steps.some((step) => step.run?.includes('stamp-version'))).toBe(true);
    expect(audit.steps.some((step) => step.run?.includes('git tag -a "$RELEASE_TAG"'))).toBe(true);
    expect(audit.steps.some((step) => step.run?.includes('pnpm security:release'))).toBe(true);
    expect(audit.steps.some((step) => step.run?.includes('git bundle create'))).toBe(true);
    const upload = audit.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload).toBeDefined();
    expect(upload.with['if-no-files-found']).toBe('error');
  });

  it('fails stalled registry installs fast instead of exhausting the job', () => {
    expect(workflow.env).toMatchObject({
      NPM_CONFIG_FETCH_TIMEOUT: '60000',
      NPM_CONFIG_FETCH_RETRIES: '4',
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '60000',
    });
    expect(workflow.jobs.prepare['timeout-minutes']).toBe(15);
    const auditSteps = workflow.jobs['release-audit'].steps;
    const step = (steps, pattern) => steps.find((entry) => pattern.test(entry.run ?? ''));
    expect(step(auditSteps, /@cyclonedx\/cdxgen/)['timeout-minutes']).toBe(5);
    expect(step(auditSteps, /pnpm security:release/)['timeout-minutes']).toBe(15);
    const packedSteps = workflow.jobs['release-packed-catalog'].steps;
    const packed = step(packedSteps, /test:packed-catalog/);
    expect(packed['timeout-minutes']).toBe(20);
    expect(packed.run).toContain('for attempt in 1 2; do');
    expect(packed.run).toContain('timeout 10m pnpm test:packed-catalog -- --skip-build');
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

describe('release on merge trigger', () => {
  const job = onMerge.jobs.decide;
  const steps = job.steps;

  it('runs on push to main while auto release is enabled', () => {
    expect(onMerge.on).toEqual({ push: { branches: ['main'] } });
    expect(onMergeSource).not.toMatch(/pull_request_target|pull_request|workflow_run/);
    expect(job.if).toContain("github.repository == 'bobsled-inc/dogsled-core'");
    expect(job.if).toContain("(vars.AUTO_RELEASE == 'on' || vars.AUTO_RELEASE == 'dry-run')");
  });

  it('uses least privilege, no secrets and no pull request head code', () => {
    expect(onMerge.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      actions: 'write',
    });
    expect(job.environment).toBeUndefined();
    expect(onMergeSource).not.toMatch(/secrets\.|head\.ref|head\.sha|pnpm|npm install/);
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with).toEqual({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      expect(step.run ?? '').not.toContain('${{');
    }
  });

  it('decides with trusted main code and dispatches only when the decision allows it', () => {
    const decide = steps.find((step) => step.id === 'decide');
    expect(decide.run).toBe('node scripts/release/version.mjs decide-merge');
    expect(decide.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      AUTO_RELEASE: '${{ vars.AUTO_RELEASE }}',
      MERGE_SHA: '${{ github.sha }}',
    });
    const dispatch = steps.find((step) => step.run?.includes('gh workflow run'));
    expect(dispatch.if).toBe("steps.decide.outputs.dispatch == 'true'");
    expect(dispatch.run).toBe('gh workflow run release.yml --ref main -f mode=auto');
  });

  it('notifies Husky with an OIDC token and a jq-built payload, and updates on completion', () => {
    const notify = workflow.jobs.notify;
    expect(notify.needs).toContain('release-checks-ok');
    expect(notify.if).toContain("needs.prepare.outputs.release == 'true'");
    expect(notify.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(notify.outputs.notified).toBe('${{ steps.husky.outputs.notified }}');
    const step = notify.steps[0];
    expect(step.env.HUSKY_ORIGIN).toBe('${{ secrets.HUSKY_ORIGIN || vars.HUSKY_ORIGIN }}');
    expect(step.env.NOTIFY_PRS).toBe('${{ needs.prepare.outputs.notify_prs }}');
    expect(step.env.NOTIFY_ONE_LINE).toBe('${{ needs.prepare.outputs.notify_one_line }}');
    expect(step.env.RELEASE_TAG).toBeUndefined();
    expect(step.run).toContain('audience=husky');
    expect(step.run).toContain('/api/releases/notify');
    expect(step.run).toMatch(/status.*"awaiting_approval"/);
    expect(step.run).toContain('jq --null-input');
    expect(step.run).toContain('NOTIFY_PRS:-[]');
    expect(step.run).toContain('exit 0');
    expect(step.run).not.toContain('${{');
    const status = workflow.jobs['release-status'];
    expect(status.if).toContain('always()');
    expect(status.if).toContain("needs.notify.outputs.notified == 'true'");
    expect(status.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(status.needs).toEqual(
      expect.arrayContaining(['prepare', 'notify', 'publish', 'finalize'])
    );
    const updateStep = status.steps[0];
    expect(updateStep.run).toContain('/api/releases/notify');
    expect(updateStep.run).toContain('audience=husky');
    expect(updateStep.run).toMatch(/status="released"/);
    expect(updateStep.run).toMatch(/status="not_released"/);
    expect(updateStep.run).toMatch(/PUBLISH_RESULT.*=.*"success".*\n\s*status="released"/);
    expect(updateStep.env.PUBLISH_RESULT).toBe('${{ needs.publish.result }}');
    expect(updateStep.env.FINALIZE_RESULT).toBeUndefined();
  });

  it('holds no Slack secrets and builds all Husky payloads with jq', () => {
    const releaseSource = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    expect(releaseSource).not.toMatch(
      /SLACK_BOT_TOKEN|SLACK_RELEASE_CHANNEL_ID|SLACK_RELEASE_WEBHOOK_URL|GIPHY_API_KEY/
    );
    expect(releaseSource).not.toMatch(/hooks\.slack\.com|slack\.com\/api/);
    expect(releaseSource).not.toMatch(/chat\.postMessage|chat\.update/);
    for (const job of [workflow.jobs.notify, workflow.jobs['release-status']]) {
      const step = job.steps[0];
      expect(step.run).toContain('jq');
      expect(step.run).not.toContain('${{');
    }
  });

  it('requests id-token write only on the notify and release-status jobs', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === 'notify' || name === 'release-status') {
        expect(job.permissions?.['id-token']).toBe('write');
      } else if (name === 'publish') {
        expect(job.permissions?.['id-token']).toBe('write');
      } else if (job.permissions) {
        expect(job.permissions['id-token']).toBeUndefined();
      }
    }
  });
});
