import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  version: string;
};

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    define: {
      __SDK_CODEGEN_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
