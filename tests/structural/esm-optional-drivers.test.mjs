import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../../scripts/ci/shared.mjs';

// Optional drivers are loaded with require() so they stay optional peers. In an
// ESM bundle without a module-scoped require, esbuild turns that call into a
// __require shim that always throws "Dynamic require ... is not supported".
const OPTIONAL_DRIVERS = [
  'better-sqlite3',
  'pg',
  'snowflake-sdk',
  'mysql2',
  'mysql2/promise',
  'tedious',
  '@databricks/sql',
  '@google-cloud/bigquery',
  '@google-cloud/storage',
  '@clickhouse/client',
  '@aws-sdk/client-s3',
];
const BANNER = 'const require = __createRequire(import.meta.url)';

function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

describe('ESM bundles load optional drivers', () => {
  it('never compile a driver require into a throwing __require shim', () => {
    const packagesDir = path.join(repoRoot, 'packages');
    const offenders = [];
    for (const pkg of readdirSync(packagesDir)) {
      for (const file of jsFiles(path.join(packagesDir, pkg, 'dist'))) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(BANNER)) continue;
        for (const driver of OPTIONAL_DRIVERS) {
          if (text.includes(`__require("${driver}")`)) {
            offenders.push(`${path.relative(repoRoot, file)}: ${driver}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
