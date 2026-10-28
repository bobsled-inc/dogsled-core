import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listWorkspacePackages } from '../../scripts/ci/shared.mjs';

/**
 * Packaging contract for the `@bobsled-inc/*` family.
 *
 * Every package is pure ESM (`"type": "module"`), but downstream consumers do
 * not always resolve them through a bundler. When a consumer's tooling runs
 * under a CommonJS-default package (no `"type": "module"`), every
 * `import '@bobsled-inc/x'` is compiled to a CJS `require()`. If the `exports`
 * map only declares an `import` condition, that `require()` fails with the
 * misleading `ERR_PACKAGE_PATH_NOT_EXPORTED` — even though the subpath exists.
 *
 * To keep these packages resolvable from CJS tooling (and to give an actionable
 * error for the packages that genuinely cannot be `require()`d — e.g.
 * model-spec eager-loads a top-level-await WASM SDK), every export entry must
 * carry a non-ESM fallback condition (`default` or `require`) alongside
 * `import`, and every package must expose a `"."` root.
 *
 * The subpath contract below pins the entry points that downstream host
 * applications import across the repo boundary; dropping any of them silently
 * re-breaks the consumer's build.
 */

// Entry points imported by downstream host applications (cross-repo contract).
// Keyed by package name → required `exports` subpaths.
//
// This is hand-maintained: consumer repos aren't available at test time, so it
// can't be derived. When a consumer adds (or drops) a `@bobsled-inc/*` import,
// update this list to match — its `@bobsled-inc/<pkg>/<subpath>` import sites
// are the source of truth.
const CONSUMER_SUBPATHS = {
  '@bobsled-inc/dogsled': [
    '.',
    './pipeline',
    './project-skills',
    './resources',
    './connections',
    './ai',
    './ai/test-stubs',
    './model-spec/agentic',
    './extractor/extractor',
    './integrations',
    './integrations/catalog',
    './model-spec',
    './model-spec/project',
    './model-spec/schemas',
    './project-index',
    './blueprint-aliases',
  ],
};

const packages = listWorkspacePackages().filter((pkg) => pkg.packageJson.exports);

describe('package exports maps', () => {
  it.each(packages.map((pkg) => [pkg.name, pkg]))('%s exposes a "." root entry', (_name, pkg) => {
    expect(pkg.packageJson.exports).toHaveProperty(['.']);
  });

  it.each(packages.map((pkg) => [pkg.name, pkg]))(
    '%s declares a CJS-resolvable fallback (default/require) on every export entry',
    (_name, pkg) => {
      for (const [subpath, entry] of Object.entries(pkg.packageJson.exports)) {
        // Only conditional-object entries with an ESM target need a fallback.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.import) {
          continue;
        }
        const conditions = Object.keys(entry);
        expect(
          'default' in entry || 'require' in entry,
          `${pkg.name} "${subpath}" must declare a "default" or "require" condition so CJS \`require()\` resolves (has: ${conditions.join(', ')})`
        ).toBe(true);

        // `types` must be matched first when present (TS NodeNext resolution).
        if ('types' in entry) {
          expect(conditions[0], `${pkg.name} "${subpath}" must list "types" first`).toBe('types');
        }
      }
    }
  );

  it.each(packages.map((pkg) => [pkg.name, pkg]))(
    '%s keeps top-level main/types consistent with the "." entry (legacy resolver fallback)',
    (_name, pkg) => {
      const dot = pkg.packageJson.exports['.'];
      if (!dot || typeof dot !== 'object' || !dot.import) {
        return;
      }
      expect(pkg.packageJson.main, `${pkg.name} should set a top-level "main"`).toBe(dot.import);
      if (dot.types) {
        expect(pkg.packageJson.types, `${pkg.name} should set a top-level "types"`).toBe(dot.types);
      }
    }
  );

  it('exposes every subpath that downstream consumers import across the repo boundary', () => {
    const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    for (const [name, subpaths] of Object.entries(CONSUMER_SUBPATHS)) {
      const pkg = byName.get(name);
      expect(pkg, `${name} should exist in the workspace`).toBeTruthy();
      for (const subpath of subpaths) {
        expect(
          pkg.packageJson.exports,
          `${name} must export "${subpath}" — consumed by downstream host applications`
        ).toHaveProperty([subpath]);
      }
    }
  });

  // When the packages are built, every declared target must exist on disk.
  // Skipped in the unbuilt structural-tests CI job (no dist/), exercised by
  // `pnpm precommit` and local runs which build first.
  it.each(packages.map((pkg) => [pkg.name, pkg]))(
    '%s export targets resolve to real files when built',
    (_name, pkg) => {
      if (!existsSync(path.join(pkg.dir, 'dist'))) {
        return;
      }
      for (const [subpath, entry] of Object.entries(pkg.packageJson.exports)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          continue;
        }
        for (const [condition, target] of Object.entries(entry)) {
          if (typeof target !== 'string') continue;
          expect(
            existsSync(path.join(pkg.dir, target)),
            `${pkg.name} "${subpath}".${condition} → ${target} does not exist`
          ).toBe(true);
        }
      }
    }
  );
});
