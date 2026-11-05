import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
  buildDuckDbRunner,
  isCancellationError,
  type DuckDbIntegration,
} from '@bobsled-inc/connections';
import {
  AgenticCursorConflict,
  createDefaultAgenticStateStore,
  createDuckDbAgenticPublisher,
  createDuckDbCheckpointStore,
  createLocalAgenticCursorStore,
  createLocalAgenticStateStore,
  digestAgenticState,
  executeAgenticRun,
} from '../../src/agentic/index.js';
import { beginAgenticCursor } from '../../src/agentic/begin-cursor.js';
import { readDefaultAgenticCursor } from '../../src/agentic/default-state.js';
import { duckDbPublicationCursorReader } from '../../src/agentic/duckdb-state.js';
import { currentCommand, mapScenario, planScenario } from '../support/agentic-store-scenario.js';
import { runFixture } from '../unit/agentic/state-fixture.js';

// Controls whether the optional driver appears to be installed. The driver itself stays real.
const driver = vi.hoisted(() => ({ available: true }));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  isDuckDbAvailable: async () => driver.available,
}));
const actual = await vi.importActual<typeof import('@bobsled-inc/connections')>(
  '@bobsled-inc/connections'
);
const duckdb = await actual.isDuckDbAvailable();

const key = { scope: 'lake', model: 'pair_assessments', id: 'run' };
const cursorKey = { scope: 'lake', model: 'pair_assessments', target: 'main.pair_assessments' };
const signature = 'a'.repeat(64);
const hash = digestAgenticState(key);
const projects: string[] = [];
function project(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'default-store-'));
  projects.push(directory);
  return directory;
}
const stateDirectory = (root: string) => join(root, '.dogsled/model-spec');
const runFile = (root: string, id = hash) =>
  join(stateDirectory(root), `agentic-state/run-${id}.duckdb`);
const cursorFile = (root: string) => join(stateDirectory(root), 'agentic-state/cursors.duckdb');
const fileStoreRuns = (root: string): Record<string, string> => {
  const file = join(stateDirectory(root), 'run-state.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')).agentic?.runs ?? {};
};
function start(root: string, mode: 'start' | 'resume' = 'start') {
  const f = runFixture(2);
  const calls = vi.spyOn(f.host, 'executeAgent');
  return {
    calls,
    result: executeAgenticRun(f.host, f.context(), {
      projectDirectory: root,
      run: { id: key.id, mode },
    }),
  };
}

describe.skipIf(!duckdb)('default local store', { timeout: 60_000 }, () => {
  beforeEach(() => {
    driver.available = true;
  });
  afterEach(() => {
    for (const directory of projects.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('selection', () => {
    it('keeps new runs in a DuckDB file when the driver is available', async () => {
      const root = project();
      await start(root).result;
      expect(fs.existsSync(runFile(root))).toBe(true);
      expect(fileStoreRuns(root)).toEqual({});
    });

    it('falls back to the file store without the driver', async () => {
      const root = project();
      driver.available = false;
      await start(root).result;
      expect(fs.existsSync(runFile(root))).toBe(false);
      expect(Object.keys(fileStoreRuns(root))).toEqual([hash]);
    });

    it('prefers an injected store and creates nothing locally', async () => {
      const root = project();
      const stateStore = createLocalAgenticStateStore(root);
      const f = runFixture(1);
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: root,
        stateStore,
        run: { id: key.id, mode: 'start' },
      });
      expect(fs.existsSync(join(stateDirectory(root), 'agentic-state'))).toBe(false);
    });

    it('reports cancellation as cancellation, not as a storage failure', async () => {
      const controller = new AbortController();
      controller.abort();
      const store = createDefaultAgenticStateStore(project(), { signal: controller.signal });
      const failure = await store.acquire(key).catch((error: unknown) => error);
      expect(isCancellationError(failure, controller.signal)).toBe(true);
    });

    it('still saves a paid answer while the run is being cancelled', async () => {
      const root = project();
      const f = runFixture(2);
      f.host.concurrency = 2;
      const controller = new AbortController();
      const original = f.host.executeAgent;
      const finished: string[] = [];
      f.host.executeAgent = async (request) => {
        if (request.assignment.shard_id !== '0') {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          );
          throw new Error('stopped');
        }
        const answer = await original(request);
        finished.push(request.assignment.shard_id);
        // After the answer reaches the coordinator, before it is saved.
        setImmediate(() => controller.abort());
        return answer;
      };
      await expect(
        executeAgenticRun(f.host, f.context(), {
          projectDirectory: root,
          run: { id: key.id, mode: 'start' },
          signal: controller.signal,
        })
      ).rejects.toThrow();
      expect(finished).toEqual(['0']);
      f.host.executeAgent = vi.fn(original);
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: root,
        run: { id: key.id, mode: 'resume' },
      });
      expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    });

    it('leaves nothing behind for a run that does not exist', async () => {
      const root = project();
      await expect(start(root, 'resume').result).rejects.toMatchObject({ code: 'missing' });
      expect(fs.existsSync(runFile(root))).toBe(false);
    });

    it('does not remove a later owner file when an empty session is released twice', async () => {
      const root = project();
      const scenario = await mapScenario();
      const empty = await createDefaultAgenticStateStore(root).acquire(scenario.key);
      await empty.read();
      await empty.release();
      const owner = await createDefaultAgenticStateStore(root).acquire(scenario.key);
      await owner.create(scenario.initial);
      await empty.release();
      expect(fs.existsSync(runFile(root, digestAgenticState(scenario.key)))).toBe(true);
      await owner.release();
    });

    it('releases the run lock after every path', async () => {
      const root = project();
      await start(root).result;
      await expect(start(root, 'resume').result).resolves.toBeDefined();
      expect(fs.readdirSync(stateDirectory(root)).filter((n) => n.endsWith('.lock'))).toEqual([]);
    });
  });

  describe('installing and removing the driver', () => {
    it('resumes a file store run after the driver is installed', async () => {
      const root = project();
      driver.available = false;
      await start(root).result;
      driver.available = true;
      const resumed = start(root, 'resume');
      expect((await resumed.result).reusedCompletion).toBe(true);
      expect(resumed.calls).not.toHaveBeenCalled();
      expect(fs.existsSync(runFile(root))).toBe(false);
    });

    it('stops with a clear error when a DuckDB run loses its driver, and resumes after', async () => {
      const root = project();
      await start(root).result;
      driver.available = false;
      for (const mode of ['resume', 'start'] as const) {
        const attempt = start(root, mode);
        await expect(attempt.result).rejects.toMatchObject({
          code: 'unavailable',
          reason: 'duckdb_required',
        });
        expect(attempt.calls).not.toHaveBeenCalled();
      }
      expect(fileStoreRuns(root)).toEqual({});
      driver.available = true;
      const resumed = start(root, 'resume');
      expect((await resumed.result).reusedCompletion).toBe(true);
      expect(resumed.calls).not.toHaveBeenCalled();
    });

    it('still starts other runs in the file store without the driver', async () => {
      const root = project();
      await start(root).result;
      driver.available = false;
      const f = runFixture(1);
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: root,
        run: { id: 'other', mode: 'start' },
      });
      expect(Object.keys(fileStoreRuns(root))).toHaveLength(1);
    });

    it('gives a run one owner across both stores', async () => {
      const root = project();
      const held = await createDefaultAgenticStateStore(root).acquire(key);
      driver.available = false;
      await expect(createDefaultAgenticStateStore(root).acquire(key)).rejects.toMatchObject({
        code: 'conflict',
        reason: 'run_in_progress',
      });
      await expect(createLocalAgenticStateStore(root).acquire(key)).rejects.toMatchObject({
        code: 'conflict',
      });
      await held.release();
    });
  });

  describe('file safety', () => {
    it('keeps state private', async () => {
      const root = project();
      await start(root).result;
      expect(fs.statSync(join(stateDirectory(root), 'agentic-state')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(runFile(root)).mode & 0o777).toBe(0o600);
    });

    it('rejects a symlink in place of a run file', async () => {
      const root = project();
      const outside = join(project(), 'outside.duckdb');
      fs.mkdirSync(join(stateDirectory(root), 'agentic-state'), { recursive: true });
      fs.writeFileSync(outside, '');
      fs.symlinkSync(outside, runFile(root));
      await expect(start(root).result).rejects.toThrow();
      expect(fs.readFileSync(outside, 'utf8')).toBe('');
      expect(fs.readdirSync(stateDirectory(root)).filter((n) => n.endsWith('.lock'))).toEqual([]);
    });

    it('rejects a symlink in place of the state directory', async () => {
      const root = project();
      const outside = project();
      fs.mkdirSync(stateDirectory(root), { recursive: true });
      fs.symlinkSync(outside, join(stateDirectory(root), 'agentic-state'));
      await expect(start(root).result).rejects.toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('reports a damaged state file instead of starting again', async () => {
      const root = project();
      await start(root).result;
      fs.writeFileSync(runFile(root), 'not a database');
      const attempt = start(root, 'resume');
      await expect(attempt.result).rejects.toMatchObject({
        code: 'unavailable',
        reason: 'state_file',
      });
      expect(attempt.calls).not.toHaveBeenCalled();
    });
  });

  describe('retention', () => {
    const old = (file: string) => {
      const date = new Date(Date.now() - 3_600_000);
      fs.utimesSync(file, date, date);
    };

    it('trusts the run header over the age of its file', async () => {
      const root = project();
      await start(root).result;
      old(runFile(root));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const other = await createDefaultAgenticStateStore(root, { retentionMs: 10 }).acquire({
        ...key,
        id: 'other',
      });
      await other.release();
      expect(fs.existsSync(runFile(root))).toBe(true);
    });

    it('removes an expired file and keeps one the sweep cannot lock', async () => {
      const root = project();
      const f = runFixture(2);
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: root,
        stateStore: createDefaultAgenticStateStore(root, { retentionMs: 1 }),
        run: { id: key.id, mode: 'start' },
      });
      const held = await createDefaultAgenticStateStore(root).acquire({ ...key, id: 'held' });
      const heldFile = runFile(root, digestAgenticState({ ...key, id: 'held' }));
      old(runFile(root));
      old(heldFile);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const other = await createDefaultAgenticStateStore(root, { retentionMs: 10 }).acquire({
        ...key,
        id: 'other',
      });
      await other.release();
      expect(fs.existsSync(runFile(root))).toBe(false);
      expect(fs.existsSync(heldFile)).toBe(true);
      await held.release();
    });

    it('rechecks a file it had to keep only after another retention period', async () => {
      const root = project();
      const plan = await planScenario();
      const first = await createDefaultAgenticStateStore(root).acquire(plan.key);
      let snapshot = await first.create(plan.initial);
      for (const recorded of plan.commands.slice(0, 2)) {
        snapshot = await first.checkpoint(currentCommand(snapshot, recorded));
      }
      await first.release();
      const file = runFile(root, digestAgenticState(plan.key));
      old(file);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fs.statSync(file).mtimeMs;
      const other = await createDefaultAgenticStateStore(root, { retentionMs: 10 }).acquire(key);
      await other.release();
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).mtimeMs).toBeGreaterThan(before);
    });

    it('never follows a symlink when sweeping', async () => {
      const root = project();
      await start(root).result;
      const outside = join(project(), 'outside.duckdb');
      fs.renameSync(runFile(root), outside);
      const linked = runFile(root, 'a'.repeat(64));
      fs.symlinkSync(outside, linked);
      old(outside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const other = await createDefaultAgenticStateStore(root, { retentionMs: 10 }).acquire({
        ...key,
        id: 'other',
      });
      await other.release();
      expect(fs.existsSync(outside)).toBe(true);
    });
  });

  describe('cursor migration', () => {
    it('reads old progress once, then never again', async () => {
      const root = project();
      const old = createLocalAgenticCursorStore(root);
      await old.begin(cursorKey, signature, 'old-run');
      await old.commit(cursorKey, signature, 'old-run', { pairs: 5 });
      const cursors = createDefaultAgenticStateStore(root).cursors!;
      expect(await cursors.begin(cursorKey, signature, 'new-run')).toEqual({ pairs: 5 });
      await cursors.commit(cursorKey, signature, 'new-run', { pairs: 9 });
      // A later change to the old store must not affect the new row.
      await old.begin(cursorKey, signature, 'stale');
      await old.commit(cursorKey, signature, 'stale', { pairs: 100 });
      const reopened = createDefaultAgenticStateStore(root).cursors!;
      expect(await reopened.begin(cursorKey, signature, 'later')).toEqual({ pairs: 9 });
    });

    it('carries an active reservation over, so takeover still sees the old owner', async () => {
      const root = project();
      await createLocalAgenticCursorStore(root).begin(cursorKey, signature, 'old-run');
      const failure = await createDefaultAgenticStateStore(root)
        .cursors!.begin(cursorKey, signature, 'new-run')
        .catch((error) => error);
      expect(failure).toBeInstanceOf(AgenticCursorConflict);
      expect(failure.activeRun).toBe('old-run');
    });

    it('hands progress on to a store that takes over', async () => {
      const root = project();
      const cursors = createDefaultAgenticStateStore(root).cursors!;
      await cursors.begin(cursorKey, signature, 'run');
      await cursors.commit(cursorKey, signature, 'run', { pairs: 5 });
      expect((await readDefaultAgenticCursor(root, cursorKey))?.values).toEqual({ pairs: 5 });
      const fileOnly = project();
      const old = createLocalAgenticCursorStore(fileOnly);
      await old.begin(cursorKey, signature, 'run');
      await old.commit(cursorKey, signature, 'run', { pairs: 7 });
      expect((await readDefaultAgenticCursor(fileOnly, cursorKey))?.values).toEqual({ pairs: 7 });
      expect(await readDefaultAgenticCursor(project(), cursorKey)).toBeNull();
    });

    it('still reports a missing run to takeover on stores that never expire one', async () => {
      const root = project();
      const store = createLocalAgenticStateStore(root);
      await store.cursors!.begin(cursorKey, signature, 'gone');
      await expect(
        beginAgenticCursor(store.cursors!, store, cursorKey, signature, 'fresh', true)
      ).rejects.toMatchObject({ code: 'missing' });
    });

    it('starts a new key from nothing', async () => {
      const cursors = createDefaultAgenticStateStore(project()).cursors!;
      expect(await cursors.begin(cursorKey, signature, 'run')).toEqual({});
    });

    it('uses the file cursors without the driver', async () => {
      const root = project();
      driver.available = false;
      const cursors = createDefaultAgenticStateStore(root).cursors!;
      await cursors.begin(cursorKey, signature, 'run');
      await cursors.commit(cursorKey, signature, 'run', { pairs: 5 });
      expect(fs.existsSync(cursorFile(root))).toBe(false);
      expect(await createLocalAgenticCursorStore(root).begin(cursorKey, signature, 'next')).toEqual(
        { pairs: 5 }
      );
    });

    it('refuses older progress once it has moved to DuckDB', async () => {
      const root = project();
      await createDefaultAgenticStateStore(root).cursors!.begin(cursorKey, signature, 'run');
      driver.available = false;
      await expect(
        createDefaultAgenticStateStore(root).cursors!.begin(cursorKey, signature, 'run')
      ).rejects.toMatchObject({ code: 'unavailable', reason: 'duckdb_required' });
    });
  });

  describe('DuckDB checkpoint_store', () => {
    const integration = (path: string, readOnly = false): DuckDbIntegration => ({
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'file', path, read_only: readOnly },
    });

    it('needs a writable file', () => {
      const memory: DuckDbIntegration = {
        ...integration('unused'),
        auth: { type: 'memory' },
      };
      expect(() => createDuckDbCheckpointStore(memory, { schema: 'state' })).toThrow(
        expect.objectContaining({ reason: 'invalid_store_config' })
      );
      expect(() =>
        createDuckDbCheckpointStore(integration('unused', true), { schema: 'state' })
      ).toThrow(expect.objectContaining({ reason: 'invalid_store_config' }));
    });

    it.each([
      [{ schema: ' ' }],
      [{ schema: 'state', leaseMs: 1 }],
      [{ schema: 'state', leaseMs: 600_001 }],
      [{ schema: 'state', retentionMs: 0 }],
    ])('rejects invalid settings %j', (options) => {
      expect(() => createDuckDbCheckpointStore(integration('unused'), options)).toThrow(
        expect.objectContaining({ reason: 'invalid_store_config' })
      );
    });

    it('holds nothing open between operations', async () => {
      const file = join(project(), 'state.duckdb');
      const store = createDuckDbCheckpointStore(integration(file), { schema: 'state' });
      const session = await store.acquire(key);
      // The file stays free for other users of the database while the session is alive.
      const runner = await buildDuckDbRunner(integration(file));
      await runner.query!('SELECT 1 AS one');
      await runner.close?.();
      await session.release();
    });

    it('carries over a DuckDB publisher cursor', async () => {
      const root = project();
      const target = integration(join(root, 'target.duckdb'));
      const publisher = await createDuckDbAgenticPublisher(target);
      await publisher.cursors!.begin(cursorKey, signature, 'old-run');
      await publisher.cursors!.commit(cursorKey, signature, 'old-run', { pairs: 5 });
      await publisher.close();
      const store = createDuckDbCheckpointStore(integration(join(root, 'state.duckdb')), {
        schema: 'state',
        legacyCursors: duckDbPublicationCursorReader(target),
      });
      expect(await store.cursors!.begin(cursorKey, signature, 'new-run')).toEqual({ pairs: 5 });
    });

    it('refuses a reservation it could never release', async () => {
      const root = project();
      const store = createDuckDbCheckpointStore(integration(join(root, 'state.duckdb')), {
        schema: 'state',
        legacyCursors: async () => ({
          signature,
          values: { pairs: 5 },
          activeRun: 'unfinished',
          committedRun: null,
        }),
      });
      await expect(store.cursors!.begin(cursorKey, signature, 'new-run')).rejects.toMatchObject({
        code: 'conflict',
        reason: 'cursor_held_elsewhere',
      });
      // Nothing was written, so finishing that run elsewhere can still carry over.
      const finished = createDuckDbCheckpointStore(integration(join(root, 'state.duckdb')), {
        schema: 'state',
        legacyCursors: async () => ({
          signature,
          values: { pairs: 9 },
          activeRun: null,
          committedRun: 'unfinished',
        }),
      });
      expect(await finished.cursors!.begin(cursorKey, signature, 'new-run')).toEqual({ pairs: 9 });
    });

    it('stops reading an old cursor when the run is cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const read = duckDbPublicationCursorReader(
        integration(join(project(), 'target.duckdb')),
        controller.signal
      );
      const failure = await read(cursorKey).catch((error: unknown) => error);
      expect(isCancellationError(failure, controller.signal)).toBe(true);
    });

    it('finds no publisher cursor in a new database', async () => {
      const read = duckDbPublicationCursorReader(integration(join(project(), 'new.duckdb')));
      expect(await read(cursorKey)).toBeNull();
    });

    it('can share the file that holds the legacy cursors', async () => {
      const file = join(project(), 'shared.duckdb');
      const target = integration(file);
      const publisher = await createDuckDbAgenticPublisher(target);
      await publisher.cursors!.begin(cursorKey, signature, 'old-run');
      await publisher.cursors!.commit(cursorKey, signature, 'old-run', { pairs: 5 });
      await publisher.close();
      const store = createDuckDbCheckpointStore(target, {
        schema: 'state',
        legacyCursors: duckDbPublicationCursorReader(target),
      });
      expect(await store.cursors!.begin(cursorKey, signature, 'new-run')).toEqual({ pairs: 5 });
    });

    function agenticProject(root: string, stateIntegration: object) {
      for (const dir of ['integrations', 'sources', 'models']) fs.mkdirSync(join(root, dir));
      fs.writeFileSync(
        join(root, 'integrations/lake.yml'),
        stringify({ ...integration(join(root, 'lake.duckdb')), connection: { schema: 'main' } })
      );
      fs.writeFileSync(
        join(root, 'integrations/state.yml'),
        stringify({ ...stateIntegration, name: 'state', connection: { schema: 'main' } })
      );
      fs.writeFileSync(
        join(root, 'model-spec.yml'),
        stringify({
          checkpoint_store: {
            integration: 'state',
            schema: 'checkpoints',
            lease_seconds: 30,
            retention_days: 7,
          },
        })
      );
      fs.writeFileSync(
        join(root, 'sources/pairs.yml'),
        stringify({
          spec_version: '0.2',
          name: 'pairs',
          type: 'source',
          source_type: 'warehouse_table',
          connection: 'lake',
          table: 'raw.pairs',
          schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
        })
      );
      fs.writeFileSync(
        join(root, 'models/undecided_pairs.yml'),
        stringify({
          spec_version: '0.2',
          type: 'model',
          name: 'undecided_pairs',
          description: 'Test model',
          grain: 'pair_id',
          source: { ref: 'lake.pairs' },
          columns: [{ name: 'pair_id', expr: 'pair_id', type: 'STRING' }],
          materialization: { type: 'table' },
        })
      );
      const fixture = runFixture(2);
      fs.writeFileSync(join(root, 'models/agentic.yml'), stringify(fixture.model));
      return fixture;
    }

    it.each([
      [
        'the file that holds model output',
        (root: string) => integration(join(root, 'lake.duckdb')),
      ],
      ['a read-only file', (root: string) => integration(join(root, 'state.duckdb'), true)],
      ['a database in memory', () => ({ ...integration('unused'), auth: { type: 'memory' } })],
    ])('rejects %s before any run starts', async (_, stateIntegration) => {
      const { runProject } = await import('../../src/api/index.js');
      const root = project();
      const fixture = agenticProject(root, stateIntegration(root));
      const calls = vi.spyOn(fixture.host, 'executeAgent');
      await expect(
        runProject(root, {
          models: ['pair_assessments'],
          agentic: { host: fixture.host, run: { id: key.id, mode: 'start' } },
        })
      ).rejects.toMatchObject({ exitCode: 2 });
      expect(calls).not.toHaveBeenCalled();
    });

    it('serves a project through model-spec.yml', async () => {
      const { runProject } = await import('../../src/api/index.js');
      const root = project();
      const file = join(root, 'state.duckdb');
      const fixture = agenticProject(root, integration(file));
      const result = await runProject(root, {
        models: ['pair_assessments'],
        agentic: {
          host: fixture.host,
          publisher: {
            preflight: async () => {},
            claim: async () => ({ version: 0, fence: 'fence' }),
            prepare: async (_context, identity) => ({
              identity,
              expected_version: 0,
              stage: `stage_${identity.operation_id}`,
            }),
            inspect: async () => null,
            commit: async (intent) => ({ intent, committed_version: 1 }),
            close: async () => {},
          },
          run: { id: key.id, mode: 'start' },
        },
      });
      expect(result.byIntegration[0]?.error).toBeUndefined();
      const runner = await buildDuckDbRunner(integration(file));
      try {
        const rows = await runner.query!(
          'SELECT run_id, summary FROM checkpoints.__dogsled_agentic_runs'
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.run_id).toBe(key.id);
      } finally {
        await runner.close?.();
      }
    });
  });
});
