import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { listWorkspacePackages, repoRoot } from '../ci/shared.mjs';
import {
  autoReleaseSummary,
  createGitHubReader,
  decideMergedPullRequest,
  mergeDecisionSummary,
  notifySummary,
  resolveAutoRelease,
} from './auto-release.mjs';
import { DOGSLED_PACKAGE_NAME } from './package-set.mjs';

export function incrementVersion(version, bump) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Only stable semantic versions are supported, found "${version}".`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (bump === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unsupported release bump: ${bump}`);
}

function releaseParts(version) {
  if (typeof version !== 'string') return null;
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/
  );
  if (!match) return null;
  const parts = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  return parts.every((part) => part === undefined || Number.isSafeInteger(part)) ? parts : null;
}

export function isPreviewVersion(version) {
  const parts = releaseParts(version);
  return parts !== null && parts[0] === 0 && parts[3] !== undefined;
}

export function assertReleaseVersion(version) {
  const parts = releaseParts(version);
  if (!parts || (parts[3] !== undefined && parts[0] !== 0))
    throw new Error('Release version must be stable X.Y.Z or 0.x.y-preview.N.');
}

export function previewVersion(packageVersion, tags, version) {
  if (!isPreviewVersion(version)) throw new Error('Preview version must be 0.x.y-preview.N.');
  const released = [packageVersion, ...tags.map((tag) => tag.replace(/^v/, ''))].filter((value) =>
    releaseParts(value)
  );
  if (released.some((value) => compareVersions(version, value) <= 0))
    throw new Error(
      'Preview version must advance the package and existing release tags; use retry for an existing tag.'
    );
  return version;
}

export function bootstrapVersion(packageVersion, tags) {
  if (packageVersion !== '0.1.0')
    throw new Error('Bootstrap requires the reviewed package version 0.1.0.');
  if (tags.some((tag) => /^v\d+\.\d+\.\d+$/.test(tag)))
    throw new Error('Bootstrap is only available before the first stable release tag.');
  return packageVersion;
}

function compareVersions(left, right) {
  const a = releaseParts(left),
    b = releaseParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return a[3] - b[3];
}

export function releaseBaseVersion(packageVersion, tags) {
  const versions = tags.map((tag) => tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1]).filter(Boolean);
  return [packageVersion, ...versions].sort(compareVersions).at(-1);
}

function publishablePackages() {
  const packages = listWorkspacePackages().filter((pkg) => pkg.packageJson.private !== true);
  if (packages.length !== 1 || packages[0].name !== DOGSLED_PACKAGE_NAME) {
    throw new Error(`Expected ${DOGSLED_PACKAGE_NAME} to be the one publishable package.`);
  }
  return packages;
}

export function currentPackageVersion() {
  return publishablePackages()[0].packageJson.version;
}

function writeStepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
  process.stdout.write(markdown);
}

function releaseTags() {
  return execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function githubReader() {
  return createGitHubReader({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
}

export function writeGithubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    const str = String(value);
    if (str.includes('\n')) {
      const delimiter = `ghadelimiter_${randomUUID()}`;
      if (str.includes(delimiter))
        throw new Error(`Output value for ${key} contains the generated delimiter.`);
      lines.push(`${key}<<${delimiter}`, str, delimiter);
    } else {
      lines.push(`${key}=${str}`);
    }
  }
  writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, { flag: 'a' });
}

/** Stamps `version` into the `package.json` at `packageJsonPath`, preserving all other fields. */
export function stampVersion(version, packageJsonPath) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  manifest.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateVersions(version) {
  const [dogsledPackage] = publishablePackages();
  stampVersion(version, dogsledPackage.packageJsonPath);
}

function prepareRelease(bump, changeType, breakingPrs = [], notify = '') {
  if (!['patch', 'minor', 'major'].includes(bump)) {
    throw new Error(`Release bump must be patch, minor, or major; found "${bump}".`);
  }
  const previousVersion = releaseBaseVersion(currentPackageVersion(), releaseTags());
  const version = incrementVersion(previousVersion, bump);
  updateVersions(version);
  writeGithubOutput({
    release: true,
    change_type: changeType,
    bump,
    previous_version: previousVersion,
    version,
    tag: `v${version}`,
    prerelease: false,
    breaking: bump === 'major',
    breaking_prs: breakingPrs.join(','),
    notify_summary: notify || `Release v${version}? (${bump}, ${changeType})`,
  });
  process.stdout.write(`Prepared ${bump} release v${version}.\n`);
}

async function prepareAutoRelease() {
  const previousVersion = releaseBaseVersion(currentPackageVersion(), releaseTags());
  const reader = githubReader();
  const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY || ''}`;
  const plan = await resolveAutoRelease({
    previousVersion,
    git: gitAt(repoRoot),
    listPullRequests: (sha) => reader(`/commits/${sha}/pulls?per_page=100`),
  });
  const version = plan.bump ? incrementVersion(previousVersion, plan.bump) : previousVersion;
  writeStepSummary(autoReleaseSummary(plan, version));
  if (!plan.bump) {
    writeGithubOutput({ release: false, previous_version: previousVersion });
    return;
  }
  const notify = notifySummary(plan, version, repoUrl);
  prepareRelease(plan.bump, 'auto', plan.breaking, notify);
}

async function decideMerge() {
  const autoRelease = process.env.AUTO_RELEASE;
  if (autoRelease !== 'on' && autoRelease !== 'dry-run')
    throw new Error('AUTO_RELEASE must be on or dry-run to decide a release.');
  const mergeSha = process.env.MERGE_SHA;
  if (!/^[a-f0-9]{40}$/.test(mergeSha ?? '')) throw new Error('MERGE_SHA must be a full commit.');
  const pullRequests = await githubReader()(`/commits/${mergeSha}/pulls?per_page=100`);
  const decision = decideMergedPullRequest(mergeSha, pullRequests);
  writeStepSummary(mergeDecisionSummary(decision, autoRelease));
  writeGithubOutput({
    release: decision.bump !== null,
    dispatch: decision.bump !== null && autoRelease === 'on',
    change_type: decision.changeType,
    bump: decision.bump ?? 'none',
  });
}

function gitAt(root) {
  return (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function verifyVersionOnlyCommit(commit, parent, git) {
  const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])
    .split(/\r?\n/)
    .filter(Boolean);
  if (changed.length !== 1 || changed[0] !== 'packages/dogsled/package.json')
    throw new Error('Retry release may change only packages/dogsled/package.json.');
  const before = JSON.parse(git(['show', `${parent}:packages/dogsled/package.json`]));
  const after = JSON.parse(git(['show', `${commit}:packages/dogsled/package.json`]));
  assertReleaseVersion(after.version);
  const version = after.version;
  delete before.version;
  delete after.version;
  if (!isDeepStrictEqual(before, after))
    throw new Error('Release manifest may change only version.');
  return version;
}

export function verifyReleaseCandidate({ commit, base, mode }, root = repoRoot) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !/^[a-f0-9]{40}$/.test(base ?? ''))
    throw new Error('Release candidate requires exact commit identities.');
  if (mode === 'bootstrap') {
    if (commit !== base) throw new Error('Bootstrap tag must equal the dispatched commit.');
  } else if (mode === 'new' || mode === 'auto' || mode === 'preview') {
    const git = gitAt(root);
    const parents = git(['rev-list', '--parents', '-n', '1', commit]).split(' ');
    if (parents.length !== 2 || parents[1] !== base)
      throw new Error('Release tag parent must equal the dispatched commit.');
    const version = verifyVersionOnlyCommit(commit, base, git);
    if ((mode === 'preview') !== isPreviewVersion(version))
      throw new Error('Release mode differs from the candidate version.');
  } else throw new Error('Tag creation supports only new, auto, preview or bootstrap mode.');
}

export function verifyRetryTag(version, root = repoRoot) {
  assertReleaseVersion(version);
  const git = gitAt(root);
  const commit = git(['rev-list', '-n', '1', `v${version}`]);
  try {
    git(['merge-base', '--is-ancestor', commit, 'origin/main']);
    if (version === '0.1.0') return commit;
  } catch {}
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).split(' ');
  if (parents.length !== 2)
    throw new Error('Retry release requires one parent from reviewed main.');
  try {
    git(['merge-base', '--is-ancestor', parents[1], 'origin/main']);
  } catch {
    throw new Error('Retry release parent is not on reviewed main.');
  }
  if (verifyVersionOnlyCommit(commit, parents[1], git) !== version)
    throw new Error('Retry tag differs from its manifest version.');
  return commit;
}

function assertRetryVersion(version) {
  const tagCommit = verifyRetryTag(version);
  if (currentPackageVersion() !== version)
    throw new Error('Requested retry version differs from the package version.');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (tagCommit !== head) throw new Error('Retry tag does not point at the checked-out commit.');
}

export async function runVersionCommand(command) {
  if (command === 'prepare-auto') {
    await prepareAutoRelease();
  } else if (command === 'decide-merge') {
    await decideMerge();
  } else if (command === 'prepare-manual') {
    prepareRelease(process.env.RELEASE_BUMP, 'manual');
  } else if (command === 'prepare-preview') {
    const version = previewVersion(
      currentPackageVersion(),
      releaseTags(),
      process.env.RELEASE_VERSION
    );
    updateVersions(version);
    writeGithubOutput({ release: true, version, tag: `v${version}`, prerelease: true });
    process.stdout.write(`Prepared preview release v${version}.\n`);
  } else if (command === 'stamp-version') {
    const version = process.env.RELEASE_VERSION;
    if (!version) throw new Error('RELEASE_VERSION is required for stamp-version.');
    updateVersions(version);
    process.stdout.write(`Stamped version ${version} into package.json.\n`);
  } else if (command === 'prepare-bootstrap') {
    const version = bootstrapVersion(currentPackageVersion(), releaseTags());
    writeGithubOutput({
      release: true,
      version,
      tag: `v${version}`,
      prerelease: isPreviewVersion(version),
    });
    process.stdout.write(`Prepared bootstrap release v${version} without a version bump.\n`);
  } else if (command === 'verify-candidate') {
    verifyReleaseCandidate({
      commit: process.env.RELEASE_COMMIT,
      base: process.env.GITHUB_SHA,
      mode: process.env.RELEASE_MODE,
    });
  } else if (command === 'validate-retry-origin') {
    verifyRetryTag(process.env.RELEASE_VERSION);
  } else if (command === 'verify-retry') {
    const version = process.env.RELEASE_VERSION;
    if (!version) throw new Error('RELEASE_VERSION is required for a retry.');
    assertRetryVersion(version);
    writeGithubOutput({
      release: true,
      version,
      tag: `v${version}`,
      prerelease: isPreviewVersion(version),
    });
    process.stdout.write(`Verified retry for v${version}.\n`);
  } else {
    throw new Error(
      'Usage: node scripts/release/version.mjs <prepare-auto|decide-merge|prepare-manual|prepare-preview|prepare-bootstrap|verify-retry>'
    );
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await runVersionCommand(process.argv[2]);
}
