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

const leaseMs = 12_000;
const { statementMs, backstopMs } = warehouseStatementLimits(leaseMs);
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
function hangingRunner(hangs: (sql: string) => boolean) {
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
    if (state.hungAt === undefined && hangs(args[0])) {
      state.hungAt = Date.now();
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
    expect(warehouseStatementLimits()).toEqual({ statementMs: 60_000, backstopMs: 10_000 });
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
    const hung = hangingRunner((sql) => pointerUpdate.test(sql));
    const stateStore = store();
    const acquire = stateStore.acquire.bind(stateStore);
    let session: Awaited<ReturnType<typeof acquire>> | undefined;
    stateStore.acquire = async (runKey) => (session = await acquire(runKey));
    const f = fixture();
    const error = await settle(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore,
        run: { id: key.id, mode: 'start' },
      })
    );
    expect(error).toBeInstanceOf(AgenticStateError);
    expect(error).toMatchObject(timedOut);
    expect(String(error)).toContain('did not finish within');
    expect(Date.now() - hung.hungAt!).toBeGreaterThanOrEqual(deadlineMs);
    expect(Date.now() - hung.hungAt!).toBeLessThan(leaseMs);
    expect(session?.ownershipLost?.aborted).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
    // Nothing follows the hung statement: no ROLLBACK behind it and no release of the lease.
    expect(pointerUpdate.test(hung.statements.at(-1)!)).toBe(true);
    expect(hung.close).toHaveBeenCalledOnce();
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
    // The session's own lease can still be held, so no recovery session is opened.
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('treats a timeout reported by the warehouse like the client deadline', async () => {
    const hung = hangingRunner(() => false);
    const session = await store().acquire(key);
    hung.runner.query = async () => {
      await new Promise((done) => setTimeout(done, statementMs));
      throw new Error('Statement reached its timeout and was canceled');
    };
    const read = session.read();
    await expect(settle(read)).resolves.toMatchObject(timedOut);
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
    await expect(settle(acquiring)).resolves.toMatchObject(timedOut);
    const close = vi.fn(async () => {});
    connected({ run: vi.fn(), close });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails a cursor update that never returns once, without retrying', async () => {
    const hung = hangingRunner((sql) => /UPDATE/.test(sql));
    hung.runner.query = async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'previous-token' }];
      return [];
    };
    const error = await settle(cursors().begin(cursorKey, signature, 'run'));
    expect(error).toMatchObject(timedOut);
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
    expect(Date.now() - started).toBeLessThan(leaseMs);
    expect(f.host.prepare).not.toHaveBeenCalled();
  });
});
