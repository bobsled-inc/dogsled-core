import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the runtime bug reported against Bobsled Core CLI:
 *
 *   LOG (error): Extraction failed for airports (postgres):
 *                Dynamic require of "events" is not supported
 *
 * Root cause was that `pg` (and any other CJS-only Node driver loaded via
 * `await import('<name>')`) was being *inlined* into
 * `packages/extractor/dist/index.js` because tsup does not externalize
 * `optionalDependencies` by default. When the inlined module evaluated, it
 * called esbuild's `__require()` shim, which fell through to throwing
 * because the bundle had no `createRequire` banner. See `tsup.config.ts`
 * for the fix (explicit `external` list + banner).
 *
 * Keep `EXTERNAL_MODULES` below in lockstep with `RUNTIME_DYNAMIC_DEPS`
 * in `packages/extractor/tsup.config.ts`. If you add a new dynamic-import
 * call site for a Node driver, update both — diff drift means the test
 * silently stops covering the new driver.
 */
const DIST = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

// Must match `RUNTIME_DYNAMIC_DEPS` in tsup.config.ts entry-for-entry. The
// test asserts every name here stays out of the bundle, so missing entries
// = silent coverage gap.
const EXTERNAL_MODULES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/credential-providers',
  '@aws-sdk/rds-signer',
  '@clickhouse/client',
  '@databricks/sql',
  '@duckdb/node-api',
  '@google-cloud/bigquery',
  '@google-cloud/storage',
  'google-auth-library',
  'mysql2',
  'mysql2/promise',
  'pg',
  'pg-pool',
  'pg-protocol',
  'pg-types',
  'pgpass',
  'snowflake-sdk',
  'ssh2',
  'tedious',
] as const;

/**
 * Read the built bundle lazily so each test gets the freshest copy AND
 * a clear failure if the artifact is missing. The earlier
 * `describe.skip(!BUILT)` pattern silently passed the entire regression
 * suite when CI job ordering put tests before the build — exactly the
 * scenario this suite is supposed to catch.
 */
function readBundle(): string {
  expect(
    existsSync(DIST),
    `Expected built bundle at ${DIST}. Run \`pnpm --filter @bobsled-inc/extractor build\` before this test.`
  ).toBe(true);
  return readFileSync(DIST, 'utf-8');
}

describe('extractor bundle externals', () => {
  it('does not contain esbuild’s "Dynamic require" fallback string', () => {
    // The string only appears in bundles whose entry has an inlined CJS
    // dependency without a `createRequire` banner. We have both safeguards
    // (banner + external list) — confirm neither has regressed.
    const bundle = readBundle();
    expect(bundle).not.toMatch(/Dynamic require of "/);
  });

  it('declares a createRequire banner so any future inlined CJS works at runtime', () => {
    // Belt-and-suspenders: even if a transitive CJS dep slips past
    // `external`, the banner means Node's real `require` is in scope.
    const bundle = readBundle();
    expect(bundle).toMatch(/createRequire[^\n]+from\s+['"]node:module['"]/);
  });

  it.each(EXTERNAL_MODULES)('keeps "%s" external (not inlined)', (name) => {
    // `await import('<name>')` should remain a runtime resolution. If the
    // module's internals are inlined, the bundle contains either an
    // esbuild-style `__commonJS` wrapper referencing its source path, or
    // a path that looks like `node_modules/.pnpm/<name>@...`.
    const bundle = readBundle();
    const pnpmPath = new RegExp(`node_modules/\\.pnpm/${name.replace(/[/.]/g, '[/.]')}@`);
    expect(bundle).not.toMatch(pnpmPath);
  });

  it('stays under a sane size ceiling (catches accidental re-inlining)', () => {
    // Pre-fix the bundle was ~55,000 lines because pg was inlined. The
    // healthy size is ~20,000 lines. Pick a generous ceiling so unrelated
    // growth doesn't trip this guard, but tight enough that re-inlining
    // an entire CJS driver would push past it.
    expect(existsSync(DIST), `Expected built bundle at ${DIST}.`).toBe(true);
    const { size } = statSync(DIST);
    expect(size).toBeLessThan(2_000_000); // 2 MB hard ceiling
  });
});
