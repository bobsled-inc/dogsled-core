import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ASSET_NAME_PATTERN = /^[\w.-]+$/;
const RELEASE_FIELDS = 'tagName,isDraft,isPrerelease,assets';

export function runGh(args, { binary = false } = {}) {
  const result = spawnSync('gh', args, {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  if (result.error) throw new Error(`gh ${args.slice(0, 2).join(' ')} could not run.`);
  return result;
}

function gh(run, args, options) {
  const result = run(args, options);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Malformed ${what} response.`);
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseAssetSpecs(specs) {
  if (!Array.isArray(specs) || specs.length === 0)
    throw new Error('At least one release asset is required.');
  const names = new Set();
  return specs.map((spec) => {
    const separator = spec.indexOf('#');
    const file = separator > 0 ? spec.slice(0, separator) : spec;
    const name = path.basename(file);
    if (!ASSET_NAME_PATTERN.test(name)) throw new Error(`Unsupported release asset name ${name}.`);
    if (names.has(name)) throw new Error(`Duplicate release asset name ${name}.`);
    names.add(name);
    return { spec, file, name };
  });
}

function resolveTagCommit(run, repo, tag) {
  let { object } = parseJson(gh(run, ['api', `repos/${repo}/git/ref/tags/${tag}`]), 'tag ref');
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
    ({ object } = parseJson(gh(run, ['api', `repos/${repo}/git/tags/${object.sha}`]), 'tag'));
  }
  if (object?.type !== 'commit' || !COMMIT_PATTERN.test(object.sha ?? ''))
    throw new Error(`Tag ${tag} does not resolve to a commit.`);
  return object.sha;
}

function viewRelease(run, repo, tag) {
  const result = run(['release', 'view', tag, '--repo', repo, '--json', RELEASE_FIELDS]);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    if (/release not found/i.test(detail)) return null;
    throw new Error(`gh release view failed${detail ? `: ${detail}` : '.'}`);
  }
  const release = parseJson(result.stdout, 'release');
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets))
    throw new Error('Malformed release response.');
  return release;
}

function checkRelease(release, { tag, prerelease }) {
  if (release.tagName !== tag)
    throw new Error(`Existing release targets tag ${release.tagName}, expected ${tag}.`);
  if (release.isPrerelease !== prerelease)
    throw new Error(
      `Existing release ${tag} has prerelease=${release.isPrerelease}, expected ${prerelease}.`
    );
}

function remoteSha256(run, repo, tag, asset) {
  if (asset.digest) {
    const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest);
    if (!match) throw new Error(`Release asset ${asset.name} has an unsupported digest.`);
    return match[1];
  }
  const args = ['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '-O', '-'];
  return sha256(gh(run, args, { binary: true }));
}

function missingAssets(run, repo, tag, release, assets) {
  const remote = new Map();
  for (const asset of release.assets) {
    if (remote.has(asset.name)) throw new Error(`Release ${tag} has duplicate ${asset.name}.`);
    remote.set(asset.name, asset);
  }
  const missing = [];
  for (const asset of assets) {
    const existing = remote.get(asset.name);
    if (!existing) {
      missing.push(asset);
      continue;
    }
    if (existing.state !== 'uploaded') {
      throw new Error(
        `Release asset ${asset.name} is an incomplete upload (state ${existing.state}). Inspect the release; finalization never overwrites or deletes assets.`
      );
    }
    const actual = remoteSha256(run, repo, tag, existing);
    if (actual !== asset.sha256) {
      throw new Error(
        `Release asset ${asset.name} differs from the reviewed local file (remote SHA-256 ${actual}, local ${asset.sha256}). Refusing to overwrite or delete it.`
      );
    }
  }
  return missing;
}

export function breakingBanner(breaking, pullRequests = '') {
  if (breaking !== true) return null;
  if (!/^(?:[1-9]\d*(?:,[1-9]\d*)*)?$/.test(pullRequests))
    throw new Error('Breaking pull requests must be a comma-separated list of numbers.');
  const source = pullRequests
    ? ` from ${pullRequests
        .split(',')
        .map((number) => `#${number}`)
        .join(', ')}`
    : '';
  return `> [!WARNING]\n> **Breaking:** this release contains breaking changes${source}. Read them before upgrading.\n`;
}

export function finalizeGitHubRelease(
  { repo, tag, commit, prerelease, assets, notes = null },
  run = runGh
) {
  if (!REPO_PATTERN.test(repo ?? '')) throw new Error('A GitHub owner/repository is required.');
  if (!TAG_PATTERN.test(tag ?? '')) throw new Error('A release version tag is required.');
  if (!COMMIT_PATTERN.test(commit ?? '')) throw new Error('The full release commit is required.');
  if (typeof prerelease !== 'boolean') throw new Error('The prerelease flag must be a boolean.');
  const expected = parseAssetSpecs(assets).map((asset) => ({
    ...asset,
    sha256: sha256(readFileSync(asset.file)),
  }));

  const tagCommit = resolveTagCommit(run, repo, tag);
  if (tagCommit !== commit)
    throw new Error(`Tag ${tag} points at ${tagCommit}, expected release commit ${commit}.`);

  const flags = prerelease ? ['--prerelease', '--latest=false'] : [];
  const existing = viewRelease(run, repo, tag);
  const outcome = { tag, commit, created: false, uploaded: [], published: false };
  if (!existing) {
    gh(run, [
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--verify-tag',
      '--generate-notes',
      ...(notes ? [`--notes=${notes}`] : []),
      ...flags,
      ...expected.map((asset) => asset.spec),
    ]);
    outcome.created = true;
  } else {
    checkRelease(existing, { tag, prerelease });
    const missing = missingAssets(run, repo, tag, existing, expected);
    if (missing.length > 0) {
      gh(run, ['release', 'upload', tag, '--repo', repo, ...missing.map((asset) => asset.spec)]);
      outcome.uploaded = missing.map((asset) => asset.name);
    }
    if (existing.isDraft) {
      gh(run, ['release', 'edit', tag, '--repo', repo, '--draft=false', ...flags]);
      outcome.published = true;
    }
  }

  const final = viewRelease(run, repo, tag);
  if (!final) throw new Error(`Release ${tag} is missing after finalization.`);
  checkRelease(final, { tag, prerelease });
  if (final.isDraft) throw new Error(`Release ${tag} is still a draft after finalization.`);
  const absent = missingAssets(run, repo, tag, final, expected);
  if (absent.length > 0)
    throw new Error(`Release ${tag} is missing ${absent.map((asset) => asset.name).join(', ')}.`);
  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.env.RELEASE_PRERELEASE;
  if (flag !== 'true' && flag !== 'false')
    throw new Error('RELEASE_PRERELEASE must be true or false.');
  const breaking = process.env.RELEASE_BREAKING;
  if (![undefined, '', 'true', 'false'].includes(breaking))
    throw new Error('RELEASE_BREAKING must be true or false.');
  const outcome = finalizeGitHubRelease({
    repo: process.env.GH_REPO,
    tag: process.env.RELEASE_TAG,
    commit: process.env.RELEASE_COMMIT,
    prerelease: flag === 'true',
    assets: process.argv.slice(2),
    notes: breakingBanner(breaking === 'true', process.env.RELEASE_BREAKING_PRS ?? ''),
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}
