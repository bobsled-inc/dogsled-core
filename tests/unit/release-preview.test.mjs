import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  assertPreviewVersion,
  compareUnpacked,
  PREVIEW_PACKAGE_NAME,
  previewPolicy,
  publishPreview,
  repackAsPreview,
} from '../../scripts/release/preview.mjs';

const workflowSource = readFileSync(
  new URL('../../.github/workflows/preview-publish.yml', import.meta.url),
  'utf8'
);
const workflow = parse(workflowSource);
const actionsEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'bobsled-inc/dogsled-core',
  GITHUB_REF: 'refs/heads/rename/bobsled-core',
  RELEASE_REPOSITORY_VISIBILITY: 'private',
};
const temp = [];
const tempDir = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  temp.push(directory);
  return directory;
};
afterEach(() => {
  while (temp.length) rmSync(temp.pop(), { recursive: true, force: true });
});

function packFixture() {
  const root = tempDir();
  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'node_modules', 'bundled'), { recursive: true });
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: '@bobsled-inc/dogsled',
      version: '0.1.0-preview.1',
      bin: { dogsled: './cli.mjs' },
      dependencies: { bundled: '1.0.0' },
      bundleDependencies: ['bundled'],
    })
  );
  writeFileSync(path.join(pkg, 'cli.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(
    path.join(pkg, 'node_modules', 'bundled', 'package.json'),
    JSON.stringify({ name: 'bundled', version: '1.0.0' })
  );
  writeFileSync(path.join(pkg, 'node_modules', 'bundled', 'index.js'), 'export {};\n');
  const name = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], {
    cwd: pkg,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .at(-1);
  return path.join(root, name);
}

describe('preview package', () => {
  it('accepts only 0.1.0-preview.N versions', () => {
    expect(assertPreviewVersion('0.1.0-preview.1')).toBe('0.1.0-preview.1');
    for (const version of ['0.1.0', '0.1.0-preview.0', '0.2.0-preview.1', '1.0.0-preview.1', ''])
      expect(() => assertPreviewVersion(version)).toThrow();
  });

  it('publishes restricted with the preview tag from the private repository only', () => {
    const base = { access: 'restricted', visibility: 'private', version: '0.1.0-preview.2' };
    expect(previewPolicy(base)).toEqual({ provenance: false, distTag: 'preview' });
    expect(() => previewPolicy({ ...base, visibility: 'public' })).toThrow();
    expect(() => previewPolicy({ ...base, access: 'public' })).toThrow();
  });

  it('repacks a gated tarball changing only the package name', () => {
    const source = packFixture();
    const out = tempDir();
    const { tarball, manifest } = repackAsPreview(source, out);
    expect(manifest.name).toBe(PREVIEW_PACKAGE_NAME);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(listing).toContain('package/node_modules/bundled/index.js');
  }, 30_000);

  it('notices any change beyond the name', () => {
    const left = tempDir();
    const right = tempDir();
    for (const root of [left, right]) mkdirSync(path.join(root, 'package'));
    writeFileSync(path.join(left, 'package', 'package.json'), '{"name":"a","version":"1"}');
    writeFileSync(
      path.join(right, 'package', 'package.json'),
      `{"name":"${PREVIEW_PACKAGE_NAME}","version":"2"}`
    );
    writeFileSync(path.join(left, 'package', 'x.js'), 'a');
    writeFileSync(path.join(right, 'package', 'x.js'), 'b');
    expect(compareUnpacked(left, right)).toEqual([
      'package.json changed beyond its name',
      'package/x.js changed',
    ]);
  });

  it('refuses to publish outside the rename branch workflow', async () => {
    const publish = vi.fn();
    for (const env of [
      { ...actionsEnv, GITHUB_ACTIONS: undefined },
      { ...actionsEnv, GITHUB_REPOSITORY: 'bobsled-inc/bobsled-core' },
      { ...actionsEnv, GITHUB_REF: 'refs/heads/main' },
    ])
      await expect(publishPreview(tempDir(), { env, publish })).rejects.toThrow(/runs only in/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes the reviewed tarball and rejects a changed one', async () => {
    const out = tempDir();
    const tarball = path.join(out, 'preview.tgz');
    writeFileSync(tarball, 'tarball bytes');
    const bytes = readFileSync(tarball);
    const report = {
      package: PREVIEW_PACKAGE_NAME,
      version: '0.1.0-preview.3',
      tarball: 'preview.tgz',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sha512: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      passed: true,
    };
    writeFileSync(path.join(out, 'preview-report.json'), JSON.stringify(report));
    const publish = vi.fn(async () => ({ alreadyPublished: false }));
    await publishPreview(out, { env: actionsEnv, publish, bootstrap: true });
    const [request, , options] = publish.mock.calls[0];
    expect(request).toMatchObject({
      packageName: PREVIEW_PACKAGE_NAME,
      version: '0.1.0-preview.3',
      access: 'restricted',
      visibility: 'private',
      bootstrap: true,
      integrity: report.sha512,
    });
    expect(options.policy).toBe(previewPolicy);
    writeFileSync(tarball, 'tampered');
    await expect(publishPreview(out, { env: actionsEnv, publish })).rejects.toThrow(/changed/);
  });
});

describe('preview-publish workflow', () => {
  it('builds on dispatch from the rename branch and as a dry run on pull requests', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'pull_request']);
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.bootstrap.default).toBe(false);
    expect(workflow.on.pull_request.branches).toEqual(['rename/bobsled-core']);
    expect(workflow.jobs.build.if).toContain("github.repository == 'bobsled-inc/dogsled-core'");
    expect(workflow.jobs.build.if).toContain("github.ref == 'refs/heads/rename/bobsled-core'");
    expect(workflow.jobs.build.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(workflow.jobs.build)).not.toContain('secrets.');
  });

  it('publishes only on a non-dry-run dispatch from the branch, behind its environment', () => {
    const publish = workflow.jobs.publish;
    expect(publish.environment).toBe('npm-preview-bobsled');
    expect(publish.needs).toBe('build');
    for (const condition of [
      "github.event_name == 'workflow_dispatch'",
      "github.ref == 'refs/heads/rename/bobsled-core'",
      'inputs.dry_run == false',
    ])
      expect(publish.if).toContain(condition);
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const tokenSteps = publish.steps.filter((step) =>
      JSON.stringify(step.env ?? {}).includes('NPM_BOOTSTRAP_TOKEN')
    );
    expect(tokenSteps.map((step) => step.if)).toEqual(['inputs.bootstrap == true']);
  });

  it('never interpolates dispatch inputs into shell scripts', () => {
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) expect(step.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
  });
});
