import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../ci/shared.mjs';
import { publishAccessForPackages } from './access.mjs';
import { DOGSLED_PACKAGE_NAME } from './package-set.mjs';
import { assertReleaseVersion, isPreviewVersion } from './version.mjs';

export function publicationPolicy({ access, visibility, version, bootstrap = false }) {
  assertReleaseVersion(version);
  if (!['private', 'public'].includes(visibility))
    throw new Error('An explicit private or public repository visibility is required.');
  const expectedAccess = visibility === 'private' ? 'restricted' : 'public';
  if (access !== expectedAccess)
    throw new Error(
      `Repository visibility ${visibility} requires reviewed publishConfig.access ${expectedAccess}.`
    );
  if (bootstrap && (visibility !== 'private' || version !== '0.1.0'))
    throw new Error('Bootstrap requires private restricted 0.1.0.');
  return {
    provenance: visibility === 'public',
    distTag: isPreviewVersion(version) ? 'preview' : 'latest',
  };
}

/** Applies the publication policy to the package manifest at `ref`, without checking it out. */
export function verifyPublicationPolicy({ ref, visibility, mode }, root = repoRoot) {
  if (ref?.startsWith('refs/tags/v')) assertReleaseVersion(ref.slice('refs/tags/v'.length));
  else if (!/^[a-f0-9]{40}$/.test(ref ?? ''))
    throw new Error('The publication policy requires an exact commit or release tag.');
  const packageJson = JSON.parse(
    execFileSync('git', ['show', `${ref}:packages/dogsled/package.json`], {
      cwd: root,
      encoding: 'utf8',
    })
  );
  if (packageJson.name !== DOGSLED_PACKAGE_NAME)
    throw new Error(`Expected ${DOGSLED_PACKAGE_NAME} to be the publishable package.`);
  return publicationPolicy({
    access: publishAccessForPackages([{ packageJson }]),
    visibility,
    version: packageJson.version,
    bootstrap: mode === 'bootstrap',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  verifyPublicationPolicy({
    ref: process.env.RELEASE_POLICY_REF,
    visibility: process.env.RELEASE_REPOSITORY_VISIBILITY,
    mode: process.env.RELEASE_MODE,
  });
  process.stdout.write('Package access matches the repository visibility.\n');
}
