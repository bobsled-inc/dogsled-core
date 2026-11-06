import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationFile, SqlRunnerModule } from '@bobsled-inc/connections';
import {
  postgresRowDialect,
  snowflakeRowDialect,
} from '../../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import type { AgenticRunKey } from '../../../src/agentic/state.js';
import { checkpointIntegrations } from '../../support/checkpoint-transport.js';
import { mapScenario } from '../../support/agentic-store-scenario.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
// These runners answer like an empty database, so the catalog would report no tables at all.
beforeEach(() => {
  vi.spyOn(postgresRowDialect, 'hasBaseTables').mockResolvedValue(true);
  vi.spyOn(snowflakeRowDialect, 'hasBaseTables').mockResolvedValue(true);
});
afterEach(() => {
  resolve.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const integration = (engine: string): IntegrationFile =>
  checkpointIntegrations.find((item) => item.source_type === engine)!;

/** Answers like an empty database. `stick` leaves the next header update unanswered. */
function runner(key: AgenticRunKey) {
  let stuck = false;
  const seen: { sql: string; options: unknown }[] = [];
  const changed = [{ changed: 1, 'number of rows updated': '1' }];
  const module: SqlRunnerModule = {
    supportsBindings: true,
    run: async (sql, options) => {
      seen.push({ sql, options });
      return {};
    },
    query: async <T extends Record<string, unknown>>(
      sql: string,
      _params?: unknown,
      options?: unknown
    ): Promise<T[]> => {
      seen.push({ sql, options });
      if (sql.startsWith('UPDATE') && stuck) await new Promise(() => {});
      if (sql.startsWith('UPDATE')) return changed as unknown as T[];
      if (/^SELECT "(layout|LAYOUT)"/.test(sql)) {
        const { scope, model, id: run_id } = key;
        const header = { layout: 1, revision: -1, head: '', token: 't', summary: '' };
        return [{ ...header, scope, model, run_id }] as unknown as T[];
      }
      return [];
    },
    close: vi.fn(async () => {}),
  };
  return { module, seen, stick: () => (stuck = true) };
}

describe.each(['postgres', 'snowflake'])('the %s row store', (engine) => {
  it('stops a session whose statement never returns', async () => {
    const scenario = await mapScenario();
    const { module, stick } = runner(scenario.key);
    resolve.mockResolvedValue(module);
    const store = createWarehouseRowStore(integration(engine), {
      schema: 'state',
      leaseMs: 12_000,
    });
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
    vi.useRealTimers();
    await session.release();
  });

  it('asks the warehouse to bound every statement on the session', async () => {
    const scenario = await mapScenario();
    resolve.mockResolvedValue(runner(scenario.key).module);
    const store = createWarehouseRowStore(integration(engine), {
      schema: 'state',
      leaseMs: 12_000,
    });
    const session = await store.acquire(scenario.key);
    await session.release();
    expect(resolve).toHaveBeenCalledWith(
      integration(engine),
      expect.objectContaining({ statementTimeoutMs: 6_000 })
    );
  });

  it('forwards cancellation, and still releases after it', async () => {
    const scenario = await mapScenario();
    const { module, seen } = runner(scenario.key);
    resolve.mockResolvedValue(module);
    const controller = new AbortController();
    const store = createWarehouseRowStore(integration(engine), {
      schema: 'state',
      leaseMs: 12_000,
      signal: controller.signal,
    });
    const session = await store.acquire(scenario.key);
    const queries = seen.filter(({ sql }) => /^(?:SELECT|UPDATE|INSERT)/.test(sql));
    expect(queries.length).toBeGreaterThan(0);
    for (const { options } of queries) expect(options).toEqual({ signal: controller.signal });
    controller.abort();
    await expect(session.read()).rejects.toThrow();
    seen.length = 0;
    await session.release();
    expect(seen.map(({ sql }) => sql.split(' ')[0])).toEqual(['UPDATE']);
    expect(seen[0]!.options).toBeUndefined();
    expect(module.close).toHaveBeenCalled();
  });

  it('closes the connection when the run cannot be claimed', async () => {
    const scenario = await mapScenario();
    const { module } = runner(scenario.key);
    resolve.mockResolvedValue({
      ...module,
      // Nothing to report from RETURNING on PostgreSQL, a count of none on Snowflake.
      query: async (sql: string) =>
        sql.startsWith('UPDATE') && engine === 'snowflake'
          ? [{ 'number of rows updated': '0' }]
          : [],
    });
    const store = createWarehouseRowStore(integration(engine), {
      schema: 'state',
      leaseMs: 12_000,
    });
    await expect(store.acquire(scenario.key)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'run_in_progress',
    });
    expect(module.close).toHaveBeenCalled();
  });
});
