import { createHash } from 'node:crypto';
import { publishWithIntegrity } from './registry-integrity.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listWorkspacePackages, repoRoot } from '../ci/shared.mjs';
import { sha256File } from '../security/lib.mjs';
import { publishAccessForPackages } from './access.mjs';
import { BOBSLED_CORE_PACKAGE_NAME } from './package-set.mjs';

if (
  process.env.GITHUB_REPOSITORY !== 'bobsled-inc/dogsled-core' ||
  process.env.GITHUB_ACTIONS !== 'true'
)
  throw new Error('Publication requires the dogsled-core release workflow.');

const bootstrap = process.argv[3] === '--bootstrap';
if (process.argv[3] && !bootstrap) throw new Error('Unknown publication mode.');
const outputDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  throw new Error('Usage: node scripts/release/publish.mjs <security-release-output>');
}

const report = JSON.parse(readFileSync(path.join(outputDir, 'release-report.json'), 'utf8'));
if (
  report.passed !== true ||
  report.packageCount !== 1 ||
  report.artifacts?.length !== 1 ||
  report.artifacts[0]?.package !== BOBSLED_CORE_PACKAGE_NAME
) {
  throw new Error(
    `Refusing to publish: the release security report did not pass for ${BOBSLED_CORE_PACKAGE_NAME}.`
  );
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
if (report.commit !== head) {
  throw new Error(
    `Refusing to publish: reviewed commit ${report.commit} does not match checkout ${head}.`
  );
}

const publishable = listWorkspacePackages().filter((pkg) => pkg.packageJson.private !== true);
if (publishable.length !== 1 || publishable[0].name !== BOBSLED_CORE_PACKAGE_NAME) {
  throw new Error(`Refusing to publish anything except ${BOBSLED_CORE_PACKAGE_NAME}.`);
}
const [bobsledPackage] = publishable;
const [artifact] = report.artifacts;
if (artifact.version !== bobsledPackage.packageJson.version)
  throw new Error('Reviewed artifact version differs from the release checkout.');
const tarball = path.resolve(outputDir, artifact.tarball);
if (!tarball.startsWith(`${outputDir}${path.sep}`)) {
  throw new Error('Reviewed tarball path escapes the release output directory.');
}
if (sha256File(tarball) !== artifact.sha256) {
  throw new Error('Reviewed tarball hash changed after inspection.');
}

const publishAccess = publishAccessForPackages([bobsledPackage]);
process.stdout.write(`Preparing ${bobsledPackage.name}@${bobsledPackage.packageJson.version}\n`);
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
if (artifact.sha512 !== integrity)
  throw new Error('Reviewed SHA-512 integrity changed after inspection.');
const request = {
  tarball,
  packageName: bobsledPackage.name,
  version: bobsledPackage.packageJson.version,
  access: publishAccess,
  visibility: process.env.RELEASE_REPOSITORY_VISIBILITY,
  bootstrap,
  integrity,
};
const result = await publishWithIntegrity(request);
process.stdout.write(
  `Registry integrity verified${result.alreadyPublished ? ' for the existing version' : ''}.\n`
);
