import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlCancelledError, type SqlRunnerModule } from '@bobsled-inc/connections';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { AgenticStateError } from '../../../src/agentic/state-errors.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { warehouseStatementLimits } from '../../../src/agentic/warehouse-statement-limit.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
// Fake timers do not reach node:timers/promises, which the recovery wait uses.
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => done(value), ms);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        fail(new Error('Wait aborted'));
      });
    }),
}));

const leaseMs = 12_000;
const { statementMs, backstopMs, openMs } = warehouseStatementLimits(leaseMs);
const deadlineMs = statementMs + backstopMs;
const key = { scope: 'test', model: 'model', id: 'run' };
const cursorKey = { scope: 'test', model: 'model', target: 'models.pairs' };
const signature = 'a'.repeat(64);
const timedOut = { code: 'lease_lost', reason: 'statement_timeout' };
const pointerUpdate = /SET ["`]snapshot["`]/i;
const never = <T>() => new Promise<T>(() => {});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});
afterEach(() => {
  resolve.mockReset();
  vi.useRealTimers();
});

/** Records every statement and leaves the first one that `hangs` matches unanswered. */
function hangingRunner(hangs: (sql: string) => boolean, { always = false } = {}) {
  const transport = checkpointTransport();
  const run = transport.runner.run;
  const statements: string[] = [];
  const state = {
    transport,
    statements,
    hungAt: undefined as number | undefined,
    close: vi.fn(async () => {}),
    runner: transport.runner,
  };
  transport.runner.close = state.close;
  transport.runner.run = (...args) => {
    statements.push(args[0]);
    if ((always || state.hungAt === undefined) && hangs(args[0])) {
      state.hungAt ??= Date.now();
      return never();
    }
    return run(...args);
  };
  resolve.mockResolvedValue(transport.runner);
  return state;
}

/** Advances time until `promise` settles and returns its outcome. */
async function settle(promise: Promise<unknown>) {
  let outcome: { value: unknown } | undefined;
  void promise.then(
    (value) => (outcome = { value }),
    (value: unknown) => (outcome = { value })
  );
  for (let step = 0; !outcome && step < 2_000; step++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!outcome) throw new Error('The operation did not settle');
  return outcome.value;
}

function fixture() {
  const f = runFixture(1);
  f.model.limits = {};
  delete f.host.tokensPerAssignment;
  return f;
}

describe('warehouseStatementLimits', () => {
  it('defaults to a minute with a ten second backstop for the two minute lease', () => {
    expect(warehouseStatementLimits()).toEqual({
      statementMs: 60_000,
      backstopMs: 10_000,
      openMs: 300_000,
    });
  });

  it.each([10_000, 10_001, 120_000, 333_333, 600_000])(
    'reports a hung renewal before a lease of %i ms expires',
    (lease) => {
      const limits = warehouseStatementLimits(lease);
      expect(limits.statementMs % 1000).toBe(0);
      expect(limits.statementMs).toBeGreaterThan(0);
      expect(lease / 3 + limits.statementMs + limits.backstopMs).toBeLessThan(lease);
    }
  );

  it('stays in the supported lease range for a cursor store used on its own', () => {
    expect(warehouseStatementLimits(1)).toEqual(warehouseStatementLimits(10_000));
    expect(warehouseStatementLimits(9_000_000)).toEqual(warehouseStatementLimits(600_000));
  });
});

describe.each(checkpointIntegrations)('statement timeout: $source_type', (integration) => {
  const store = () =>
    createWarehouseCheckpointStore(integration, { schema: 'checkpoints', leaseMs });
  const cursors = () =>
    createWarehouseAgenticCursorStore(integration, { schema: 'checkpoints', leaseMs });

  it('sets the limit only on the sessions it opens for state and cursors', async () => {
    hangingRunner(() => false);
    const session = await store().acquire(key);
    await session.release();
    await cursors()
      .begin(cursorKey, signature, 'run')
      .catch(() => {});
    expect(resolve).toHaveBeenCalledTimes(2);
    for (const call of resolve.mock.calls) {
      expect(call[1]).toMatchObject({ statementTimeoutMs: statementMs });
    }
    resolve.mockClear();
    resolve.mockRejectedValue(new Error('No connection in this test'));
    const publisher = await createSqlAgenticPublisher(integration);
    await publisher.claim('main.pair_assessments').catch(() => {});
    expect(resolve).toHaveBeenCalled();
    for (const call of resolve.mock.calls) {
      expect(call[1] ?? {}).not.toHaveProperty('statementTimeoutMs');
    }
  });

  it('fails a pointer update that never returns at the deadline, without more writes', async () => {
    const memory = new MemoryStateStore();
    const f = fixture();
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: memory,
      run: { id: key.id, mode: 'start' },
    });
    const snapshot = [...memory.runs.values()][0]!;
    const hung = hangingRunner((sql) => pointerUpdate.test(sql));
    const session = await store().acquire(snapshot.key);
    const error = await settle(session.create(snapshot));
    expect(error).toBeInstanceOf(AgenticStateError);
    expect(error).toMatchObject({ ...timedOut, retryAfterMs: leaseMs });
    expect(String(error)).toContain('queued or running');
    expect(String(error)).toContain('lease has expired');
    expect(Date.now() - hung.hungAt!).toBeGreaterThanOrEqual(deadlineMs);
    expect(Date.now() - hung.hungAt!).toBeLessThan(leaseMs);
    expect(session.ownershipLost?.aborted).toBe(true);
    // Nothing follows the hung statement: no ROLLBACK behind it and no release of the lease.
    expect(pointerUpdate.test(hung.statements.at(-1)!)).toBe(true);
    await session.release();
    expect(pointerUpdate.test(hung.statements.at(-1)!)).toBe(true);
    expect(hung.close).toHaveBeenCalledOnce();
  });

  it('recovers in process only after a whole lease has passed', async () => {
    const hung = hangingRunner((sql) => pointerUpdate.test(sql));
    const opened: number[] = [];
    resolve.mockImplementation(async () => {
      opened.push(Date.now());
      return hung.runner;
    });
    const f = fixture();
    const result = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store(),
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(result).toMatchObject({ status: 'execution_complete' });
    expect(opened).toHaveLength(2);
    expect(opened[1]! - hung.hungAt!).toBeGreaterThanOrEqual(deadlineMs + leaseMs);
  });

  it('stops in bounded time when every attempt hangs', async () => {
    const hung = hangingRunner((sql) => pointerUpdate.test(sql), { always: true });
    const f = fixture();
    const error = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store(),
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(error).toMatchObject(timedOut);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(Date.now() - hung.hungAt!).toBeLessThan(3 * deadlineMs + 2 * leaseMs + 3 * backstopMs);
    expect(hung.statements).not.toContain('ROLLBACK');
  });

  it('reports the timeout when the lease is still held after the wait', async () => {
    const hung = hangingRunner((sql) => pointerUpdate.test(sql));
    const f = fixture();
    let refused = false;
    resolve.mockImplementation(async () => {
      if (hung.hungAt === undefined) return hung.runner;
      refused = true;
      return {
        ...hung.runner,
        // The fencing predicate matched no row, as it does while another lease is live.
        run: async (sql: string) => {
          if (/SET ["`]owner["`]/i.test(sql)) {
            throw new Error('Stale publication owner or target version');
          }
          return {};
        },
      };
    });
    const error = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store(),
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(refused).toBe(true);
    expect(error).toMatchObject(timedOut);
  });

  it('stops waiting for the lease when the run is cancelled', async () => {
    hangingRunner((sql) => pointerUpdate.test(sql));
    const controller = new AbortController();
    const f = fixture();
    const running = executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: store(),
      run: { id: key.id, mode: 'start' },
      signal: controller.signal,
    });
    const outcome = running.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(deadlineMs + backstopMs + 50);
    expect(resolve).toHaveBeenCalledOnce();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({ cancelled: true });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('frees the serial queue when a heartbeat never returns', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    const run = hung.runner.run;
    hung.runner.run = () => never();
    await vi.advanceTimersByTimeAsync(leaseMs / 3);
    const read = session.read();
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(session.ownershipLost?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.ownershipLost?.aborted).toBe(true);
    await expect(read).rejects.toMatchObject(timedOut);
    await expect(session.read()).rejects.toMatchObject(timedOut);
    hung.runner.run = run;
    await session.release();
    expect(hung.close).toHaveBeenCalledOnce();
  });

  it('fails the run with the cause while an executor call is in flight', async () => {
    const hung = hangingRunner(() => false);
    const f = fixture();
    let aborted: unknown;
    f.host.executeAgent = ({ signal }) => {
      hung.runner.run = () => never();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = signal.reason;
          reject(signal.reason as Error);
        });
      });
    };
    const error = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store(),
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(error).toMatchObject(timedOut);
    // Executors keep seeing an ordinary abort.
    expect(aborted).toMatchObject({ name: 'AbortError' });
    // The first attempt and two bounded recoveries, each of which hangs again.
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('treats a timeout reported by the warehouse like the client deadline', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    hung.runner.query = async () => {
      await new Promise((done) => setTimeout(done, statementMs));
      throw new Error('Statement reached its timeout and was canceled');
    };
    const error = (await settle(session.read())) as AgenticStateError;
    expect(error).toMatchObject(timedOut);
    // The driver's error stays available as the cause, out of the printed message.
    expect(error.cause).toMatchObject({ message: expect.stringContaining('its timeout') });
    expect(error.message).not.toContain('its timeout');
    expect(session.ownershipLost?.aborted).toBe(true);
    await session.release();
  });

  it('keeps the original error of a statement that fails before the limit', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    hung.runner.query = async () => {
      throw new Error('Permission denied');
    };
    await expect(session.read()).rejects.toThrow('Permission denied');
    expect(session.ownershipLost?.aborted).toBe(false);
    await session.release();
  });

  it('keeps cancellation distinct from a timeout', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    const query = hung.runner.query;
    hung.runner.query = async () => {
      hung.runner.query = query;
      await new Promise((done) => setTimeout(done, statementMs));
      throw new SqlCancelledError();
    };
    await expect(settle(session.read())).resolves.toMatchObject({ cancelled: true });
    expect(session.ownershipLost?.aborted).toBe(false);
    await session.release();
  });

  it('does not wait for a connection that will not close', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    hung.close.mockImplementation(never);
    const release = session.release();
    await vi.advanceTimersByTimeAsync(backstopMs);
    await expect(release).resolves.toBeUndefined();
  });

  it('bounds opening a session and closes a connection that arrives late', async () => {
    let connected!: (runner: SqlRunnerModule) => void;
    resolve.mockReturnValue(new Promise((done) => (connected = done)));
    const acquiring = store().acquire(key);
    const outcome = acquiring.catch((error: unknown) => error);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(openMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      code: 'unavailable',
      reason: 'connect_timeout',
    });
    expect(String(await outcome)).toContain('stopped or still starting');
    const close = vi.fn(async () => {});
    connected({ run: vi.fn(), close });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves retries to the run when a cursor update never returns', async () => {
    const hung = hangingRunner((sql) => /UPDATE/.test(sql));
    hung.runner.query = async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'previous-token' }];
      return [];
    };
    const error = await settle(cursors().begin(cursorKey, signature, 'run'));
    expect(error).toMatchObject(timedOut);
    // A cursor session holds no lease, so there is none to wait for.
    expect((error as AgenticStateError).retryAfterMs).toBeUndefined();
    expect(String(error)).toContain('Resume the run.');
    expect(String(error)).not.toContain('lease has expired');
    expect(Date.now() - hung.hungAt!).toBe(Math.ceil(deadlineMs / 50) * 50);
    expect(resolve).toHaveBeenCalledOnce();
    expect(hung.close).toHaveBeenCalledOnce();
    expect(/UPDATE/.test(hung.statements.at(-1)!)).toBe(true);
  });

  it('fails the run when a cursor read never returns', async () => {
    const hung = hangingRunner(() => false);
    hung.runner.query = () => never();
    const f = fixture();
    f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
    f.host.inputs = {
      undecided_pairs: [
        { name: 'pair_id', type: 'string', nullable: false },
        { name: 'updated_at', type: 'integer', nullable: false },
      ],
    };
    f.host.prepare = vi.fn(async () => [{ pair_id: 'a', updated_at: 1 }]);
    const started = Date.now();
    const error = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: new MemoryStateStore(),
        cursorStore: cursors(),
        publisher: {
          preflight: vi.fn(async () => {}),
          claim: vi.fn(async () => ({ version: 0, fence: 'owner' })),
          prepare: vi.fn(),
          inspect: vi.fn(async () => null),
          commit: vi.fn(),
          close: vi.fn(async () => {}),
        },
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(error).toMatchObject(timedOut);
    // A cursor store holds no lease, so its attempts need no wait between them.
    expect(Date.now() - started).toBeLessThan(3 * (deadlineMs + backstopMs));
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(f.host.prepare).not.toHaveBeenCalled();
  });
});
