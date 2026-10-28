import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.audit.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
