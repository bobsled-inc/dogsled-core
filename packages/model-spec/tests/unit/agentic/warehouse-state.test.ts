import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlCancelledError, type IntegrationFile } from '@bobsled-inc/connections';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { runFixture } from './state-fixture.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => {
  resolve.mockReset();
  vi.useRealTimers();
});
const postgres: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'warehouse',
  source_type: 'postgres',
  connection: { host: 'localhost', database: 'test', port: 5432 },
  auth: { type: 'password', user: 'test', password: 'test-only' },
};

const snowflake: IntegrationFile = {
  spec_version: '1',
  type: 'integration',
  name: 'warehouse',
  source_type: 'snowflake',
  connection: { account_identifier: 'test', database: 'test', warehouse: 'test', user: 'test' },
  auth: { type: 'pat', token: 'test-only' },
};

describe.each([postgres, snowflake])(
  'warehouse checkpoint boundary: $source_type',
  (integration) => {
    it.each([false, true])('resumes through a new session (unlimited: %s)', async (unlimited) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let pointer = '';
      const payloads = new Map<string, { ordinal: number; data: string }[]>();
      const run = vi.fn(async (sql: string) => {
        // Model only the transport boundary. The real store applies and serializes commands.
        if (/SET "snapshot"/i.test(sql)) {
          pointer = sql.match(/[a-f0-9-]{36}_[a-f0-9]{64}/)![0];
        }
        return {};
      });
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (/AS "snapshot"/i.test(sql)) return [{ SNAPSHOT: pointer }];
        if (/AS retained/i.test(sql)) return [{ RETAINED: 0 }];
        if (/^INSERT INTO/.test(sql)) {
          const [id, ordinal, data] = params as [string, number, string];
          payloads.set(id, [...(payloads.get(id) ?? []), { ordinal, data }]);
          return [];
        }
        if (/ORDER BY/.test(sql)) return payloads.get(String(params![0]))!;
        return [{ valid: 1 }];
      });
      resolve.mockImplementation(async () => ({
        run,
        query,
        supportsBindings: true,
        close: vi.fn(),
      }));
      const f = runFixture(2);
      f.model.limits.timeout_seconds = 1;
      if (unlimited) {
        f.model.limits = {};
        delete f.host.tokensPerAssignment;
      }
      const execute = f.host.executeAgent;
      const calls = vi
        .spyOn(f.host, 'executeAgent')
        .mockImplementationOnce(execute)
        .mockRejectedValueOnce(new Error('worker interrupted'));
      const options = {
        projectDirectory: '/unused',
        stateStore: createWarehouseCheckpointStore(integration, { schema: 'checkpoints' }),
        run: { id: 'retry', mode: 'start' as const },
      };
      await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 2000);
      const restartedAt = Date.now();
      const result = await executeAgenticRun(f.host, f.context(), {
        ...options,
        stateStore: createWarehouseCheckpointStore(integration, { schema: 'checkpoints' }),
        run: { id: 'retry', mode: 'resume' },
      });
      expect(result.deadlineAt).toBe(unlimited ? null : new Date(restartedAt + 1000).toISOString());
      expect(result.chargedTokens).toBe(unlimited ? 4 : 104);
      const tableNames = run.mock.calls.flatMap(([sql]) =>
        [...sql.matchAll(/__dogsled_cp_[a-f0-9]{48}_[cp]/gi)].map((match) => match[0])
      );
      expect(new Set(tableNames).size).toBe(2);
      for (const name of tableNames) {
        expect(Buffer.byteLength(name, 'utf8')).toBe(63);
        expect(name).toBe(
          integration.source_type === 'snowflake' ? name.toUpperCase() : name.toLowerCase()
        );
      }
      expect(calls).toHaveBeenCalledTimes(3);
      expect(calls.mock.calls[2]![0].assignment.limits.deadline_at).toBe(result.deadlineAt);
      const persisted = JSON.parse(
        Buffer.from(
          payloads
            .get(pointer)!
            .map((row) => row.data)
            .join(''),
          'base64'
        ).toString()
      );
      expect(persisted.execution_windows).toHaveLength(1);
      expect(persisted.execution_windows[0].deadline_at).toBe(result.deadlineAt);
      expect(resolve).toHaveBeenCalledTimes(2);
      if (integration.source_type === 'snowflake') {
        expect(run.mock.calls.some(([sql]) => sql.startsWith('EXECUTE IMMEDIATE'))).toBe(true);
      }
    });

    it('fences an expired session and lets a new session acquire ownership', async () => {
      const query = vi.fn(async () => [{ valid: 1, snapshot: '' }]);
      const run = vi.fn(async () => ({}));
      const close = vi.fn(async () => {});
      resolve.mockResolvedValue({ run, query, supportsBindings: true, close });
      const store = createWarehouseCheckpointStore(integration, { schema: 'checkpoints' });
      const key = { scope: 'test', model: 'model', id: 'run' };
      const expired = await store.acquire(key);
      query.mockResolvedValueOnce([]);
      await expect(expired.read()).rejects.toMatchObject({ code: 'lease_lost' });
      expect(expired.ownershipLost?.aborted).toBe(true);
      const calls = run.mock.calls.length;
      await expired.release();
      // Cleanup must not clear the ownership of a replacement worker.
      expect(run).toHaveBeenCalledTimes(calls);
      const replacement = await store.acquire(key);
      const queries = query.mock.calls.length;
      await expect(expired.read()).rejects.toMatchObject({ code: 'lease_lost' });
      expect(query).toHaveBeenCalledTimes(queries);
      await replacement.release();
    });

    it('releases only its own token even if its lease expired during cleanup', async () => {
      const run = vi.fn(async (_sql: string) => ({}));
      resolve.mockResolvedValue({
        run,
        query: vi.fn(async () => [{ valid: 1 }]),
        supportsBindings: true,
        close: vi.fn(),
      });
      const store = createWarehouseCheckpointStore(integration, { schema: 'checkpoints' });
      const session = await store.acquire({ scope: 'test', model: 'model', id: 'cleanup' });
      run.mockClear();
      await session.release();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatch(/WHERE "owner" = '[a-f0-9-]+'$/i);
    });

    it('signals ownership loss when a heartbeat cannot renew', async () => {
      vi.useFakeTimers();
      const query = vi.fn(async () => [{ valid: 1, snapshot: '' }]);
      const run = vi.fn(async () => ({}));
      resolve.mockResolvedValue({ run, query, supportsBindings: true, close: vi.fn() });
      const store = createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        leaseMs: 30000,
      });
      const session = await store.acquire({ scope: 'test', model: 'model', id: 'run' });
      try {
        run.mockRejectedValueOnce(new Error('queued beyond lease expiry'));
        await vi.advanceTimersByTimeAsync(10000);
        expect(session.ownershipLost?.aborted).toBe(true);
        await expect(session.read()).rejects.toMatchObject({ code: 'lease_lost' });
      } finally {
        await session.release();
        vi.useRealTimers();
      }
    });

    it('preserves checkpoint cancellation through agentic execution', async () => {
      const close = vi.fn(async () => {});
      resolve.mockResolvedValue({
        run: vi.fn(async () => {
          throw new SqlCancelledError();
        }),
        query: vi.fn(),
        supportsBindings: true,
        close,
      });
      const f = runFixture(1);
      await expect(
        executeAgenticRun(f.host, f.context(), {
          projectDirectory: '/unused-checkpoint-test',
          stateStore: createWarehouseCheckpointStore(integration, { schema: 'checkpoints' }),
          run: { id: 'cancelled', mode: 'start' },
        })
      ).rejects.toMatchObject({ cancelled: true });
      expect(close).toHaveBeenCalledOnce();
    });
    it('does not open a runner for an already cancelled run', async () => {
      const controller = new AbortController();
      controller.abort();
      const store = createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        signal: controller.signal,
      });
      await expect(store.acquire({ scope: 'test', model: 'model', id: 'run' })).rejects.toThrow();
      expect(resolve).not.toHaveBeenCalled();
    });
    it('passes cancellation to warehouse calls and still closes the session', async () => {
      const controller = new AbortController();
      const close = vi.fn(async () => {});
      const run = vi.fn(async () => ({}));
      const query = vi.fn(async () => [{ valid: 1, snapshot: '' }]);
      resolve.mockResolvedValue({ run, query, supportsBindings: true, close });
      const store = createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        signal: controller.signal,
      });
      const session = await store.acquire({ scope: 'test', model: 'model', id: 'run' });
      expect(run).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
      query.mockResolvedValueOnce([{ valid: 1, snapshot: '' }]);
      await session.read();
      expect(query).toHaveBeenCalledWith(expect.any(String), undefined, {
        signal: controller.signal,
      });
      controller.abort();
      const calls = query.mock.calls.length;
      await expect(session.read()).rejects.toThrow();
      expect(query).toHaveBeenCalledTimes(calls);
      await session.release();
      expect(close).toHaveBeenCalledOnce();
    });
    it.each([0, -1, 9999, 600001, NaN, Infinity])(
      'rejects invalid leases before opening a database: %s',
      (leaseMs) => {
        expect(() =>
          createWarehouseCheckpointStore(integration, { schema: 'checkpoints', leaseMs })
        ).toThrow();
        expect(resolve).not.toHaveBeenCalled();
      }
    );
    it('rejects non-durable DuckDB memory storage without falling back to files', () => {
      expect(() =>
        createWarehouseCheckpointStore(
          {
            spec_version: '1',
            type: 'integration',
            name: 'memory',
            source_type: 'duckdb',
            auth: { type: 'memory' },
          },
          { schema: 'checkpoints' }
        )
      ).toThrow();
      expect(resolve).not.toHaveBeenCalled();
    });
    it('closes an incompatible runner when parameter bindings are unavailable', async () => {
      const close = vi.fn(async () => {});
      resolve.mockResolvedValue({ run: vi.fn(), close });
      const store = createWarehouseCheckpointStore(integration, { schema: 'checkpoints' });
      await expect(store.acquire({ scope: 'test', model: 'model', id: 'run' })).rejects.toThrow(
        'parameter bindings'
      );
      expect(close).toHaveBeenCalledOnce();
    });
    it('does not treat a failed warehouse read as a missing checkpoint', async () => {
      const close = vi.fn(async () => {});
      const query = vi.fn(async () => [{ valid: 1, snapshot: '' }]);
      resolve.mockResolvedValue({
        run: vi.fn(async () => ({})),
        query,
        supportsBindings: true,
        close,
      });
      const store = createWarehouseCheckpointStore(integration, { schema: 'checkpoints' });
      const session = await store.acquire({ scope: 'test', model: 'model', id: 'run' });
      try {
        query.mockRejectedValueOnce(new Error('Unavailable warehouse'));
        await expect(session.read()).rejects.toThrow('Unavailable warehouse');
      } finally {
        await session.release();
      }
      expect(close).toHaveBeenCalledOnce();
    });
  }
);
