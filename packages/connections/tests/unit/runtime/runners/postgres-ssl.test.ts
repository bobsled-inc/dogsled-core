import { describe, expect, it, vi } from 'vitest';
import { buildPostgresRunner } from '../../../../src/runtime/runners/postgres.js';

const captured = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('pg', () => ({
  types: { setTypeParser: vi.fn() },
  Client: class {
    constructor(config: unknown) {
      captured.config(config);
    }
    async connect() {}
    async end() {}
    async query() {
      return { rows: [], rowCount: 0 };
    }
  },
}));

describe('Postgres SSL configuration', () => {
  it.each(['disable', 'verify-full'] as const)(
    'honors mode %s when constructing the driver',
    async (mode) => {
      const runner = await buildPostgresRunner({
        spec_version: '1',
        type: 'integration',
        name: 'local',
        source_type: 'postgres',
        connection: { host: 'localhost', port: 5432, database: 'example', ssl: { mode } },
        auth: { type: 'password', user: 'example', password: 'synthetic' },
      });
      try {
        expect(captured.config).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ssl: mode === 'disable' ? false : { rejectUnauthorized: true },
          })
        );
      } finally {
        await runner.close?.();
      }
    }
  );
});
