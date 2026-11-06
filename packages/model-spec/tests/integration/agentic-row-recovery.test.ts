import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildDuckDbRunner, isDuckDbAvailable } from '@bobsled-inc/connections';
import { validateAgenticReceipt } from '../../src/agentic/checkpoint-receipt.js';
import { duckDbOperationBackend, duckDbStateFile } from '../../src/agentic/duckdb-state.js';
import type { AgenticRowDb } from '../../src/agentic/row-state-dialect.js';
import { duckDbRowDialect } from '../../src/agentic/row-state-dialect.js';
import { openAgenticRowSession } from '../../src/agentic/row-state.js';
import type { AgenticRowBackend } from '../../src/agentic/row-state-tables.js';
import {
  AgenticStateError,
  type AgenticCheckpointCommand,
  type AgenticRunSnapshot,
} from '../../src/agentic/state.js';
import { AGENTIC_DEFAULT_STORE_LIMITS } from '../../src/agentic/store-limits.js';
import type { StatementTimeoutHandling } from '../../src/agentic/warehouse-statement-limit.js';
import {
  currentCommand,
  mapScenario,
  planScenario,
  type AgenticStoreScenario,
} from '../support/agentic-store-scenario.js';

const schema = 'recovery';
type Fault = (
  sql: string,
  params: Parameters<AgenticRowDb['query']>[1]
) => 'lose_before' | 'lose_after' | undefined;

/** A real DuckDB file behind a connection that can lose a statement or its reply. */
interface Faults {
  next?: Fault;
  /** Runs just before a statement, on the same connection. */
  before?: (sql: string, db: AgenticRowDb) => Promise<void>;
  handling?: StatementTimeoutHandling;
  statements: string[];
}

function faultyBackend(file: string, faults: Faults): AgenticRowBackend {
  const backend = duckDbOperationBackend(file, schema);
  const statements = (db: AgenticRowDb): AgenticRowDb => ({
    run: (sql) => {
      faults.statements.push(sql);
      return db.run(sql);
    },
    query: async (sql, params) => {
      faults.statements.push(sql);
      await faults.before?.(sql, db);
      const fault = faults.next?.(sql, params);
      if (fault === 'lose_before') throw new Error('Synthetic failure before the statement');
      const rows = await db.query(sql, params);
      if (fault === 'lose_after') throw new Error('Synthetic lost reply');
      return rows;
    },
  });
  return {
    ...backend,
    async connect(handling) {
      faults.handling = handling;
      const connection = await backend.connect(handling);
      return {
        ...connection,
        use: (operation, options) => connection.use((db) => operation(statements(db)), options),
      };
    },
  };
}
const once = (pattern: RegExp, fault: 'lose_before' | 'lose_after'): Fault => {
  let done = false;
  return (sql) => {
    if (done || !pattern.test(sql)) return undefined;
    done = true;
    return fault;
  };
};
const headerUpdate = /^UPDATE .*__dogsled_agentic_runs.* SET "revision"/;
const rowInsert = /^INSERT INTO .*__dogsled_agentic_rows/;

describe.skipIf(!(await isDuckDbAvailable()))('recovery between the two statements', () => {
  let map: AgenticStoreScenario;
  let plan: AgenticStoreScenario;
  const directories: string[] = [];
  const faults: Faults = { statements: [] };
  const file = () => join(directories.at(-1)!, 'state.duckdb');
  beforeAll(async () => {
    map = await mapScenario();
    plan = await planScenario();
  });
  afterEach(() => {
    delete faults.next;
    delete faults.before;
    faults.statements = [];
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'row-recovery-'));
    directories.push(directory);
    const file = join(directory, 'state.duckdb');
    const backend = faultyBackend(file, faults);
    const open = (key: AgenticStoreScenario['key'], options: { retentionMs?: number } = {}) =>
      openAgenticRowSession(backend, key, {
        ownership: { mode: 'lease', leaseMs: 10_000 },
        limits: AGENTIC_DEFAULT_STORE_LIMITS,
        ...options,
      });
    const sql = async (statement: string) => {
      const runner = await buildDuckDbRunner(duckDbStateFile(file));
      try {
        return await runner.query!(statement);
      } finally {
        await runner.close?.();
      }
    };
    const expire = () => sql(`UPDATE ${schema}.__dogsled_agentic_runs SET lease_expires = 0`);
    const rows = async () =>
      Number(
        (await sql(`SELECT count(*) AS n FROM ${schema}.__dogsled_agentic_rows`))[0]!.n as bigint
      );
    return { open, sql, expire, rows };
  }
  async function replay(
    session: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['open']>>,
    scenario: AgenticStoreScenario,
    count: number
  ): Promise<AgenticRunSnapshot> {
    let snapshot = await session.create(scenario.initial);
    for (const recorded of scenario.commands.slice(0, count)) {
      snapshot = await session.checkpoint(currentCommand(snapshot, recorded));
    }
    return snapshot;
  }

  it('keeps the previous state when a crash follows the row insert', async () => {
    const { open, expire } = await fixture();
    const first = await open(plan.key);
    const before = await replay(first, plan, 2);
    const next = plan.commands[2]!;
    faults.next = once(headerUpdate, 'lose_before');
    await expect(first.checkpoint(next)).rejects.toThrow('Synthetic');
    expect(await first.read()).toEqual(before);
    await expire();
    const second = await open(plan.key);
    expect(await second.read()).toEqual(before);
    const after = await second.checkpoint(next);
    expect(validateAgenticReceipt(after, before, next)).toEqual(after);
    await second.release();
    await first.release();
  });

  it('shows a committed command when only the header reply was lost', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    const before = await replay(session, plan, 2);
    const next = plan.commands[2]!;
    const requestedAt = Date.now();
    faults.next = once(headerUpdate, 'lose_after');
    await expect(session.checkpoint(next)).rejects.toThrow('Synthetic lost reply');
    const after = validateAgenticReceipt(await session.read(), before, next, requestedAt);
    expect(after.revision).toBe(before.revision + 1);
    expect(await session.checkpoint(next)).toEqual(after);
    await session.release();
  });

  it('continues from durable state when a new command follows a lost reply', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    await replay(session, plan, 2);
    faults.next = once(headerUpdate, 'lose_after');
    await expect(session.checkpoint(plan.commands[2]!)).rejects.toThrow('Synthetic lost reply');
    const after = await session.checkpoint(plan.commands[3]!);
    expect(after.revision).toBe(4);
    expect(await session.read()).toEqual(after);
    await session.release();
  });

  it('survives a lost reply to the row insert', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    const before = await replay(session, plan, 2);
    faults.next = once(rowInsert, 'lose_after');
    await expect(session.checkpoint(plan.commands[2]!)).rejects.toThrow('Synthetic lost reply');
    expect(await session.read()).toEqual(before);
    const after = await session.checkpoint(plan.commands[2]!);
    expect(after.revision).toBe(before.revision + 1);
    expect(await session.read()).toEqual(after);
    await session.release();
  });

  it('keeps rows whose header update lands after the recovery read', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    expect(await session.read()).toBeNull();
    await session.create(plan.initial);
    const seal = plan.commands[0]!;
    // The reply is lost while the statement is still running on the server.
    let delayed: { sql: string; params: Parameters<AgenticRowDb['query']>[1] } | undefined;
    faults.next = (statement, params) => {
      if (delayed || !headerUpdate.test(statement)) return undefined;
      delayed = { sql: statement, params };
      return 'lose_before';
    };
    await expect(session.checkpoint(seal)).rejects.toThrow('Synthetic');
    expect(await session.read()).toEqual(plan.initial);
    const runner = await buildDuckDbRunner(duckDbStateFile(file()));
    try {
      await runner.query!(delayed!.sql, delayed!.params);
    } finally {
      await runner.close?.();
    }
    expect((await session.read())?.status).toBe('running');
    await session.release();
  });

  it('uses the new payload when a deterministic operation is retried with different data', async () => {
    const { open, expire } = await fixture();
    const first = await open(plan.key);
    await first.create(plan.initial);
    const seal = plan.commands[0] as Extract<AgenticCheckpointCommand, { type: 'seal_work' }>;
    faults.next = once(headerUpdate, 'lose_before');
    await expect(first.checkpoint(seal)).rejects.toThrow('Synthetic');
    await expire();
    // Preparation runs again and sees changed input. The operation ID is the same.
    const reprepared = structuredClone(seal);
    const input = Object.values(reprepared.plan_inputs!)[0]!;
    input.rows = input.rows.slice(0, 2);
    const second = await open(plan.key);
    const sealed = await second.checkpoint(reprepared);
    expect(Object.values(sealed.plan_inputs!)[0]!.rows).toHaveLength(2);
    await second.release();
    const third = await open(plan.key);
    expect(await third.read()).toEqual(sealed);
    await third.release();
    await first.release();
  });

  it('never lets an orphan with the same revision shadow the committed row', async () => {
    const { open, expire } = await fixture();
    const first = await open(map.key);
    const index = map.commands.findIndex((command) => command.type === 'start_attempt');
    const before = await replay(first, map, index);
    const start = map.commands[index] as Extract<
      AgenticCheckpointCommand,
      { type: 'start_attempt' }
    >;
    faults.next = once(headerUpdate, 'lose_before');
    await expect(first.checkpoint(start)).rejects.toThrow('Synthetic');
    await expire();
    const second = await open(map.key);
    expect(await second.read()).toEqual(before);
    // A different attempt takes the same revision while the first one's row may survive.
    const other = {
      ...start,
      attempt_id: 'other-attempt',
      operation_id: 'start_attempt:other-attempt',
    };
    const after = await second.checkpoint(other);
    expect(after.work[start.work]!.attempts.map((attempt) => attempt.id)).toEqual([
      'other-attempt',
    ]);
    await second.release();
    const third = await open(map.key);
    expect(await third.read()).toEqual(after);
    await third.release();
    await first.release();
  });

  it('removes orphans when a new owner first loads the run', async () => {
    const { open, expire, rows } = await fixture();
    const first = await open(plan.key);
    await replay(first, plan, 2);
    const count = await rows();
    faults.next = once(headerUpdate, 'lose_before');
    await expect(first.checkpoint(plan.commands[2]!)).rejects.toThrow('Synthetic');
    expect(await rows()).toBe(count + 1);
    await expire();
    const second = await open(plan.key);
    await second.read();
    expect(await rows()).toBe(count);
    await second.release();
    await first.release();
  });

  it('leaves a zombie that wrote rows unable to commit them', async () => {
    const { open, expire } = await fixture();
    const zombie = await open(plan.key);
    const before = await replay(zombie, plan, 2);
    await expire();
    const owner = await open(plan.key);
    const committed = await owner.checkpoint(plan.commands[2]!);
    // The zombie reaches its row insert after the takeover and is stopped at the header.
    await expect(zombie.checkpoint(plan.commands[2]!)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(await owner.read()).toEqual(committed);
    expect(committed.revision).toBe(before.revision + 1);
    await zombie.release();
    await owner.release();
  });

  it('commits nothing when a stale session sends a new revision', async () => {
    const { open, sql } = await fixture();
    const session = await open(plan.key);
    await replay(session, plan, 2);
    // Another writer moved the header without this session seeing it.
    await sql(`UPDATE ${schema}.__dogsled_agentic_runs SET token = 'elsewhere'`);
    await expect(session.checkpoint(plan.commands[2]!)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(session.ownershipLost?.aborted).toBe(true);
    await session.release();
  });

  it('creates its tables once, however often it acquires', async () => {
    const { open } = await fixture();
    const created = () => faults.statements.filter((sql) => /^CREATE /.test(sql)).length;
    const first = await open(map.key);
    const once = created();
    expect(once).toBeGreaterThan(0);
    await first.release();
    const second = await open(map.key);
    await second.release();
    expect(created()).toBe(once);
  });

  it('dates a new header from the store clock alone', async () => {
    const { open, sql } = await fixture();
    const session = await open(map.key);
    const [row] = await sql(
      `SELECT retain_until - CAST(epoch(now()) * 1000 AS BIGINT) AS remaining FROM ${schema}.__dogsled_agentic_runs`
    );
    const days = Number(row!.remaining as bigint) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    await session.release();
  });

  it('leaves a run alone when a resume claims it just before the purge does', async () => {
    const { open, sql } = await fixture();
    const elsewhere = { ...map.key, scope: 'elsewhere' };
    const second = { ...map, key: elsewhere, initial: { ...map.initial, key: elsewhere } };
    for (const scenario of [map, second]) {
      const session = await open(scenario.key);
      await replay(session, scenario, 2);
      await session.release();
    }
    await sql(`UPDATE ${schema}.__dogsled_agentic_runs SET retain_until = 0`);
    const rowsOf = async (scope: string) => {
      const [row] = await sql(
        `SELECT count(*) AS n FROM ${schema}.__dogsled_agentic_rows WHERE run_hash IN (SELECT run_hash FROM ${schema}.__dogsled_agentic_runs WHERE scope = '${scope}')`
      );
      return Number(row!.n as bigint);
    };
    const before = await rowsOf(map.key.scope);
    expect(before).toBeGreaterThan(0);
    // The purge has seen both runs as expired. A resume wins one before the purge's claim lands.
    faults.before = async (statement, db) => {
      if (!/^UPDATE .*__dogsled_agentic_runs.* SET "lease_owner"/.test(statement)) return;
      delete faults.before;
      await db.run(
        `UPDATE ${schema}.__dogsled_agentic_runs SET lease_owner = 'resume', lease_expires = CAST(epoch(now()) * 1000 AS BIGINT) + 60000 WHERE scope = '${map.key.scope}'`
      );
    };
    const other = await open({ ...map.key, id: 'other', scope: 'third' });
    await other.release();
    expect(faults.before).toBeUndefined();
    expect(await rowsOf(map.key.scope)).toBe(before);
    const headers = await sql(
      `SELECT scope, lease_owner FROM ${schema}.__dogsled_agentic_runs ORDER BY scope`
    );
    // The resumed run stays, the other expired run is gone, and the new run has its header.
    expect(headers).toEqual([
      { scope: map.key.scope, lease_owner: 'resume' },
      { scope: 'third', lease_owner: '' },
    ]);
  });

  it('finishes a purge that stopped partway', async () => {
    const { open, sql, expire } = await fixture();
    const first = await open(map.key, { retentionMs: 1 });
    await replay(first, map, 2);
    await first.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    faults.next = once(/^DELETE FROM .*__dogsled_agentic_runs/, 'lose_before');
    await expect(open({ ...map.key, id: 'other' })).rejects.toThrow('Synthetic');
    // The rows are gone and the header is still there, under the purge's own lease.
    await expire();
    const other = await open({ ...map.key, id: 'other' });
    await other.release();
    const headers = await sql(`SELECT run_id FROM ${schema}.__dogsled_agentic_runs`);
    expect(headers.map((row) => row.run_id)).toEqual(['other']);
  });

  it('reports a statement timeout as the reason the session stopped', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    await replay(session, plan, 2);
    expect(faults.handling?.retryAfterMs).toBe(10_000);
    const timeout = new AgenticStateError('lease_lost', { reason: 'statement_timeout' });
    faults.handling?.onTimeout?.(timeout);
    expect(session.ownershipLost?.aborted).toBe(true);
    expect((session.ownershipLost?.reason as Error).cause).toBe(timeout);
    await expect(session.read()).rejects.toBe(timeout);
    await expect(session.checkpoint(plan.commands[2]!)).rejects.toBe(timeout);
    await session.release();
  });

  it('reports a failed read as a storage failure, not as damage', async () => {
    const { open } = await fixture();
    const session = await open(plan.key);
    const before = await replay(session, plan, 2);
    faults.next = once(/^SELECT .* FROM .*__dogsled_agentic_rows/, 'lose_before');
    const failure = await session.read().catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'Synthetic failure before the statement' });
    expect(await session.read()).toEqual(before);
    await session.release();
  });

  it('reports a run whose head names a missing write', async () => {
    const { open, sql } = await fixture();
    const session = await open(plan.key);
    await replay(session, plan, 3);
    await sql(`DELETE FROM ${schema}.__dogsled_agentic_rows WHERE kind = 'attempt'`);
    await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
    await session.release();
  });

  it('detects edited content that is still valid JSON', async () => {
    const { open, sql } = await fixture();
    const session = await open(plan.key);
    await replay(session, plan, 2);
    await sql(
      `UPDATE ${schema}.__dogsled_agentic_rows SET data = replace(data, 'p1', 'p9') WHERE kind = 'assignment'`
    );
    await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
    await session.release();
  });

  it('detects edited input that nothing else in the snapshot repeats', async () => {
    const { open, sql } = await fixture();
    const session = await open(map.key);
    await replay(session, map, 1);
    await sql(
      `UPDATE ${schema}.__dogsled_agentic_rows SET data = replace(data, 'original-evidence', 'edited-evidence') WHERE kind = 'assignment'`
    );
    await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
    await session.release();
  });

  it('keeps the owner payload when a zombie writes the same operation after the sweep', async () => {
    const { open, expire } = await fixture();
    const zombie = await open(plan.key);
    await zombie.create(plan.initial);
    await expire();
    const owner = await open(plan.key);
    await owner.read();
    const seal = plan.commands[0] as Extract<AgenticCheckpointCommand, { type: 'seal_work' }>;
    // The zombie's row lands with the same parent, revision and operation ID as the owner's.
    await expect(zombie.checkpoint(seal)).rejects.toMatchObject({ code: 'lease_lost' });
    const reprepared = structuredClone(seal);
    const input = Object.values(reprepared.plan_inputs!)[0]!;
    input.rows = input.rows.slice(0, 2);
    const sealed = await owner.checkpoint(reprepared);
    expect(await owner.read()).toEqual(sealed);
    await owner.release();
    await zombie.release();
  });

  it('splits long values and rebuilds them unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'row-chunks-'));
    directories.push(directory);
    const base = duckDbOperationBackend(join(directory, 'state.duckdb'), schema);
    const backend = {
      ...base,
      dialect: { ...duckDbRowDialect, maxRowChars: 97, maxInsertChars: 500, maxInsertRows: 3 },
    };
    const options = {
      ownership: { mode: 'lease' as const, leaseMs: 10_000 },
      limits: AGENTIC_DEFAULT_STORE_LIMITS,
    };
    const first = await openAgenticRowSession(backend, plan.key, options);
    let snapshot = await first.create(plan.initial);
    for (const recorded of plan.commands) {
      snapshot = await first.checkpoint(currentCommand(snapshot, recorded));
    }
    await first.release();
    const second = await openAgenticRowSession(backend, plan.key, options);
    expect(await second.read()).toEqual(snapshot);
    await second.release();
  });

  it('rejects a snapshot above the limit the store declares', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'row-limit-'));
    directories.push(directory);
    const backend = duckDbOperationBackend(join(directory, 'state.duckdb'), schema);
    const session = await openAgenticRowSession(backend, plan.key, {
      ownership: { mode: 'lease', leaseMs: 10_000 },
      limits: { ...AGENTIC_DEFAULT_STORE_LIMITS, maxCheckpointBytes: 1024 },
    });
    await expect(session.create(plan.initial)).rejects.toMatchObject({
      code: 'limit',
      reason: 'snapshot_too_large',
    });
    expect(await session.read()).toBeNull();
    await session.release();
  });

  it('forwards cancellation and stops before the next statement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'row-cancel-'));
    directories.push(directory);
    const controller = new AbortController();
    const backend = duckDbOperationBackend(
      join(directory, 'state.duckdb'),
      schema,
      controller.signal
    );
    const session = await openAgenticRowSession(backend, plan.key, {
      ownership: { mode: 'lease', leaseMs: 10_000 },
      limits: AGENTIC_DEFAULT_STORE_LIMITS,
      signal: controller.signal,
    });
    await session.create(plan.initial);
    controller.abort();
    await expect(session.checkpoint(plan.commands[0]!)).rejects.toThrow();
    await session.release();
    const later = await openAgenticRowSession(
      duckDbOperationBackend(join(directory, 'state.duckdb'), schema),
      plan.key,
      { ownership: { mode: 'lease', leaseMs: 10_000 }, limits: AGENTIC_DEFAULT_STORE_LIMITS }
    );
    expect(await later.read()).toEqual(plan.initial);
    await later.release();
  });
});
