import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `process.dlopen` import-safety probe for the in-memory reverse-ETL action
 * builders, reached via the boundary-safe `@bobsled-inc/bobsled-core/schema` entry.
 *
 * Managed reverse-ETL consumers (the host application's Next.js/Vercel routes,
 * agents-elt) import these builders where `libduckdb` is unavailable. This test
 * spawns a fresh Node process, wraps `process.dlopen` so any attempt to load a
 * `*duckdb*.node` native binding throws, then imports the built schema entry
 * AND invokes both builders. Unlike the static-graph guard in
 * `schema-import-safety.test.ts`, this also exercises the call paths — if
 * invoking a builder ever reached a dynamic `import('@duckdb/node-api')`, the
 * native binding would dlopen and trip the guard.
 *
 * Requires the package to be built first (reads from `dist/`).
 */
const SCHEMA_DIST = fileURLToPath(new URL('../../dist/schema/index.js', import.meta.url));

describe('reverse-ETL action builders import safety', () => {
  it('builds actions without dlopen-ing the DuckDB native binding', () => {
    expect(
      existsSync(SCHEMA_DIST),
      `Expected built entry at ${SCHEMA_DIST}. Run \`pnpm --filter @bobsled-inc/bobsled-core build\` first.`
    ).toBe(true);

    const schemaUrl = JSON.stringify(pathToFileURL(SCHEMA_DIST).href);

    const probe = [
      'const origDlopen = process.dlopen.bind(process);',
      'process.dlopen = (mod, filename, ...rest) => {',
      "  if (String(filename).toLowerCase().includes('duckdb')) {",
      "    throw new Error('DUCKDB_DLOPEN: ' + filename);",
      '  }',
      '  return origDlopen(mod, filename, ...rest);',
      '};',
      `const mod = await import(${schemaUrl});`,
      "const sf = mod.buildSalesforceUpsertAction({ apiVersion: 'v59.0', sObject: 'Account', externalIdField: 'External_Id__c', mappedFields: ['name'] });",
      "if (sf.qualifiedName !== 'salesforce/upsert_sobject') throw new Error('bad sf qualifiedName: ' + sf.qualifiedName);",
      "const generic = mod.buildReverseEtlActionFromSpec(sf.spec, { integrationName: 'acme' });",
      "if (generic.qualifiedName !== 'acme/upsert_sobject') throw new Error('bad generic qualifiedName: ' + generic.qualifiedName);",
      "process.stdout.write('OK');",
    ].join('\n');

    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      stdio: 'pipe',
      timeout: 30_000,
    });

    expect(stdout.toString()).toContain('OK');
  });
});
