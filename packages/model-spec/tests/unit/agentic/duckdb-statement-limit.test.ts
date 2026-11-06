import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuckDbIntegration, SqlRunnerModule } from '@bobsled-inc/connections';
import { createDuckDbCheckpointStore } from '../../../src/agentic/duckdb-state.js';
import { duckDbRowDialect } from '../../../src/agentic/row-state-dialect.js';
import type { AgenticRunKey } from '../../../src/agentic/state.js';
import { mapScenario } from '../../support/agentic-store-scenario.js';

const open = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  buildDuckDbRunner: open,
}));

/** Answers like an empty database, until the next header update, which never returns. */
function stuckRunner(key: AgenticRunKey): { runner: SqlRunnerModule; stick: () => void } {
  let stuck = false;
  const runner: SqlRunnerModule = {
    supportsBindings: true,
    run: async () => ({}),
    query: async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      if (sql.includes('current_database')) return [{ catalog: 'state' }] as unknown as T[];
      if (sql.startsWith('UPDATE')) {
        if (stuck) await new Promise(() => {});
        return [{ changed: 1 }] as unknown as T[];
      }
      if (sql.startsWith('SELECT "layout"')) {
        const { scope, model, id } = key;
        const header = { layout: 1, revision: -1, head: '', token: 't', summary: '' };
        return [{ ...header, scope, model, run_id: id }] as unknown as T[];
      }
      return [];
    },
    close: async () => {},
  };
  return { runner, stick: () => (stuck = true) };
}

describe('DuckDB checkpoint statement limit', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops a session whose statement never returns, as a warehouse session does', async () => {
    const scenario = await mapScenario();
    const directory = mkdtempSync(join(tmpdir(), 'duckdb-limit-'));
    directories.push(directory);
    const { runner, stick } = stuckRunner(scenario.key);
    open.mockResolvedValue(runner);
    vi.spyOn(duckDbRowDialect, 'hasBaseTables').mockResolvedValue(true);
    const integration: DuckDbIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'state',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'file', path: join(directory, 'state.duckdb'), read_only: false },
    };
    const store = createDuckDbCheckpointStore(integration, { schema: 'state', leaseMs: 12_000 });
    const session = await store.acquire(scenario.key);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stick();
    const settled = session.create(scenario.initial).catch((error: unknown) => error);
    // Half the 12 second lease, plus one twelfth of it.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await settled).toMatchObject({
      code: 'lease_lost',
      reason: 'statement_timeout',
      retryAfterMs: 12_000,
    });
    expect(session.ownershipLost?.aborted).toBe(true);
  });
});
