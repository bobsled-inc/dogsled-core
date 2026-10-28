import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bobsled-inc/protocol': path.join(repoRoot, 'packages/protocol/src/index.ts'),
    },
  },
  test: {
    include: ['tests/security/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
