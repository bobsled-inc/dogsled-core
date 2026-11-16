import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgenticCursorKey, CursorRecord } from '../../../src/agentic/cursor.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { checkpointIntegrations } from '../../support/checkpoint-transport.js';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), wait: vi.fn() }));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: mocks.resolve,
}));
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: mocks.wait,
}));

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  mocks.resolve.mockReset();
  mocks.wait.mockReset().mockImplementation(async (milliseconds: number) => {
    clock += milliseconds;
  });
});
afterEach(() => vi.restoreAllMocks());

const integration = checkpointIntegrations.find((value) => value.source_type === 'snowflake')!;
const signature = 'a'.repeat(64);
const key = (name: string): AgenticCursorKey => ({
  scope: 'project',
  model: name,
  target: `test.${name}`,
});
const table = '"TEST"."INTERNAL"."__BOBSLED_CURSORS"';
const literal = (value: string) =>
  value.replace(/''|\\(.)/gs, (match, escaped: string) => {
    if (match === "''") return "'";
    const escapes: Record<string, string> = {
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
    };
    assert.ok(Object.hasOwn(escapes, escaped));
    return escapes[escaped]!;
  });

class CursorTransport {
  token = 'initial';
  records = new Map<string, string[]>();
  attempts = new Map<string, number>();
  barriers = new Map<number, { count: number; wait: Promise<void>; release: () => void }>();
  cohort = 0;
  opened = 0;
  closed = 0;
  startedAt: number[] = [];
  committed = 0;
  rolledBack = 0;
  alwaysStale = false;
  elapsedPerTransaction = 0;
  lastError: Error | undefined;

  async readGuard(attempt: number) {
    const token = this.token;
    if (this.cohort) {
      let barrier = this.barriers.get(attempt);
      if (!barrier) {
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        barrier = { count: 0, wait, release };
        this.barriers.set(attempt, barrier);
      }
      barrier.count += 1;
      if (barrier.count === this.cohort - attempt) barrier.release();
      await barrier.wait;
    }
    return [{ token }];
  }

  runner(name: string) {
    this.opened += 1;
    this.startedAt.push(clock);
    const attempt = this.attempts.get(name) ?? 0;
    this.attempts.set(name, attempt + 1);
    return {
      supportsBindings: true,
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql === `SELECT "TOKEN" FROM ${table} WHERE "KEY" = '' LIMIT 2`) {
          return this.readGuard(attempt);
        }
        // Looking for a cursor table of an earlier Core generation: the current one exists.
        if (sql.includes('information_schema.TABLES')) return [{ table_name: params?.[1] }];
        assert.equal(sql, `SELECT "RECORD" FROM ${table} WHERE "KEY" = ? LIMIT 2`);
        assert.equal(params?.length, 1);
        return (this.records.get(String(params![0])) ?? [])
          .slice(0, 2)
          .map((record) => ({ record }));
      },
      run: async (sql: string) => {
        if (sql === 'CREATE SCHEMA IF NOT EXISTS "TEST"."INTERNAL"') return {};
        if (sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} AS SELECT `)) return {};
        this.transaction(sql);
        return {};
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }

  transaction(sql: string) {
    clock += this.elapsedPerTransaction;
    const outer = sql.match(/^EXECUTE IMMEDIATE '([\s\S]*)'$/);
    assert.ok(outer);
    const lines = literal(outer[1]!).split('\n');
    assert.equal(lines.length, 11);
    assert.equal(lines[7], 'IF (matches <> 1) THEN RAISE stale; END IF;');
    assert.equal(lines[9], 'EXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;');
    const update = lines[3]!.match(
      /SET "TOKEN" = '([^']+)' WHERE "KEY" = '' AND "TOKEN" = '([^']+)' AND \((.*)\);$/
    );
    const deletion = lines[4]!.match(/WHERE "KEY" = '([a-f0-9]{64})';$/);
    const insertion = lines[5]!.match(/VALUES \('([a-f0-9]{64})', '((?:[^']|'')*)', '([^']+)'\);$/);
    assert.ok(update && deletion && insertion);
    const [, token, previousToken, expected] = update;
    const hash = deletion[1]!;
    assert.equal(insertion[1], hash);
    assert.equal(insertion[3], token);
    const previous = this.records.get(hash) ?? [];
    const prior = expected!.match(/AND "RECORD" = '((?:[^']|'')*)'\) = 1$/);
    const expectedRecord = prior
      ? previous.filter((row) => row === literal(prior[1]!)).length === 1
      : previous.length === 0;
    if (!prior) {
      assert.equal(expected, `(SELECT COUNT(*) FROM ${table} WHERE "KEY" = '${hash}') = 0`);
    }
    assert.equal(
      lines[6],
      `matches := (SELECT CASE WHEN ((SELECT COUNT(*) FROM ${table} WHERE "KEY" = '' AND "TOKEN" = '${token}') = 1 AND (SELECT COUNT(*) FROM ${table} WHERE "KEY" = '${hash}') = 1) THEN 1 ELSE 0 END);`
    );
    if (this.alwaysStale) this.token = `other-${this.rolledBack}`;
    const candidateToken = this.token === previousToken && expectedRecord ? token! : this.token;
    const candidate = new Map([...this.records].map(([k, rows]) => [k, [...rows]]));
    candidate.delete(hash);
    candidate.set(hash, [literal(insertion[2]!)]);
    if (candidateToken !== token || candidate.get(hash)!.length !== 1) {
      this.rolledBack += 1;
      this.lastError = Object.assign(new Error('Stale publication owner or target version'), {
        code: -20001,
        sqlState: 'P0001',
      });
      throw this.lastError;
    }
    this.token = candidateToken;
    this.records = candidate;
    this.committed += 1;
  }

  use() {
    mocks.resolve.mockImplementation(async (_integration, options: { queryTag: string }) =>
      this.runner(options.queryTag)
    );
    return this;
  }

  store(name: string, signal?: AbortSignal) {
    return createWarehouseAgenticCursorStore(integration, {
      schema: 'internal',
      queryTag: name,
      ...(signal ? { signal } : {}),
    });
  }
}

class OperationClock {
  events: { at: number; resolve: () => void }[] = [];

  wait(milliseconds: number) {
    return new Promise<void>((resolve) => {
      this.events.push({ at: clock + milliseconds, resolve });
    });
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    void result.catch(() => undefined);
    for (let turn = 0; !settled && turn < 10_000; turn++) {
      for (let microtask = 0; microtask < 100; microtask++) await Promise.resolve();
      if (settled) break;
      assert.ok(this.events.length);
      clock = Math.min(...this.events.map((event) => event.at));
      const ready = this.events.filter((event) => event.at === clock);
      this.events = this.events.filter((event) => event.at !== clock);
      for (const event of ready) event.resolve();
    }
    expect(settled).toBe(true);
    expect(this.events).toHaveLength(0);
    return result;
  }
}

class LatentCursorTransport extends CursorTransport {
  constructor(readonly operationClock: OperationClock) {
    super();
  }

  override runner(name: string) {
    const runner = super.runner(name);
    return {
      ...runner,
      query: async (sql: string, params?: readonly unknown[]) => {
        await this.operationClock.wait(1_200);
        return runner.query(sql, params);
      },
      run: async (sql: string) => {
        await this.operationClock.wait(sql.startsWith('EXECUTE IMMEDIATE') ? 5_200 : 1_200);
        return runner.run(sql);
      },
    };
  }
}

describe('warehouse cursor contention', () => {
  it.each([16, 32])(
    'makes bounded progress for %i writers with simulated warehouse latency',
    async (count) => {
      const operationClock = new OperationClock();
      const transport = new LatentCursorTransport(operationClock).use();
      let random = 7;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        return random / 2 ** 32;
      });
      mocks.wait.mockImplementation((milliseconds: number) => operationClock.wait(milliseconds));
      const names = Array.from({ length: count }, (_, index) => `model_${index}`);
      const outcomes = await operationClock.run(
        Promise.allSettled(
          names.map((name) => transport.store(name).begin(key(name), signature, name))
        )
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(count);
      expect(transport.records.size).toBe(count);
      expect(transport.committed).toBe(count);
      expect(transport.rolledBack).toBe((count * (count - 1)) / 2);
      expect(transport.closed).toBe(transport.opened);
      expect(Math.max(...transport.attempts.values())).toBe(count);
      expect(transport.startedAt.every((time) => time < 360_000)).toBe(true);
      expect(clock).toBeGreaterThan(120_000);
      expect(clock).toBeLessThan(360_000);
      for (const rows of transport.records.values()) {
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!) as CursorRecord).toMatchObject({ signature, values: {} });
      }
    }
  );

  it.each([9, 16])(
    'retries %i independent writers without losing rows or progress',
    async (count) => {
      const transport = new CursorTransport().use();
      const names = Array.from({ length: count }, (_, index) => `model_${index}`);
      transport.cohort = count;
      await Promise.all(
        names.map((name) => transport.store(name).begin(key(name), signature, name))
      );
      expect(transport.records.size).toBe(count);
      expect(transport.rolledBack).toBe((count * (count - 1)) / 2);
      expect(transport.closed).toBe(transport.opened);
      transport.attempts.clear();
      transport.barriers.clear();
      await Promise.all(
        names.map((name) => transport.store(name).commit(key(name), signature, name, { pairs: 42 }))
      );
      expect(transport.committed).toBe(2 * count);
      expect(transport.rolledBack).toBe(count * (count - 1));
      expect(transport.closed).toBe(transport.opened);
      for (const rows of transport.records.values()) {
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!) as CursorRecord).toMatchObject({
          values: { pairs: 42 },
          activeRun: null,
        });
      }
      expect(mocks.wait).toHaveBeenCalled();
      expect(mocks.wait.mock.calls.every(([ms]) => ms > 0 && ms <= 1_000)).toBe(true);
    }
  );

  it('exhausts its attempt budget with the original failure and no partial writes', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(transport.lastError);
    expect(transport.opened).toBe(32);
    expect(transport.closed).toBe(32);
    expect(transport.rolledBack).toBe(32);
    expect(transport.records.size).toBe(0);
    expect(mocks.wait).toHaveBeenCalledTimes(31);
    expect(mocks.wait.mock.calls.slice(0, 5).map(([ms]) => ms)).toEqual([25, 50, 100, 200, 400]);
    expect(mocks.wait.mock.calls.slice(5).every(([ms]) => ms === 500)).toBe(true);
  });

  it('counts provider operation time and starts no sleep after elapsed exhaustion', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    transport.elapsedPerTransaction = 60_000;
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(transport.lastError);
    expect(transport.opened).toBe(6);
    expect(transport.closed).toBe(6);
    expect(transport.startedAt.every((time) => time < 360_000)).toBe(true);
    expect(mocks.wait).toHaveBeenCalledTimes(5);
  });

  it('keeps a slow first failure in its bounded allowance when later attempts are fast', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    const transaction = transport.transaction.bind(transport);
    transport.transaction = (sql) => {
      transport.elapsedPerTransaction = transport.opened === 1 ? 10_000 : 0;
      transaction(sql);
    };
    mocks.wait.mockImplementation(async (milliseconds: number) => {
      clock = clock < 120_000 ? 120_000 : clock + milliseconds;
    });
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(transport.lastError);
    expect(transport.opened).toBe(32);
    expect(transport.closed).toBe(32);
    expect(clock).toBeGreaterThan(120_000);
    expect(clock).toBeLessThan(351_000);
  });

  it('starts no retry after an in-flight operation exceeds the absolute ceiling', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    transport.elapsedPerTransaction = 400_000;
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(transport.lastError);
    expect(transport.opened).toBe(1);
    expect(transport.closed).toBe(1);
    expect(clock).toBe(400_000);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('starts no attempt when the delay consumes the remaining elapsed budget', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    mocks.wait.mockImplementation(async () => {
      clock = 120_000;
    });
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(transport.lastError);
    expect(transport.opened).toBe(1);
    expect(transport.closed).toBe(1);
  });

  it('cancels during the real abortable delay without opening another runner', async () => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    const controller = new AbortController();
    const real =
      await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.wait.mockImplementation((ms, value, options) => {
      started();
      return real.setTimeout(ms, value, options);
    });
    const result = transport
      .store('model', controller.signal)
      .begin(key('model'), signature, 'run');
    const rejected = expect(result).rejects.toMatchObject({ cancelled: true });
    await waiting;
    controller.abort();
    await rejected;
    expect(transport.opened).toBe(1);
    expect(transport.closed).toBe(1);
  });

  it('does not open a runner after cancellation', async () => {
    const transport = new CursorTransport().use();
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.store('model', controller.signal).begin(key('model'), signature, 'run')
    ).rejects.toMatchObject({ cancelled: true });
    expect(transport.opened).toBe(0);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('retains same-key and signature failures without another transaction', async () => {
    const transport = new CursorTransport().use();
    const store = transport.store('model');
    await store.begin(key('model'), signature, 'first');
    await expect(store.begin(key('model'), signature, 'other')).rejects.toMatchObject({
      code: 'cursor_busy',
    });
    await expect(store.begin(key('model'), 'b'.repeat(64), 'first')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(transport.committed).toBe(1);
    expect(transport.closed).toBe(transport.opened);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('does not extend setup errors that imitate the native assertion', async () => {
    const failure = new Error('Stale publication owner or target version');
    const close = vi.fn();
    mocks.resolve.mockResolvedValue({
      supportsBindings: true,
      query: vi.fn(),
      run: vi.fn().mockRejectedValue(failure),
      close,
    });
    await expect(
      createWarehouseAgenticCursorStore(integration, { schema: 'internal' }).begin(
        key('model'),
        signature,
        'run'
      )
    ).rejects.toBe(failure);
    expect(mocks.resolve).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('does not extend provider failures echoing assertion SQL inside the transaction', async () => {
    const transport = new CursorTransport().use();
    let failure: Error;
    transport.transaction = (sql) => {
      failure = new Error(`Permission denied executing ${sql}`);
      throw failure;
    };
    const result = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(result).toBe(failure!);
    expect(transport.opened).toBe(4);
    expect(transport.closed).toBe(4);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it.each(['permission denied', 'transport unavailable'])(
    'preserves four legacy attempts for %s',
    async (message) => {
      const failure = new Error(message);
      const close = vi.fn();
      mocks.resolve.mockResolvedValue({
        supportsBindings: true,
        query: vi.fn(),
        run: vi.fn().mockRejectedValue(failure),
        close,
      });
      await expect(
        createWarehouseAgenticCursorStore(integration, { schema: 'internal' }).begin(
          key('model'),
          signature,
          'run'
        )
      ).rejects.toBe(failure);
      expect(mocks.resolve).toHaveBeenCalledTimes(4);
      expect(close).toHaveBeenCalledTimes(4);
      expect(mocks.wait).not.toHaveBeenCalled();
    }
  );

  it.each([1, 3])('preserves the legacy budget after %i contention failures', async (count) => {
    const transport = new CursorTransport().use();
    transport.alwaysStale = true;
    const transaction = transport.transaction.bind(transport);
    const providerFailure = new Error('Transport unavailable');
    let transactions = 0;
    transport.transaction = (sql) => {
      if (transactions++ >= count) throw providerFailure;
      transaction(sql);
    };
    const failure = await transport
      .store('model')
      .begin(key('model'), signature, 'run')
      .catch((error: unknown) => error);
    expect(failure).toBe(providerFailure);
    expect(transport.opened).toBe(4);
    expect(transport.closed).toBe(4);
    expect(transport.records.size).toBe(0);
    expect(mocks.wait).toHaveBeenCalledTimes(count);
  });

  it('does not retry corrupt sentinel state', async () => {
    const close = vi.fn();
    mocks.resolve.mockResolvedValue({
      supportsBindings: true,
      query: vi.fn().mockResolvedValue([]),
      run: vi.fn(),
      close,
    });
    await expect(
      createWarehouseAgenticCursorStore(integration, { schema: 'internal' }).begin(
        key('model'),
        signature,
        'run'
      )
    ).rejects.toMatchObject({ code: 'corrupt' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('does not extend a runner-close failure after a stale assertion', async () => {
    const transport = new CursorTransport();
    transport.alwaysStale = true;
    const failure = new Error('Runner close failed');
    const close = vi.fn().mockRejectedValue(failure);
    mocks.resolve.mockImplementation(async () => ({ ...transport.runner('model'), close }));
    await expect(transport.store('model').begin(key('model'), signature, 'run')).rejects.toBe(
      failure
    );
    expect(transport.opened).toBe(4);
    expect(close).toHaveBeenCalledTimes(4);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it.each(checkpointIntegrations)(
    'recognizes native $source_type assertions through a bounded cause chain',
    async (source) => {
      let failures = 0;
      const close = vi.fn();
      const messages = {
        postgres: 'Stale publication owner or target version',
        snowflake:
          "Uncaught exception of type 'STALE' on line 8 at position 23 : Stale publication owner or target version",
        bigquery: 'Query error: Stale publication owner or target version at [5:1]',
        databricks:
          '[USER_RAISED_EXCEPTION] Stale publication owner or target version SQLSTATE: 45000',
      };
      const cause = new Error(messages[source.source_type as keyof typeof messages]);
      const wrapped = new Error('Native transaction failed', { cause });
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
        if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'old' }];
        if (sql.includes('AS valid')) return [{ valid: ++failures > 5 ? 1 : 0 }];
        return [];
      });
      const run = vi.fn(async (sql: string) => {
        if (source.source_type !== 'postgres' && sql.includes('UPDATE') && failures++ < 5) {
          throw wrapped;
        }
      });
      mocks.resolve.mockResolvedValue({ supportsBindings: true, query, run, close });
      await expect(
        createWarehouseAgenticCursorStore(source, { schema: 'internal' }).begin(
          key('model'),
          signature,
          'run'
        )
      ).resolves.toEqual({});
      expect(close).toHaveBeenCalledTimes(6);
      expect(mocks.wait).toHaveBeenCalledTimes(5);
    }
  );

  it('does not loop through cyclic unrelated causes', async () => {
    const failure = new Error('Other transaction failure');
    Object.defineProperty(failure, 'cause', { value: failure });
    const transport = new CursorTransport().use();
    transport.transaction = () => {
      throw failure;
    };
    await expect(transport.store('model').begin(key('model'), signature, 'run')).rejects.toBe(
      failure
    );
    expect(transport.opened).toBe(4);
    expect(transport.closed).toBe(4);
    expect(mocks.wait).not.toHaveBeenCalled();
  });

  it('bounds native assertion cause inspection', async () => {
    let failure = new Error('Stale publication owner or target version');
    for (let depth = 0; depth < 8; depth += 1) {
      failure = new Error('Wrapped failure', { cause: failure });
    }
    const transport = new CursorTransport().use();
    transport.transaction = () => {
      throw failure;
    };
    await expect(transport.store('model').begin(key('model'), signature, 'run')).rejects.toBe(
      failure
    );
    expect(transport.opened).toBe(4);
    expect(transport.closed).toBe(4);
    expect(mocks.wait).not.toHaveBeenCalled();
  });
});
