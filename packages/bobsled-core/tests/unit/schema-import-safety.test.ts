import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Import-safety guard for `@bobsled-inc/bobsled-core/schema`.
 *
 * The schema/catalog entry point exists so that consumers which only need to
 * validate or synthesize Dogsled config (e.g. a web app's config routes) can do
 * so WITHOUT pulling in the execution barrels (`./sync`, `./actions`, the
 * package root), which transitively reach `@bobsled-inc/extractor`'s runtime
 * barrel and — historically — eagerly loaded the DuckDB native binding at
 * module init.
 *
 * This test spawns a fresh Node process with a loader hook that throws if
 * `@duckdb/node-api` is *eagerly* resolved anywhere in the schema entry's
 * transitive graph, then imports the built entry. Dynamic `import()` call
 * sites (the runner code paths) are not triggered by merely importing the
 * entry, so they do not fire the guard. A static import anywhere in the graph
 * would.
 *
 * Note: this prevents schema/catalog imports from causing that class of
 * runtime failure. It does not — and cannot — stop a consumer that
 * deliberately imports an execution entry point.
 *
 * Requires the package to be built first (reads from `dist/`).
 */
const SCHEMA_DIST = fileURLToPath(new URL('../../dist/schema/index.js', import.meta.url));
const GUARD_LOADER = fileURLToPath(new URL('./fixtures/duckdb-guard-loader.mjs', import.meta.url));

describe('@bobsled-inc/bobsled-core/schema import safety', () => {
  it('imports without eagerly loading @duckdb/node-api', () => {
    expect(
      existsSync(SCHEMA_DIST),
      `Expected built entry at ${SCHEMA_DIST}. Run \`pnpm --filter @bobsled-inc/bobsled-core build\` first.`
    ).toBe(true);

    const schemaUrl = JSON.stringify(pathToFileURL(SCHEMA_DIST).href);

    // Throws (non-zero exit) if the guard fires; the assertion is the absence
    // of a thrown error. On failure, the child's stderr (carrying
    // "EAGER_DUCKDB_LOAD") is surfaced in the test output.
    expect(() =>
      execFileSync(
        process.execPath,
        ['--import', GUARD_LOADER, '--input-type=module', '-e', `await import(${schemaUrl});`],
        { stdio: 'pipe' }
      )
    ).not.toThrow();
  });
});
