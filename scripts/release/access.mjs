const ALLOWED_ACCESS_MODES = new Set(['public', 'restricted']);

export function publishAccessForPackages(packages) {
  const accessModes = new Set(packages.map((pkg) => pkg.packageJson.publishConfig?.access));
  const access = packages[0]?.packageJson.publishConfig?.access;
  if (accessModes.size !== 1 || !ALLOWED_ACCESS_MODES.has(access)) {
    throw new Error(
      `Package access must be uniformly public or restricted, found: ${[...accessModes].join(', ')}`
    );
  }
  return access;
}
