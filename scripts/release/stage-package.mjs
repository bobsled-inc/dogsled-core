import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { listWorkspacePackages, repoRoot } from '../ci/shared.mjs';
import {
  BUNDLED_EXTERNAL_PACKAGE_NAMES,
  BUNDLED_PACKAGE_ASSETS,
  EXPECTED_INTERNAL_PACKAGE_COUNT,
  INLINED_AI_DEPENDENCY_NAMES,
  INTERNAL_PACKAGE_NAMES,
  BOBSLED_CORE_PACKAGE_NAME,
} from './package-set.mjs';

function parseOutputDir(argv) {
  const index = argv.indexOf('--out');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) {
    throw new Error('Usage: node scripts/release/stage-package.mjs --out <directory>');
  }
  return path.resolve(value);
}

function assertSafeOutputDir(outputDir) {
  if (outputDir === repoRoot || outputDir === path.parse(outputDir).root) {
    throw new Error(`Refusing to stage into unsafe directory ${outputDir}.`);
  }
}

function workspacePackageMap() {
  return new Map(listWorkspacePackages().map((pkg) => [pkg.name, pkg]));
}

function catalogVersions() {
  const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  return {
    ...(workspace.catalog ?? {}),
    ...Object.values(workspace.catalogs ?? {}).reduce(
      (all, catalog) => ({ ...all, ...catalog }),
      {}
    ),
  };
}

function resolvePublishedVersion(specifier, dependencyName, catalogs) {
  if (specifier === 'catalog:') {
    const version = catalogs[dependencyName];
    if (!version) throw new Error(`No default catalog version exists for ${dependencyName}.`);
    return version;
  }
  if (specifier.startsWith('catalog:')) {
    const catalogName = specifier.slice('catalog:'.length);
    const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
    const version = workspace.catalogs?.[catalogName]?.[dependencyName];
    if (!version) {
      throw new Error(`No ${catalogName} catalog version exists for ${dependencyName}.`);
    }
    return version;
  }
  return specifier;
}

export function normalizeManifestDependencySpecifiers(
  manifest,
  sourceManifest,
  packages,
  catalogs
) {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section];
    if (!dependencies) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      const sourceSpecifier = sourceManifest[section]?.[name] ?? specifier;
      if (sourceSpecifier === 'workspace:*') {
        const workspace = packages.get(name);
        if (!workspace) throw new Error(`Unknown workspace dependency ${name}.`);
        dependencies[name] = workspace.packageJson.version;
      } else if (sourceSpecifier.startsWith('catalog:')) {
        dependencies[name] = resolvePublishedVersion(sourceSpecifier, name, catalogs);
      } else {
        dependencies[name] = sourceSpecifier;
      }
    }
  }
  return manifest;
}

export function removeInlinedAiDependencies(manifest) {
  if (manifest.name !== '@bobsled-inc/ai') return manifest;
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
  ]) {
    for (const name of INLINED_AI_DEPENDENCY_NAMES) {
      if (manifest[section]) delete manifest[section][name];
    }
  }
  return manifest;
}

export function normalizeStagedManifest(manifestPath, sourceManifest, packages, catalogs) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  normalizeManifestDependencySpecifiers(manifest, sourceManifest, packages, catalogs);
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest._dependencyNote;
  delete manifest.pnpm;
  removeInlinedAiDependencies(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function addInternalRuntimeDependencies(manifest, packages, catalogs) {
  const internalNames = new Set(INTERNAL_PACKAGE_NAMES);
  const inlinedDependencies = new Set(INLINED_AI_DEPENDENCY_NAMES);
  const runtimeDependencies = manifest.dependencies ?? {};
  const optionalDependencies = manifest.optionalDependencies ?? {};

  for (const name of INTERNAL_PACKAGE_NAMES) {
    const internalManifest = packages.get(name).packageJson;
    for (const [section, target] of [
      ['dependencies', runtimeDependencies],
      ['optionalDependencies', optionalDependencies],
    ]) {
      for (const [dependencyName, specifier] of Object.entries(internalManifest[section] ?? {})) {
        if (internalNames.has(dependencyName) || inlinedDependencies.has(dependencyName)) continue;
        const resolved = resolvePublishedVersion(specifier, dependencyName, catalogs);
        if (target[dependencyName] === undefined) target[dependencyName] = resolved;
      }
    }
  }

  manifest.dependencies = runtimeDependencies;
  for (const dependencyName of Object.keys(optionalDependencies)) {
    if (runtimeDependencies[dependencyName] !== undefined) {
      delete optionalDependencies[dependencyName];
    }
  }
  if (Object.keys(optionalDependencies).length > 0) {
    manifest.optionalDependencies = optionalDependencies;
  }
}

// npm treats every dependency of a bundled package as part of the bundle when
// it is installed under the bundling package. A global install places all of
// Bobsled Core's dependencies there, so the external dependencies and driver peers
// declared by bundled internal manifests were expected inside the tarball and
// left empty. Bundled manifests therefore keep only edges to other bundled
// packages. The top-level manifest already declares every external runtime
// dependency; driver peers stay unpromoted (see docs/dependency-security.md),
// and the drivers check their own versions at run time.
export function stripBundledManifestDependencies(manifest, bundledManifests) {
  const bundledNames = new Set([...INTERNAL_PACKAGE_NAMES, ...BUNDLED_EXTERNAL_PACKAGE_NAMES]);
  const inlinedNames = new Set(INLINED_AI_DEPENDENCY_NAMES);
  const optionalDependencies = manifest.optionalDependencies ?? {};
  for (const bundled of bundledManifests) {
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(bundled[section] ?? {})) {
        if (bundledNames.has(name) || inlinedNames.has(name)) continue;
        if (
          manifest.dependencies?.[name] === undefined &&
          optionalDependencies[name] === undefined
        ) {
          throw new Error(
            `${bundled.name} needs ${name}, but ${BOBSLED_CORE_PACKAGE_NAME} does not declare it.`
          );
        }
      }
    }
    for (const [name, range] of Object.entries(bundled.peerDependencies ?? {})) {
      if (optionalDependencies[name] !== undefined && optionalDependencies[name] !== range) {
        throw new Error(
          `${bundled.name} accepts ${name} ${range}, but ${BOBSLED_CORE_PACKAGE_NAME} installs ${name} ${optionalDependencies[name]}. Declare one range so a project's own ${name} is shared.`
        );
      }
    }
    bundled.dependencies = Object.fromEntries(
      Object.entries(bundled.dependencies ?? {}).filter(([name]) => bundledNames.has(name))
    );
    for (const section of ['optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      delete bundled[section];
    }
  }
  return manifest;
}

export function copyBundledPackageAssets(outputDir, sourceRoot = repoRoot) {
  for (const asset of BUNDLED_PACKAGE_ASSETS) {
    const packageDir = path.join(outputDir, 'node_modules', ...asset.package.split('/'));
    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const topLevel = asset.target.split('/')[0];
    if (!Array.isArray(manifest.files)) {
      throw new Error(`${asset.package} must declare files[] before assets are bundled.`);
    }
    if (!manifest.files.includes(`${topLevel}/`)) {
      manifest.files.push(`${topLevel}/`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    cpSync(path.join(sourceRoot, asset.source), path.join(packageDir, asset.target), {
      recursive: true,
      dereference: true,
    });
  }
}

function validateWorkspaceContract(packages) {
  const bobsledPackage = packages.get(BOBSLED_CORE_PACKAGE_NAME);
  if (!bobsledPackage || bobsledPackage.packageJson.private === true) {
    throw new Error(`${BOBSLED_CORE_PACKAGE_NAME} must be the one publishable workspace.`);
  }

  const internalNames = [...packages.values()]
    .filter((pkg) => pkg.name !== BOBSLED_CORE_PACKAGE_NAME)
    .map((pkg) => pkg.name)
    .sort();
  if (
    internalNames.length !== EXPECTED_INTERNAL_PACKAGE_COUNT ||
    internalNames.some((name, index) => name !== INTERNAL_PACKAGE_NAMES[index])
  ) {
    throw new Error(
      `Expected the reviewed ${EXPECTED_INTERNAL_PACKAGE_COUNT}-package internal set, found: ${internalNames.join(', ')}`
    );
  }

  for (const name of INTERNAL_PACKAGE_NAMES) {
    const pkg = packages.get(name);
    if (pkg?.packageJson.private !== true) {
      throw new Error(`${name} must remain private and unpublished.`);
    }
    if (pkg.packageJson.publishConfig !== undefined) {
      throw new Error(`${name} must not declare npm publishConfig.`);
    }
    if (bobsledPackage.packageJson.dependencies?.[name] !== 'workspace:*') {
      throw new Error(`${BOBSLED_CORE_PACKAGE_NAME} must depend on internal workspace ${name}.`);
    }
  }

  const bundled = [...(bobsledPackage.packageJson.bundleDependencies ?? [])].sort();
  const expectedBundled = [...INTERNAL_PACKAGE_NAMES, ...BUNDLED_EXTERNAL_PACKAGE_NAMES].sort();
  if (
    bundled.length !== expectedBundled.length ||
    bundled.some((name, index) => name !== expectedBundled[index])
  ) {
    throw new Error(`${BOBSLED_CORE_PACKAGE_NAME} must bundle the complete reviewed package set.`);
  }

  return bobsledPackage;
}

function cleanDeploymentNodeModules(outputDir) {
  const nodeModulesDir = path.join(outputDir, 'node_modules');
  const scopeDir = path.join(nodeModulesDir, '@bobsled-inc');
  const internalStageDir = path.join(outputDir, '.internal-workspaces');
  mkdirSync(internalStageDir, { recursive: true });

  for (const name of INTERNAL_PACKAGE_NAMES) {
    const packagePath = path.join(scopeDir, name.slice('@bobsled-inc/'.length));
    const sourcePath = realpathSync(packagePath);
    const stagedPath = path.join(internalStageDir, name.slice('@bobsled-inc/'.length));
    cpSync(sourcePath, stagedPath, { recursive: true, dereference: true });
    rmSync(path.join(stagedPath, 'node_modules'), { recursive: true, force: true });
  }
  for (const name of BUNDLED_EXTERNAL_PACKAGE_NAMES) {
    const sourcePath = realpathSync(path.join(nodeModulesDir, ...name.split('/')));
    cpSync(sourcePath, path.join(internalStageDir, 'external', ...name.split('/')), {
      recursive: true,
      dereference: true,
    });
  }

  rmSync(nodeModulesDir, { recursive: true, force: true });
  mkdirSync(scopeDir, { recursive: true });
  for (const name of INTERNAL_PACKAGE_NAMES) {
    const shortName = name.slice('@bobsled-inc/'.length);
    cpSync(path.join(internalStageDir, shortName), path.join(scopeDir, shortName), {
      recursive: true,
      dereference: true,
    });
  }
  for (const name of BUNDLED_EXTERNAL_PACKAGE_NAMES) {
    const packagePath = path.join(nodeModulesDir, ...name.split('/'));
    mkdirSync(path.dirname(packagePath), { recursive: true });
    cpSync(path.join(internalStageDir, 'external', ...name.split('/')), packagePath, {
      recursive: true,
      dereference: true,
    });
  }
  rmSync(internalStageDir, { recursive: true, force: true });
}

export function stageBobsledPackage(outputDir, { build = true } = {}) {
  assertSafeOutputDir(outputDir);
  const packages = workspacePackageMap();
  const bobsledPackage = validateWorkspaceContract(packages);
  const catalogs = catalogVersions();

  if (build) {
    execFileSync('pnpm', ['--filter', `${BOBSLED_CORE_PACKAGE_NAME}...`, 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }

  execFileSync(
    'pnpm',
    [
      '--config.inject-workspace-packages=true',
      'deploy',
      '--filter',
      BOBSLED_CORE_PACKAGE_NAME,
      '--prod',
      outputDir,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );

  cleanDeploymentNodeModules(outputDir);

  normalizeStagedManifest(
    path.join(outputDir, 'package.json'),
    bobsledPackage.packageJson,
    packages,
    catalogs
  );

  const manifestPath = path.join(outputDir, 'package.json');
  const stagedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  addInternalRuntimeDependencies(stagedManifest, packages, catalogs);
  stagedManifest.private = false;
  stagedManifest.bundleDependencies = [
    ...INTERNAL_PACKAGE_NAMES,
    ...BUNDLED_EXTERNAL_PACKAGE_NAMES,
  ];

  const bundledManifests = [];
  for (const name of INTERNAL_PACKAGE_NAMES) {
    const internal = packages.get(name);
    stagedManifest.dependencies[name] = internal.packageJson.version;
    const installedManifest = path.join(
      outputDir,
      'node_modules',
      ...name.split('/'),
      'package.json'
    );
    if (!existsSync(installedManifest)) {
      throw new Error(`Deployed package is missing bundled internal workspace ${name}.`);
    }
    bundledManifests.push({
      path: installedManifest,
      manifest: normalizeStagedManifest(
        installedManifest,
        internal.packageJson,
        packages,
        catalogs
      ),
    });
  }

  stripBundledManifestDependencies(
    stagedManifest,
    bundledManifests.map(({ manifest }) => manifest)
  );
  for (const { path: bundledPath, manifest } of bundledManifests) {
    writeFileSync(bundledPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  copyBundledPackageAssets(outputDir);

  writeFileSync(manifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  process.stdout.write(
    `Staged ${BOBSLED_CORE_PACKAGE_NAME}@${bobsledPackage.packageJson.version} with ${EXPECTED_INTERNAL_PACKAGE_COUNT} bundled internal workspaces at ${outputDir}.\n`
  );
  return { outputDir, manifest: stagedManifest };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  stageBobsledPackage(parseOutputDir(process.argv.slice(2)));
}
