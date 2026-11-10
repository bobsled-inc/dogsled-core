import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'compiler/index': 'src/compiler/index.ts',
      'compiler/schemas': 'src/compiler/schemas.ts',
      'agentic/index': 'src/agentic/index.ts',
      'api/index': 'src/api/index.ts',
      'ontology/index': 'src/ontology/index.ts',
      'ossie/index': 'src/ossie/index.ts',
      'interchange/index': 'src/interchange/index.ts',
      'edit/index': 'src/edit/index.ts',
      shared: 'src/shared.ts',
      selection: 'src/selection.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: true,
    // Externalize all @bobsled-inc/* workspace deps. Required because
    // @bobsled-inc/models uses `import.meta.url` to locate its marts/ data
    // directory at runtime — bundling it inline into dist/index.js would
    // break that resolution. Externalizing keeps the runtime require path
    // intact so pnpm's workspace symlinks resolve correctly during dev.
    // The package root and documented subpaths resolve to the compiler/API
    // bundles rather than dist/index.js, so library consumers do not execute
    // the CLI-only dependency path.
    external: [/^@bobsled-inc\//],
    onSuccess: 'node scripts/write-expressions-manifest.mjs',
  },
]);
