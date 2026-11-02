import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { AgenticRunSnapshotSchema, digestAgenticState } from '../../../src/agentic/state.js';
import { runFixture } from './state-fixture.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => {
  resolve.mockReset();
  vi.useRealTimers();
});

function snapshot(size: number) {
  const f = runFixture(1);
  const first = f.model.plan.steps[0]!;
  f.model.plan.steps = Array.from({ length: Math.ceil(size / 60000) }, (_, index) => ({
    ...first,
    id: index === 0 ? 'assess' : `assess${index}`,
    instructions: 'x'.repeat(Math.min(60000, size - index * 60000)),
  }));
  const now = Date.now();
  const definition = { resolved: f.context().resolved, tokensPerAssignment: 100, maxAttempts: 3 };
  return AgenticRunSnapshotSchema.parse({
    version: 2,
    revision: 0,
    key: { scope: 'test', model: f.model.name, id: 'batch' },
    definition,
    identity: digestAgenticState(definition),
    started_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 600000).toISOString(),
    token_limit: 100000,
    max_attempts: 3,
    charged: 0,
    status: 'preparing',
    publication: 'pending',
    work: [],
  });
}

describe.each(checkpointIntegrations)('checkpoint batches: $source_type', (integration) => {
  it.each([1, 2, 7, 8, 14, 15, 21])(
    'bounds and orders payload writes (%s chunks)',
    async (expectedChunks) => {
      const transport = checkpointTransport();
      resolve.mockResolvedValue(transport.runner);
      const value = snapshot(Math.max(1, Math.floor(((expectedChunks - 0.5) * 49152 - 3500) / 2)));
      const session = await createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
      }).acquire(value.key);
      try {
        await session.create(value);
        const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
        const chunks = Math.ceil(encoded.length / 65536);
        expect(chunks).toBe(expectedChunks);
        expect(transport.inserts).toHaveLength(Math.ceil(chunks / 7));
        expect(transport.payloads.get(transport.pointer)).toEqual(
          Array.from({ length: chunks }, (_, ordinal) => ({
            ordinal,
            data: encoded.slice(ordinal * 65536, (ordinal + 1) * 65536),
          }))
        );
        for (const { sql, params } of transport.inserts) {
          expect(params.length).toBeLessThanOrEqual(21);
          expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(65536);
          expect(Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(params))).toBeLessThan(
            512 * 1024
          );
          expect(sql).not.toContain(encoded.slice(0, 80));
          expect(sql.match(integration.source_type === 'postgres' ? /\$\d+/g : /\?/g)).toHaveLength(
            params.length
          );
          if (integration.source_type === 'postgres') {
            expect(sql.match(/\$\d+/g)).toEqual(params.map((_, index) => `$${index + 1}`));
          }
        }
        expect(await session.read()).toEqual(value);
      } finally {
        await session.release();
      }
    }
  );

  it.each(['failed_response', 'cancel', 'takeover'])(
    'keeps staged rows invisible after %s',
    async (fault) => {
      const transport = checkpointTransport();
      const controller = new AbortController();
      resolve.mockResolvedValue(transport.runner);
      const value = snapshot(400000);
      const session = await createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        signal: controller.signal,
      }).acquire(value.key);
      transport.afterInsert = () => {
        if (fault === 'cancel') controller.abort();
        else if (fault === 'takeover') transport.valid = false;
        else throw new Error('Staging response lost');
      };
      try {
        await expect(session.create(value)).rejects.toThrow();
        expect(transport.pointer).toBe('');
        expect(transport.operations.pointer ?? 0).toBe(fault === 'takeover' ? 1 : 0);
        expect(transport.inserts).toHaveLength(fault === 'takeover' ? 3 : 1);
        if (fault === 'failed_response') {
          expect(await session.read()).toBeNull();
          transport.afterInsert = undefined;
          await session.create(value);
          expect(await session.read()).toEqual(value);
        }
      } finally {
        await session.release();
      }
    }
  );

  it.each([false, true])(
    'preserves runner call arity and signal forwarding (signal: %s)',
    async (withSignal) => {
      const transport = checkpointTransport();
      const query = vi.spyOn(transport.runner, 'query');
      const signal = new AbortController().signal;
      resolve.mockResolvedValue(transport.runner);
      const value = snapshot(400000);
      const session = await createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        ...(withSignal ? { signal } : {}),
      }).acquire(value.key);
      try {
        await session.create(value);
        const inserts = query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
        expect(inserts).toHaveLength(3);
        for (const call of inserts) {
          expect(call).toHaveLength(withSignal ? 3 : 2);
          if (withSignal) expect(call[2]).toEqual({ signal });
        }
      } finally {
        await session.release();
      }
    }
  );

  it('retains the previous snapshot when a later checkpoint batch fails', async () => {
    const transport = checkpointTransport();
    resolve.mockResolvedValue(transport.runner);
    const value = snapshot(400000);
    const session = await createWarehouseCheckpointStore(integration, {
      schema: 'checkpoints',
    }).acquire(value.key);
    try {
      await session.create(value);
      const pointer = transport.pointer;
      let batches = 0;
      transport.afterInsert = () => {
        if (++batches === 2) throw new Error('Failed second batch');
      };
      await expect(
        session.checkpoint({ type: 'supersede', operation_id: 'supersede', expected_revision: 0 })
      ).rejects.toThrow('second batch');
      expect(batches).toBe(2);
      expect(transport.pointer).toBe(pointer);
      expect(await session.read()).toEqual(value);
    } finally {
      await session.release();
    }
  });

  it('reconciles a lost pointer commit response by reading durable state', async () => {
    const transport = checkpointTransport();
    resolve.mockResolvedValue(transport.runner);
    const value = snapshot(400000);
    const session = await createWarehouseCheckpointStore(integration, {
      schema: 'checkpoints',
    }).acquire(value.key);
    try {
      transport.afterInsert = () => {
        transport.failCommit = true;
      };
      await expect(session.create(value)).rejects.toThrow('Lost commit response');
      expect(await session.read()).toEqual(value);
      const writes = transport.inserts.length;
      await expect(session.create(value)).rejects.toMatchObject({ code: 'conflict' });
      expect(transport.inserts).toHaveLength(writes);
    } finally {
      await session.release();
    }
  });

  it('stops before the pointer commit when cancellation arrives with the final response', async () => {
    const transport = checkpointTransport();
    const controller = new AbortController();
    resolve.mockResolvedValue(transport.runner);
    const value = snapshot(1);
    const session = await createWarehouseCheckpointStore(integration, {
      schema: 'checkpoints',
      signal: controller.signal,
    }).acquire(value.key);
    transport.afterInsert = () => controller.abort();
    try {
      await expect(session.create(value)).rejects.toThrow();
      expect(transport.pointer).toBe('');
      expect(transport.operations.pointer ?? 0).toBe(0);
    } finally {
      await session.release();
    }
  });

  it.each([
    {
      name: 'slow final batch',
      retainedMs: 0,
      stagingMs: 6000,
      responseMs: 0,
      pointerMs: 5000,
      expires: false,
    },
    {
      name: 'slow retained-size read',
      retainedMs: 8000,
      stagingMs: 3000,
      responseMs: 0,
      pointerMs: 0,
      expires: false,
    },
    {
      name: 'slow renewal response',
      retainedMs: 0,
      stagingMs: 3000,
      responseMs: 4000,
      pointerMs: 5000,
      expires: false,
    },
    {
      name: 'expired staging request',
      retainedMs: 0,
      stagingMs: 11000,
      responseMs: 0,
      pointerMs: 0,
      expires: true,
    },
    {
      // The lease is valid when acquisition returns, but already due for renewal.
      name: 'delayed acquisition response and retained-size read',
      acquireMs: 8000,
      retainedMs: 3000,
      stagingMs: 0,
      responseMs: 0,
      pointerMs: 0,
      expires: false,
    },
  ])(
    'preserves lease fencing after $name',
    async ({ acquireMs = 0, retainedMs, stagingMs, responseMs, pointerMs, expires }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const transport = checkpointTransport();
      const value = snapshot(1);
      let expiresAt = Date.now() + 10000;
      const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
      const run = transport.runner.run;
      transport.runner.run = async (...args) => {
        const sql = args[0];
        const acquisition = /SET ["`]owner["`] = '{1,2}[a-f0-9-]{36}/i.test(sql);
        const renewal = /SET ["`]expires["`]/i.test(sql);
        const publication = /SET ["`]snapshot["`]/i.test(sql);
        if (publication) advance(pointerMs);
        if ((renewal || publication) && Date.now() >= expiresAt) {
          throw new Error('Expired warehouse owner');
        }
        const result = await run(...args);
        if (acquisition) advance(acquireMs);
        if (renewal) {
          // The database starts the lease before the response reaches the caller.
          expiresAt = Date.now() + 10000;
          advance(responseMs);
        }
        return result;
      };
      const query = transport.runner.query!;
      transport.runner.query = async (...args) => {
        const result = await query(...args);
        if (/AS retained/i.test(args[0])) advance(retainedMs);
        return result;
      };
      transport.afterInsert = () => advance(stagingMs);
      resolve.mockResolvedValue(transport.runner);
      const session = await createWarehouseCheckpointStore(integration, {
        schema: 'checkpoints',
        leaseMs: 10000,
      }).acquire(value.key);
      try {
        if (expires) {
          await expect(session.create(value)).rejects.toMatchObject({ code: 'lease_lost' });
          expect(session.ownershipLost?.aborted).toBe(true);
          expect(transport.pointer).toBe('');
          expect(transport.operations.pointer ?? 0).toBe(0);
        } else {
          await session.create(value);
          expect(await session.read()).toEqual(value);
          expect(Date.now()).toBeLessThan(expiresAt);
        }
      } finally {
        await session.release();
      }
    }
  );

  it('renews inside long staging sequences before sending another batch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const transport = checkpointTransport();
    resolve.mockResolvedValue(transport.runner);
    const value = snapshot(400000);
    const session = await createWarehouseCheckpointStore(integration, {
      schema: 'checkpoints',
      leaseMs: 10000,
    }).acquire(value.key);
    const owners: number[] = [];
    transport.afterInsert = () => {
      owners.push(transport.operations.ownership!);
      vi.setSystemTime(Date.now() + 4000);
    };
    try {
      await session.create(value);
      expect(owners).toHaveLength(3);
      expect(owners[1]).toBeGreaterThan(owners[0]!);
      expect(owners[2]).toBeGreaterThan(owners[1]!);
      expect(await session.read()).toEqual(value);
    } finally {
      await session.release();
    }
  });
});
