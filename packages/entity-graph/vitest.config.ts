import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // Bound worker fanout so CLI subprocess tests do not exhaust fork startup under repo-wide runs.
    maxWorkers: 4,
  },
});
