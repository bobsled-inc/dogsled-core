import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  version: string;
};

export default defineConfig([
  {
    entry: {
      index: 'src/api/index.ts',
      cli: 'src/index.ts',
      'api/index': 'src/api/index.ts',
      'runtime/candidate-retrieval/index': 'src/runtime/candidate-retrieval/index.ts',
      'runtime/services/index': 'src/runtime/services/index.ts',
      'runtime/executor/index': 'src/runtime/executor/index.ts',
      'runtime/mention/index': 'src/runtime/mention/index.ts',
      'runtime/relationship/index': 'src/runtime/relationship/index.ts',
      'compiler/relationship/cross-entity-link': 'src/compiler/relationship/cross-entity-link.ts',
    },
    format: ['esm'],
    dts: {
      compilerOptions: {
        ignoreDeprecations: '6.0',
      },
    },
    clean: true,
    splitting: false,
    external: [/^@bobsled-inc\//],
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
