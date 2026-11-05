import { defineConfig } from 'vitest/config';

const IN_CI = process.env['CI'] === 'true';

const hasDuckDb = await (async () => {
  try {
    await import('@duckdb/node-api');
    return true;
  } catch {
    if (IN_CI) {
      throw new Error('DuckDB is not available but CI requires it. Run pnpm run setup.');
    }
    return false;
  }
})();

const hasSqlite = await (async () => {
  try {
    const mod = await import('better-sqlite3');
    // Verify the native binary actually works, not just that the module resolves
    const Database = mod.default;
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const excludes: string[] = [];
if (!hasDuckDb) {
  excludes.push(
    'tests/unit/duckdb-writer.test.ts',
    'tests/unit/duckdb-type-contract.test.ts',
    'tests/unit/destinations/duckdb.test.ts',
    'tests/unit/destinations/bigquery-merge-replay.test.ts',
    'tests/unit/commands/check.test.ts',
    'tests/unit/commands/query.test.ts',
    'tests/unit/commands/run-replace.test.ts',
    'tests/integration/pipe.test.ts'
  );
}
if (!hasSqlite) {
  excludes.push('tests/unit/destinations/sqlite.test.ts');
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: excludes,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    testTimeout: 20_000,
  },
});
