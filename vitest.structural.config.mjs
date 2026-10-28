import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/structural/**/*.test.mjs', 'tests/unit/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
