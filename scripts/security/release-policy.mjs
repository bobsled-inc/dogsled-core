const FORBIDDEN_PACKAGE_SEGMENTS = new Set(['.security-review', 'AGENTS.md', 'CLAUDE.md']);

export function isForbiddenPackageEntry(entry) {
  const segments = entry.replaceAll('\\', '/').split('/');
  if (
    segments.some(
      (segment) =>
        FORBIDDEN_PACKAGE_SEGMENTS.has(segment) || segment === '.env' || segment.startsWith('.env.')
    )
  ) {
    return true;
  }

  const nodeModulesIndex = segments.indexOf('node_modules');
  const isInternalWorkspace =
    nodeModulesIndex >= 0 &&
    segments[nodeModulesIndex + 1] === '@bobsled-inc' &&
    segments[nodeModulesIndex + 2] !== undefined;
  const isPackageSource = nodeModulesIndex === -1 || isInternalWorkspace;
  return isPackageSource && segments.some((segment) => ['src', 'test', 'tests'].includes(segment));
}

export function packageImportSpecifiers(packageJson) {
  if (typeof packageJson.exports === 'string' || Array.isArray(packageJson.exports)) {
    return [packageJson.name];
  }
  if (!packageJson.exports || typeof packageJson.exports !== 'object') return [];
  const subpaths = Object.keys(packageJson.exports).filter(
    (subpath) => subpath === '.' || (subpath.startsWith('./') && !subpath.includes('*'))
  );
  if (subpaths.length === 0) return [packageJson.name];
  return subpaths.map((subpath) =>
    subpath === '.' ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`
  );
}
