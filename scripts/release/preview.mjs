/**
 * Bobsled Core preview packages, built and published from rename/bobsled-core.
 *
 *   node scripts/release/preview.mjs stage --gate <release-gate-dir> --out <dir>
 *   node scripts/release/preview.mjs publish <dir> [--bootstrap]
 *
 * `stage` takes the tarball that passed the normal release gate
 * (`pnpm security:release --execute`), renames it to the restricted preview
 * package and proves that nothing else changed: same file list, same bytes,
 * and a package.json that differs only in `name`. Then it installs the preview
 * tarball and runs its imports and CLI help.
 *
 * `publish` runs only in GitHub Actions, in dogsled-core, from the rename
 * branch. It publishes with the preview dist-tag and checks the registry
 * integrity against the reviewed tarball.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOGSLED_PACKAGE_NAME } from './package-set.mjs';
import { publishWithIntegrity } from './registry-integrity.mjs';

export const PREVIEW_PACKAGE_NAME = '@bobsled-inc/bobsled-core-preview';
export const PREVIEW_REPOSITORY = 'bobsled-inc/dogsled-core';
export const PREVIEW_REF = 'refs/heads/rename/bobsled-core';
export const BOOTSTRAP_VERSION = '0.1.0-preview.1';
const DELEGATED_HELP_COMMANDS = ['extract', 'load', 'model', 'entity-graph', 'embed'];

/** Previews of the new package line: 0.1.0-preview.N with N >= 1. */
export function assertPreviewVersion(version) {
  if (typeof version !== 'string' || !/^0\.1\.0-preview\.[1-9]\d*$/.test(version))
    throw new Error('Preview version must be 0.1.0-preview.N (N >= 1).');
  return version;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha512 = (file) =>
  `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

function listTree(root, prefix = '') {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? listTree(root, relative) : [relative];
  });
}

function extract(tarball) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bobsled-core-preview-'));
  execFileSync('tar', ['-xzf', tarball, '-C', directory]);
  return directory;
}

/** Differences between two unpacked packages other than the package.json name. */
export function compareUnpacked(sourceRoot, previewRoot) {
  const differences = [];
  const source = listTree(sourceRoot).sort();
  const preview = listTree(previewRoot).sort();
  if (JSON.stringify(source) !== JSON.stringify(preview))
    differences.push('the preview tarball has a different file list');
  for (const file of source) {
    const a = path.join(sourceRoot, file);
    const b = path.join(previewRoot, file);
    if (!existsSync(b)) continue;
    if (file === path.join('package', 'package.json')) {
      const left = JSON.parse(readFileSync(a, 'utf8'));
      const right = JSON.parse(readFileSync(b, 'utf8'));
      if (right.name !== PREVIEW_PACKAGE_NAME) differences.push('package.json name is wrong');
      if (JSON.stringify({ ...left, name: null }) !== JSON.stringify({ ...right, name: null }))
        differences.push('package.json changed beyond its name');
    } else if (statSync(a).mode !== statSync(b).mode || sha256(a) !== sha256(b)) {
      differences.push(`${file} changed`);
    }
  }
  return differences;
}

function smoke(tarball, manifest) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'bobsled-core-preview-smoke-'));
  try {
    writeFileSync(
      path.join(scratch, 'package.json'),
      `${JSON.stringify({ name: 'preview-smoke', private: true, type: 'module' })}\n`
    );
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 15 * 60 * 1000,
      });
      if (result.status !== 0)
        throw new Error(`${path.basename(command)} ${args.join(' ')} failed in the preview smoke.`);
    };
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
    const installed = JSON.parse(
      readFileSync(
        path.join(scratch, 'node_modules', ...PREVIEW_PACKAGE_NAME.split('/'), 'package.json'),
        'utf8'
      )
    );
    if (installed.name !== PREVIEW_PACKAGE_NAME || installed.version !== manifest.version)
      throw new Error('The installed preview reports the wrong name or version.');
    const subpaths = Object.keys(manifest.exports ?? { '.': null }).filter(
      (key) => !key.includes('*') && key !== './package.json'
    );
    const specifiers = subpaths.map((key) => PREVIEW_PACKAGE_NAME + key.slice(1));
    run(process.execPath, [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(specifiers)}.map((s) => import(s)))`,
    ]);
    for (const bin of Object.keys(manifest.bin ?? {})) {
      const binPath = path.join(scratch, 'node_modules', '.bin', bin);
      for (const args of [['--help'], ...DELEGATED_HELP_COMMANDS.map((c) => [c, '--help'])])
        run(binPath, args);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Repacks a gated tarball under the preview name and proves only the name changed. */
export function repackAsPreview(sourceTarball, outDir) {
  mkdirSync(outDir, { recursive: true });
  const sourceRoot = extract(sourceTarball);
  const workRoot = extract(sourceTarball);
  let previewRoot;
  try {
    const manifestPath = path.join(workRoot, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.name = PREVIEW_PACKAGE_NAME;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const tarballName = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', path.resolve(outDir)],
      { cwd: path.join(workRoot, 'package'), encoding: 'utf8' }
    )
      .trim()
      .split(/\r?\n/)
      .at(-1);
    const tarball = path.join(path.resolve(outDir), tarballName);
    previewRoot = extract(tarball);
    const differences = compareUnpacked(sourceRoot, previewRoot);
    if (differences.length > 0) throw new Error(`Preview repack: ${differences.join('; ')}`);
    return { tarball, tarballName, manifest };
  } finally {
    for (const directory of [sourceRoot, workRoot, previewRoot])
      if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

export function stagePreview(gateDir, outDir) {
  const gate = JSON.parse(readFileSync(path.join(gateDir, 'release-report.json'), 'utf8'));
  const [artifact] = gate.artifacts ?? [];
  if (
    gate.passed !== true ||
    gate.artifacts?.length !== 1 ||
    artifact.package !== DOGSLED_PACKAGE_NAME
  )
    throw new Error('The release gate did not pass for the one publishable package.');
  assertPreviewVersion(artifact.version);
  const sourceTarball = path.resolve(gateDir, artifact.tarball);
  if (!sourceTarball.startsWith(`${path.resolve(gateDir)}${path.sep}`))
    throw new Error('The gate tarball path escapes the gate directory.');
  if (sha256(sourceTarball) !== artifact.sha256)
    throw new Error('The gate tarball changed after the release gate.');

  const { tarball, tarballName, manifest } = repackAsPreview(sourceTarball, outDir);
  smoke(tarball, manifest);
  const report = {
    package: PREVIEW_PACKAGE_NAME,
    version: manifest.version,
    commit: gate.commit,
    sourcePackage: artifact.package,
    sourceSha256: artifact.sha256,
    tarball: tarballName,
    sha256: sha256(tarball),
    sha512: sha512(tarball),
    passed: true,
  };
  writeFileSync(path.join(outDir, 'preview-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Staged ${PREVIEW_PACKAGE_NAME}@${report.version} (${report.sha512}).\n`);
  return report;
}

/** Restricted, preview dist-tag, no provenance: the repository is private. */
export function previewPolicy({ access, visibility, version, bootstrap = false }) {
  assertPreviewVersion(version);
  // The one-time token only creates the package; later previews use trusted publishing.
  if (bootstrap && version !== BOOTSTRAP_VERSION)
    throw new Error(`Bootstrap publishes only ${BOOTSTRAP_VERSION}.`);
  if (visibility !== 'private' || access !== 'restricted')
    throw new Error('Previews publish restricted from the private repository only.');
  return { provenance: false, distTag: 'preview' };
}

export async function publishPreview(
  outDir,
  { bootstrap = false, env = process.env, publish = publishWithIntegrity } = {}
) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== PREVIEW_REPOSITORY ||
    env.GITHUB_REF !== PREVIEW_REF
  )
    throw new Error(`Preview publishing runs only in ${PREVIEW_REPOSITORY} from ${PREVIEW_REF}.`);
  const report = JSON.parse(readFileSync(path.join(outDir, 'preview-report.json'), 'utf8'));
  if (report.passed !== true || report.package !== PREVIEW_PACKAGE_NAME)
    throw new Error('Refusing to publish: the preview report did not pass.');
  assertPreviewVersion(report.version);
  const tarball = path.resolve(outDir, report.tarball);
  if (!tarball.startsWith(`${path.resolve(outDir)}${path.sep}`))
    throw new Error('The preview tarball path escapes the artifact directory.');
  if (sha256(tarball) !== report.sha256 || sha512(tarball) !== report.sha512)
    throw new Error('The preview tarball changed after staging.');
  // Read the identity from the tarball itself, not only from the report.
  const packed = JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  );
  if (packed.name !== PREVIEW_PACKAGE_NAME || packed.version !== report.version)
    throw new Error('The preview tarball does not contain the reviewed package name and version.');
  const request = {
    tarball,
    packageName: PREVIEW_PACKAGE_NAME,
    version: report.version,
    access: 'restricted',
    visibility: env.RELEASE_REPOSITORY_VISIBILITY,
    bootstrap,
    integrity: report.sha512,
  };
  const result = await publish(request, spawnSync, { policy: previewPolicy });
  process.stdout.write(
    `Registry integrity verified for ${PREVIEW_PACKAGE_NAME}@${report.version}${result.alreadyPublished ? ' (already published)' : ''}.\n`
  );
  return result;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };
  if (command === 'stage' && option('gate') && option('out')) {
    stagePreview(path.resolve(option('gate')), path.resolve(option('out')));
  } else if (command === 'publish' && rest[0] && !rest[0].startsWith('--')) {
    const extra = rest.slice(1);
    if (extra.some((arg) => arg !== '--bootstrap')) throw new Error('Unknown publish option.');
    await publishPreview(path.resolve(rest[0]), { bootstrap: extra.includes('--bootstrap') });
  } else {
    throw new Error(
      'Usage: preview.mjs stage --gate <dir> --out <dir> | preview.mjs publish <dir> [--bootstrap]'
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
