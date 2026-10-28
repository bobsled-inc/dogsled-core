import { INLINED_AI_DEPENDENCY_NAMES } from '../../scripts/release/package-set.mjs';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'test-stubs': 'src/test-stubs.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    metafile: true,
    noExternal: INLINED_AI_DEPENDENCY_NAMES,
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
    },
  },
]);
