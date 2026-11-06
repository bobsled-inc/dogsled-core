import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginAgenticCursor } from '../../src/agentic/begin-cursor.js';
import { validateAgenticReceipt } from '../../src/agentic/checkpoint-receipt.js';
import { AgenticCursorConflict, type AgenticCursorStore } from '../../src/agentic/cursor.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import {
  AgenticStateError,
  type AgenticCheckpointCommand,
  type AgenticRunKey,
  type AgenticRunSnapshot,
  type AgenticStateSession,
  type AgenticStateStore,
} from '../../src/agentic/state.js';
import {
  AGENTIC_DEFAULT_STORE_LIMITS,
  resolveAgenticStoreLimits,
} from '../../src/agentic/store-limits.js';
import { runFixture } from '../unit/agentic/state-fixture.js';
import {
  currentCommand,
  mapScenario,
  planScenario,
  type AgenticStoreScenario,
} from './agentic-store-scenario.js';

export interface StoreHandle {
  store: AgenticStateStore;
  /** A fresh view of the same storage, as another process would open it. */
  reopen(): AgenticStateStore;
  cleanup(): Promise<void>;
}

/** How to reach one store. Everything else in the suite uses only the public interfaces. */
export interface StoreAdapter {
  name: string;
  open(): Promise<StoreHandle>;
  /** Ends a live owner's lease, as a stalled process would. Lease stores only. */
  expireLease?(handle: StoreHandle, key: AgenticRunKey): Promise<void>;
  /** Command line of a worker that owns `key` and is killed. Stores that recover a dead
   * owner without a lease. */
  crashWorker?(handle: StoreHandle): string[];
  /** Damages a stored run in a way a read must report. */
  damage?(handle: StoreHandle, key: AgenticRunKey): Promise<void>;
  /** Puts a view in place of the table that holds stored rows. Row stores only. */
  replaceRowsTable?(handle: StoreHandle, key: AgenticRunKey): Promise<void>;
  /** Adds a computed column to the table that holds stored rows. Row stores only. */
  addComputedColumn?(handle: StoreHandle, key: AgenticRunKey): Promise<void>;
  /** Stores a macro that replaces the built-in `lower`. Engines where one can. */
  plantLowerMacro?(handle: StoreHandle, key: AgenticRunKey): Promise<void>;
  /** A view of this storage whose runs expire after `retentionMs`. */
  withRetention?(handle: StoreHandle, retentionMs: number): AgenticStateStore;
  /** Stores that accept any valid snapshot in `create`, not only a new one. */
  createAcceptsStartedRun?: boolean;
  /** Per test and per hook, for an engine where a statement takes a noticeable time. */
  timeoutMs?: number;
}

const stateError = (code: string) => expect.objectContaining({ code });
const cursorKey = { scope: 'lake', model: 'pair_assessments', target: 'main.pair_assessments' };
const signature = 'a'.repeat(64);
const otherSignature = 'b'.repeat(64);

/** Sends commands exactly as the coordinator does, including its receipt validation. */
async function apply(
  session: AgenticStateSession,
  before: AgenticRunSnapshot,
  recorded: AgenticCheckpointCommand
): Promise<AgenticRunSnapshot> {
  const command = currentCommand(before, recorded);
  const requestedAt = Date.now();
  return validateAgenticReceipt(await session.checkpoint(command), before, command, requestedAt);
}

async function replay(
  session: AgenticStateSession,
  scenario: AgenticStoreScenario,
  count = scenario.commands.length
): Promise<AgenticRunSnapshot> {
  let snapshot = validateAgenticReceipt(await session.create(scenario.initial), scenario.initial);
  for (const command of scenario.commands.slice(0, count)) {
    snapshot = await apply(session, snapshot, command);
  }
  return snapshot;
}

export function describeAgenticStoreConformance(adapter: StoreAdapter): void {
  const timeout = adapter.timeoutMs ?? 120_000;
  describe(`${adapter.name} store conformance`, { timeout }, () => {
    let map: AgenticStoreScenario;
    let plan: AgenticStoreScenario;
    const handles: StoreHandle[] = [];
    const sessions: AgenticStateSession[] = [];
    const open = async (): Promise<StoreHandle> => {
      const handle = await adapter.open();
      handles.push(handle);
      return handle;
    };
    const acquire = async (store: AgenticStateStore, key: AgenticRunKey) => {
      const session = await store.acquire(key);
      sessions.push(session);
      return session;
    };
    beforeAll(async () => {
      map = await mapScenario();
      plan = await planScenario();
    });
    afterEach(async () => {
      for (const session of sessions.splice(0)) await session.release().catch(() => {});
      for (const handle of handles.splice(0)) await handle.cleanup();
    }, timeout);

    describe('create and read', () => {
      it('reads null for a run that does not exist', async () => {
        const session = await acquire((await open()).store, map.key);
        expect(await session.read()).toBeNull();
      });

      it('creates a run once', async () => {
        const session = await acquire((await open()).store, map.key);
        const created = await session.create(map.initial);
        expect(created).toEqual(map.initial);
        expect(await session.read()).toEqual(map.initial);
        await expect(session.create(map.initial)).rejects.toEqual(stateError('conflict'));
      });

      it('rejects a checkpoint for a run that does not exist', async () => {
        const session = await acquire((await open()).store, map.key);
        await expect(session.checkpoint(map.commands[0]!)).rejects.toEqual(stateError('missing'));
      });

      it.skipIf(adapter.createAcceptsStartedRun)('creates only a new preparing run', async () => {
        const handle = await open();
        const first = await acquire(handle.store, map.key);
        const started = await replay(first, map, 2);
        await first.release();
        const other = { ...map.key, scope: 'elsewhere' };
        const second = await acquire(handle.reopen(), other);
        await expect(second.create({ ...started, key: other })).rejects.toBeInstanceOf(
          AgenticStateError
        );
        expect(await second.read()).toBeNull();
      });

      it('gives every caller its own copy', async () => {
        const session = await acquire((await open()).store, map.key);
        const created = await session.create(map.initial);
        created.charged = 99;
        const read = await session.read();
        expect(read).toEqual(map.initial);
        read!.charged = 99;
        expect(await session.read()).toEqual(map.initial);
      });

      it('declares the limits it holds', async () => {
        const { store } = await open();
        expect(resolveAgenticStoreLimits(store)).toEqual(AGENTIC_DEFAULT_STORE_LIMITS);
      });
    });

    describe('commands', () => {
      it('applies a map run exactly as the transition does', async () => {
        const session = await acquire((await open()).store, map.key);
        const final = await replay(session, map);
        expect(await session.read()).toEqual(final);
        expect(final.status).toBe('execution_complete');
      });

      it('applies a published incremental plan exactly as the transition does', async () => {
        const session = await acquire((await open()).store, plan.key);
        const final = await replay(session, plan);
        expect(await session.read()).toEqual(final);
        expect(final.cursors_committed).toBe(true);
        expect(new Set(plan.commands.map((command) => command.type))).toEqual(
          new Set([
            'seal_work',
            'append_step',
            'start_attempt',
            'finish_attempt',
            'complete',
            'prepare_publication',
            'confirm_publication',
            'confirm_cursors',
          ])
        );
      });

      it('saves an execution window', async () => {
        const session = await acquire((await open()).store, plan.key);
        const before = await session.create(plan.initial);
        const after = await apply(session, before, {
          type: 'begin_execution',
          operation_id: 'window',
          expected_revision: 0,
          started_at: new Date().toISOString(),
          token_limit: null,
          cost_limit_microusd: null,
        });
        expect(after.execution_windows).toHaveLength(1);
        expect(await session.read()).toEqual(after);
      });

      it('retires a run permanently', async () => {
        const handle = await open();
        const session = await acquire(handle.store, plan.key);
        const before = await replay(session, plan, 2);
        const retired = await apply(session, before, {
          type: 'supersede',
          operation_id: 'supersede',
          expected_revision: before.revision,
        });
        expect(retired.superseded).toBe(true);
        await expect(session.checkpoint(plan.commands[2]!)).rejects.toEqual(
          stateError('superseded')
        );
        await session.release();
        const reopened = await acquire(handle.reopen(), plan.key);
        expect(await reopened.read()).toEqual(retired);
      });
    });

    describe('duplicates and conflicts', () => {
      it('gives each repeated command one effect', async () => {
        const session = await acquire((await open()).store, plan.key);
        let snapshot = await session.create(plan.initial);
        for (const recorded of plan.commands) {
          const command = currentCommand(snapshot, recorded);
          snapshot = await apply(session, snapshot, command);
          expect(await session.checkpoint(command)).toEqual(snapshot);
        }
        expect(await session.read()).toEqual(snapshot);
      });

      it('rejects an operation ID reused with a different payload', async () => {
        const session = await acquire((await open()).store, map.key);
        const index = map.commands.findIndex((command) => command.type === 'finish_attempt');
        const snapshot = await replay(session, map, index + 1);
        const finish = map.commands[index] as Extract<
          AgenticCheckpointCommand,
          { type: 'finish_attempt' }
        >;
        await expect(session.checkpoint({ ...finish, charge: finish.charge + 1 })).rejects.toEqual(
          stateError('conflict')
        );
        expect(await session.read()).toEqual(snapshot);
      });

      it('rejects a stale expected revision without changing state', async () => {
        const session = await acquire((await open()).store, map.key);
        const index = map.commands.findIndex((command) => command.type === 'start_attempt');
        const snapshot = await replay(session, map, index);
        await expect(
          session.checkpoint({ ...map.commands[index]!, expected_revision: 0 })
        ).rejects.toEqual(stateError('conflict'));
        expect(await session.read()).toEqual(snapshot);
      });
    });

    describe('lost replies', () => {
      it('shows an applied command to a reader whose reply was lost', async () => {
        const session = await acquire((await open()).store, plan.key);
        const before = await replay(session, plan, 3);
        const command = plan.commands[3]!;
        const requestedAt = Date.now();
        await session.checkpoint(command); // The reply is discarded, as if the network failed.
        const observed = await session.read();
        const after = validateAgenticReceipt(observed, before, command, requestedAt);
        expect(await session.checkpoint(command)).toEqual(after);
      });

      it('applies a repeated command once across sessions', async () => {
        const handle = await open();
        const session = await acquire(handle.store, plan.key);
        await replay(session, plan, 4);
        const after = await session.read();
        await session.release();
        const next = await acquire(handle.reopen(), plan.key);
        expect(await next.checkpoint(plan.commands[3]!)).toEqual(after);
        expect(await next.read()).toEqual(after);
      });
    });

    describe('ownership', () => {
      it('allows one owner at a time and a new owner after release', async () => {
        const handle = await open();
        const first = await acquire(handle.store, map.key);
        await expect(handle.reopen().acquire(map.key)).rejects.toThrow();
        await first.release();
        await expect(first.read()).rejects.toThrow();
        await expect(first.checkpoint(map.commands[0]!)).rejects.toThrow();
        const second = await acquire(handle.reopen(), map.key);
        expect(await second.read()).toBeNull();
      });

      it('keeps runs independent', async () => {
        const { store } = await open();
        const first = await acquire(store, map.key);
        const second = await acquire(store, plan.key);
        await first.create(map.initial);
        await second.create(plan.initial);
        expect(await first.read()).toEqual(map.initial);
        expect(await second.read()).toEqual(plan.initial);
      });

      it('releases more than once without error', async () => {
        const session = await acquire((await open()).store, map.key);
        await session.release();
        await session.release();
      });

      it('gives concurrent acquires of a new run exactly one owner', async () => {
        const handle = await open();
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () => handle.reopen().acquire(map.key))
        );
        const owners = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        );
        sessions.push(...owners);
        expect(owners).toHaveLength(1);
        expect(await owners[0]!.create(map.initial)).toEqual(map.initial);
      });
    });

    describe.skipIf(!adapter.expireLease)('lease loss and fencing', () => {
      it('fences an expired owner after takeover', async () => {
        const handle = await open();
        const stale = await acquire(handle.store, plan.key);
        const before = await replay(stale, plan, 3);
        await adapter.expireLease!(handle, plan.key);
        const owner = await acquire(handle.reopen(), plan.key);
        expect(await owner.read()).toEqual(before);
        await expect(stale.checkpoint(plan.commands[3]!)).rejects.toEqual(stateError('lease_lost'));
        await expect(stale.read()).rejects.toEqual(stateError('lease_lost'));
        expect(stale.ownershipLost?.aborted).toBe(true);
        expect(await owner.read()).toEqual(before);
        const after = await apply(owner, before, plan.commands[3]!);
        await stale.release();
        expect(await owner.read()).toEqual(after);
      });

      it('rejects a repeated command from an expired owner', async () => {
        const handle = await open();
        const stale = await acquire(handle.store, plan.key);
        await replay(stale, plan, 3);
        await adapter.expireLease!(handle, plan.key);
        await expect(stale.checkpoint(plan.commands[2]!)).rejects.toEqual(stateError('lease_lost'));
      });

      it('gives concurrent takeovers of an expired lease exactly one owner', async () => {
        const handle = await open();
        const stale = await acquire(handle.store, plan.key);
        const before = await replay(stale, plan, 3);
        await adapter.expireLease!(handle, plan.key);
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () => handle.reopen().acquire(plan.key))
        );
        const owners = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        );
        sessions.push(...owners);
        expect(owners).toHaveLength(1);
        expect(await owners[0]!.read()).toEqual(before);
        await expect(stale.read()).rejects.toEqual(stateError('lease_lost'));
      });

      it('lets a later owner continue after a lost lease', async () => {
        const handle = await open();
        const stale = await acquire(handle.store, plan.key);
        const before = await replay(stale, plan, 3);
        await adapter.expireLease!(handle, plan.key);
        const owner = await acquire(handle.reopen(), plan.key);
        let snapshot = before;
        for (const command of plan.commands.slice(3)) {
          snapshot = await apply(owner, snapshot, command);
        }
        expect(snapshot.cursors_committed).toBe(true);
      });
    });

    describe('resume', () => {
      it('rebuilds the same state after every command', async () => {
        const handle = await open();
        let session = await acquire(handle.store, plan.key);
        let snapshot = await session.create(plan.initial);
        for (const command of plan.commands) {
          snapshot = await apply(session, snapshot, command);
          await session.release();
          session = await acquire(handle.reopen(), plan.key);
          expect(await session.read()).toEqual(snapshot);
        }
      });

      it('continues a run through the coordinator without repeating saved work', async () => {
        const handle = await open();
        const fixture = runFixture(3);
        const directory = mkdtempSync(join(tmpdir(), 'store-conformance-'));
        try {
          const calls = vi.spyOn(fixture.host, 'executeAgent');
          const options = { projectDirectory: directory, stateStore: handle.store };
          await executeAgenticRun(fixture.host, fixture.context(), {
            ...options,
            run: { id: 'resume', mode: 'start' },
          });
          expect(calls).toHaveBeenCalledTimes(3);
          calls.mockClear();
          const resumed = await executeAgenticRun(fixture.host, fixture.context(), {
            ...options,
            stateStore: handle.reopen(),
            run: { id: 'resume', mode: 'resume' },
          });
          expect(resumed.reusedCompletion).toBe(true);
          expect(calls).not.toHaveBeenCalled();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    });

    describe.skipIf(!adapter.crashWorker)('takeover after process death', () => {
      it('recovers exactly what was acknowledged before SIGKILL', async () => {
        const handle = await open();
        const directory = mkdtempSync(join(tmpdir(), 'store-crash-'));
        try {
          const scenarioFile = join(directory, 'scenario.json');
          const ackFile = join(directory, 'ack.json');
          writeFileSync(scenarioFile, JSON.stringify(plan));
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', ...adapter.crashWorker!(handle), scenarioFile, ackFile, '6'],
            { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 }
          );
          const [, signal] = await once(child, 'exit');
          expect(signal).toBe('SIGKILL');
          const acknowledged = JSON.parse(readFileSync(ackFile, 'utf8')) as AgenticRunSnapshot;
          expect(acknowledged.revision).toBe(6);
          const session = await acquire(handle.reopen(), plan.key);
          expect(await session.read()).toEqual(acknowledged);
          let snapshot = acknowledged;
          for (const command of plan.commands.slice(6)) {
            snapshot = await apply(session, snapshot, command);
          }
          expect(snapshot.cursors_committed).toBe(true);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    });

    describe('cursors', () => {
      const cursors = (store: AgenticStateStore): AgenticCursorStore => store.cursors!;

      it('reserves a new key, advances it after commit and starts the next run from it', async () => {
        const handle = await open();
        const store = cursors(handle.store);
        expect(await store.begin(cursorKey, signature, 'run-1')).toEqual({});
        expect(await store.begin(cursorKey, signature, 'run-1')).toEqual({});
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        const reopened = cursors(handle.reopen());
        expect(await reopened.begin(cursorKey, signature, 'run-2')).toEqual({ pairs: 5 });
      });

      it('repeats a lost commit without moving progress', async () => {
        const store = cursors((await open()).store);
        await store.begin(cursorKey, signature, 'run-1');
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        expect(await store.begin(cursorKey, signature, 'run-2')).toEqual({ pairs: 5 });
      });

      it('reports the owner of a busy key', async () => {
        const store = cursors((await open()).store);
        await store.begin(cursorKey, signature, 'run-1');
        const failure = await store.begin(cursorKey, signature, 'run-2').catch((error) => error);
        expect(failure).toBeInstanceOf(AgenticCursorConflict);
        expect(failure.activeRun).toBe('run-1');
      });

      it('rejects a changed signature and a commit by a run that does not own the key', async () => {
        const store = cursors((await open()).store);
        await store.begin(cursorKey, signature, 'run-1');
        await expect(store.begin(cursorKey, otherSignature, 'run-1')).rejects.toEqual(
          stateError('conflict')
        );
        await expect(
          store.commit(cursorKey, signature, 'run-2', { pairs: 5 })
        ).rejects.toBeInstanceOf(AgenticStateError);
      });

      it('never moves progress backwards', async () => {
        const store = cursors((await open()).store);
        await store.begin(cursorKey, signature, 'run-1');
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        await store.begin(cursorKey, signature, 'run-2');
        await expect(store.commit(cursorKey, signature, 'run-2', { pairs: 4 })).rejects.toEqual(
          stateError('conflict')
        );
      });

      it('swaps the owner on supersede, keeps progress and tolerates a lost reply', async () => {
        const store = cursors((await open()).store);
        await store.begin(cursorKey, signature, 'run-1');
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        await store.begin(cursorKey, signature, 'run-2');
        expect(await store.supersede!(cursorKey, signature, 'run-2', 'run-3')).toEqual({
          pairs: 5,
        });
        expect(await store.supersede!(cursorKey, signature, 'run-2', 'run-3')).toEqual({
          pairs: 5,
        });
        await expect(store.supersede!(cursorKey, signature, 'run-9', 'run-4')).rejects.toEqual(
          stateError('conflict')
        );
      });

      it('gives concurrent begins on a new key exactly one owner', async () => {
        const handle = await open();
        const runs = Array.from({ length: 6 }, (_, index) => `run-${index}`);
        const results = await Promise.allSettled(
          runs.map((run) => cursors(handle.reopen()).begin(cursorKey, signature, run))
        );
        const winners = runs.filter((_, index) => results[index]!.status === 'fulfilled');
        expect(winners).toHaveLength(1);
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(AgenticCursorConflict);
            expect(result.reason.activeRun).toBe(winners[0]);
          }
        }
      });

      it('lets different keys advance at the same time', async () => {
        const handle = await open();
        const keys = Array.from({ length: 6 }, (_, index) => ({
          ...cursorKey,
          target: `main.target_${index}`,
        }));
        await Promise.all(
          keys.map(async (key, index) => {
            const store = cursors(handle.reopen());
            await store.begin(key, signature, `run-${index}`);
            await store.commit(key, signature, `run-${index}`, { pairs: index + 1 });
          })
        );
        for (const [index, key] of keys.entries()) {
          expect(await cursors(handle.reopen()).begin(key, signature, 'next')).toEqual({
            pairs: index + 1,
          });
        }
      });

      it('keeps keys independent', async () => {
        const store = cursors((await open()).store);
        const other = { ...cursorKey, target: 'main.other' };
        await store.begin(cursorKey, signature, 'run-1');
        await store.begin(other, signature, 'run-2');
        await store.commit(cursorKey, signature, 'run-1', { pairs: 5 });
        await store.commit(other, signature, 'run-2', { pairs: 9 });
        expect(await store.begin(cursorKey, signature, 'run-3')).toEqual({ pairs: 5 });
        expect(await store.begin(other, signature, 'run-4')).toEqual({ pairs: 9 });
      });

      it('takes over an unpublished run through the coordinator path', async () => {
        const handle = await open();
        const stale = await acquire(handle.store, plan.key);
        const before = await replay(stale, plan, 2);
        await stale.release();
        const store = cursors(handle.store);
        const key = { scope: plan.key.scope, model: plan.key.model, target: cursorKey.target };
        await store.begin(key, signature, 'earlier');
        await store.commit(key, signature, 'earlier', { pairs: 1 });
        await store.begin(key, signature, plan.key.id);
        const take = (allowTakeover: boolean) =>
          beginAgenticCursor(store, handle.reopen(), key, signature, 'fresh', allowTakeover);
        await expect(take(false)).rejects.toBeInstanceOf(AgenticCursorConflict);
        expect(await take(true)).toEqual({ pairs: 1 });
        const retired = await acquire(handle.reopen(), plan.key);
        expect((await retired.read())?.superseded).toBe(true);
        expect((await retired.read())?.revision).toBe(before.revision + 1);
      });

      it('refuses takeover while the previous run is still owned', async () => {
        const handle = await open();
        const live = await acquire(handle.store, plan.key);
        await replay(live, plan, 2);
        const store = cursors(handle.store);
        const key = { scope: plan.key.scope, model: plan.key.model, target: cursorKey.target };
        await store.begin(key, signature, plan.key.id);
        await expect(
          beginAgenticCursor(store, handle.reopen(), key, signature, 'fresh', true)
        ).rejects.toEqual(stateError('takeover_blocked'));
      });
    });

    describe('retention', () => {
      it('keeps a released run with the store defaults when other runs open', async () => {
        const handle = await open();
        const first = await acquire(handle.store, map.key);
        const final = await replay(first, map);
        await first.release();
        const other = await acquire(handle.reopen(), { ...map.key, id: 'other' });
        await other.release();
        const second = await acquire(handle.reopen(), map.key);
        expect(await second.read()).toEqual(final);
      });

      const expiring = adapter.withRetention;
      it.skipIf(!expiring)('removes a finished run after the retention window', async () => {
        const handle = await open();
        const store = expiring!(handle, 1);
        const first = await acquire(store, map.key);
        await replay(first, map);
        await first.release();
        await delay(20);
        const other = await acquire(expiring!(handle, 1), { ...map.key, id: 'other' });
        await other.release();
        const later = await acquire(expiring!(handle, 1), map.key);
        expect(await later.read()).toBeNull();
      });

      it.skipIf(!expiring)('keeps a run inside its retention window', async () => {
        const handle = await open();
        // Longer than a 32-bit millisecond count, like the default.
        const days = 90 * 86_400_000;
        const first = await acquire(expiring!(handle, days), map.key);
        const final = await replay(first, map);
        await first.release();
        const other = await acquire(expiring!(handle, days), { ...map.key, id: 'other' });
        await other.release();
        const later = await acquire(expiring!(handle, days), map.key);
        expect(await later.read()).toEqual(final);
      });

      it.skipIf(!expiring)('never removes a run that is still owned', async () => {
        const handle = await open();
        const owner = await acquire(expiring!(handle, 1), map.key);
        const final = await replay(owner, map);
        await delay(20);
        const other = await acquire(expiring!(handle, 1), { ...map.key, id: 'other' });
        await other.release();
        expect(await owner.read()).toEqual(final);
      });

      it.skipIf(!expiring)('keeps runs that are owed recovery', async () => {
        const handle = await open();
        const prepared = plan.commands.findIndex(
          (command) => command.type === 'prepare_publication'
        );
        const first = await acquire(expiring!(handle, 1), plan.key);
        const final = await replay(first, plan, prepared + 1);
        await first.release();
        await delay(20);
        const other = await acquire(expiring!(handle, 1), { ...plan.key, id: 'other' });
        await other.release();
        const later = await acquire(expiring!(handle, 1), plan.key);
        expect(await later.read()).toEqual(final);
      });

      it.skipIf(!expiring)('expires a preparing run and lets takeover replace it', async () => {
        const handle = await open();
        const store = expiring!(handle, 1);
        const first = await acquire(store, plan.key);
        await first.create(plan.initial);
        const key = { scope: plan.key.scope, model: plan.key.model, target: cursorKey.target };
        await store.cursors!.begin(key, signature, 'earlier');
        await store.cursors!.commit(key, signature, 'earlier', { pairs: 1 });
        await store.cursors!.begin(key, signature, plan.key.id);
        await first.release();
        await delay(20);
        const other = await acquire(expiring!(handle, 1), { ...plan.key, id: 'other' });
        await other.release();
        const fresh = expiring!(handle, 1);
        expect(
          await beginAgenticCursor(fresh.cursors!, fresh, key, signature, 'fresh', true)
        ).toEqual({ pairs: 1 });
        const gone = await acquire(fresh, plan.key);
        expect(await gone.read()).toBeNull();
      });

      it.skipIf(!expiring)('keeps an unfinished run that holds a cursor reservation', async () => {
        const handle = await open();
        const first = await acquire(expiring!(handle, 1), plan.key);
        const final = await replay(first, plan, 3);
        await first.release();
        await delay(20);
        const other = await acquire(expiring!(handle, 1), { ...plan.key, id: 'other' });
        await other.release();
        const later = await acquire(expiring!(handle, 1), plan.key);
        expect(await later.read()).toEqual(final);
      });
    });

    describe.skipIf(!adapter.damage)('damaged storage', () => {
      it('reports damage instead of treating the run as missing', async () => {
        const handle = await open();
        const first = await acquire(handle.store, plan.key);
        await replay(first, plan, 3);
        await first.release();
        await adapter.damage!(handle, plan.key);
        const second = await acquire(handle.reopen(), plan.key);
        await expect(second.read()).rejects.toEqual(stateError('corrupt'));
      });

      for (const [name, tamper] of [
        ['a view in place of a table', adapter.replaceRowsTable],
        ['a computed column', adapter.addComputedColumn],
        ['a stored macro that replaces a built-in', adapter.plantLowerMacro],
      ] as const) {
        it.skipIf(!tamper)(`reports ${name}`, async () => {
          const handle = await open();
          const first = await acquire(handle.store, plan.key);
          await replay(first, plan, 3);
          await first.release();
          await tamper!(handle, plan.key);
          await expect(acquire(handle.reopen(), plan.key)).rejects.toEqual(stateError('corrupt'));
        });
      }
    });
  });
}
