import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'runtime/index': 'src/runtime/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
  },
]);
