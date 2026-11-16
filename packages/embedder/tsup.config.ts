import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

interface PackageJson {
  version: string;
}

const packageJsonPath = fileURLToPath(new URL('./package.json', import.meta.url));
const rawPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Partial<PackageJson>;

if (typeof rawPackageJson.version !== 'string' || rawPackageJson.version.length === 0) {
  throw new Error('Invalid package.json: missing "version"');
}

const pkg: PackageJson = {
  version: rawPackageJson.version,
};

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'runtime/index': 'src/runtime/index.ts',
      // Pure-zod schema entry. Importing from `@bobsled-inc/embedder/schema`
      // gives consumers `createEmbedConfigSchema` (and the supporting field /
      // streams schemas) without pulling in the embedder runtime, which
      // transitively loads `@bobsled-inc/loader`'s DuckDB primitives at
      // module-init. Used by Bobsled Core's manifest library so server-side / Lambda
      // consumers can validate the `embed:` block without needing
      // libduckdb.so available at import time.
      config: 'src/config.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
