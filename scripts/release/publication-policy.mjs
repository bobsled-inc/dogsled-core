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
