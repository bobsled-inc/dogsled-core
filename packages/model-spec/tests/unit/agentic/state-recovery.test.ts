import { once } from 'node:events';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  createDefaultAgenticStateStore,
  createLocalAgenticStateStore,
  AgenticStateError,
  applyAgenticCheckpoint,
  digestAgenticState,
} from '../../../src/agentic/index.js';
import { loadState, saveState } from '../../../src/compiler/state.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

const roots: string[] = [];
function root() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentic-state-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const key = { scope: 'lake', model: 'pair_assessments', id: 'run' };
const regular = (checksum: string) => ({
  lastRunAt: 'now',
  materialization: 'table',
  specChecksum: checksum,
});

describe('durable agentic execution', { timeout: 60_000 }, () => {
  it('rejects a retired agentic state index', async () => {
    const dir = root();
    fs.mkdirSync(join(dir, '.bobsled/model-spec'), { recursive: true });
    fs.writeFileSync(
      join(dir, '.bobsled/model-spec/run-state.json'),
      JSON.stringify({ models: {}, agentic: { version: 1, runs: {} } })
    );
    const lease = await createLocalAgenticStateStore(dir).acquire(key);
    try {
      await expect(lease.read()).rejects.toThrow('corrupt');
    } finally {
      await lease.release();
    }
  });

  it('reuses twelve accepted results in a new process after SIGKILL and executes only eight unfinished assignments', async () => {
    const dir = root();
    const first = join(dir, 'first.txt');
    const second = join(dir, 'second.txt');
    const worker = new URL('./recovery-process.ts', import.meta.url);
    const run = async (mode: string, marker: string, crash = false) => {
      const stderrPath = `${marker}.stderr`;
      const stderrFd = fs.openSync(stderrPath, 'w');
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', worker.pathname, dir, mode, marker, ...(crash ? ['crash'] : [])],
        // Observe worker exit instead of pipe EOF from loader descendants.
        // Keep main's allowance for checkpoint fsync on slow shared CI disks.
        { stdio: ['ignore', 'ignore', stderrFd], timeout: 240_000 }
      );
      try {
        const [status, signal] = await once(child, 'exit');
        return { status, signal, stderr: fs.readFileSync(stderrPath, 'utf8') };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.closeSync(stderrFd);
      }
    };
    const interrupted = await run('start', first, true);
    expect(interrupted.stderr).toBe('');
    expect(interrupted.signal).toBe('SIGKILL');
    expect(fs.readFileSync(first, 'utf8').trim().split('\n')).toHaveLength(13);
    const recovered = await run('resume', second);
    expect(recovered.stderr).toBe('');
    expect(recovered.status).toBe(0);
    expect(fs.readFileSync(second, 'utf8').trim().split('\n')).toEqual([
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
    ]);
    const session = await createDefaultAgenticStateStore(dir).acquire({ ...key, id: 'recovery' });
    const state = await session.read();
    expect(state?.work.filter((work) => work.accepted)).toHaveLength(20);
    expect(state?.charged).toBe(140); // 20 measured outcomes plus the lost reservation.
    expect(state?.publication).toBe('pending');
    expect(state?.status).toBe('execution_complete');
    expect(state?.work[12]?.attempts).toHaveLength(2);
    await session.release();
  }, 490_000);

  it.each(['local', 'supplied'] as const)(
    'preserves completion and processed keys for empty outcomes using %s storage',
    async (kind) => {
      const dir = root();
      const f = runFixture(2);
      const stateStore = kind === 'supplied' ? new MemoryStateStore() : undefined;
      const options = {
        projectDirectory: dir,
        run: { id: 'run', mode: 'start' as const },
        accounting: 'reservation' as const,
        ...(stateStore ? { stateStore } : {}),
      };
      const result = await executeAgenticRun(f.host, f.context(), options);
      expect(result.rows).toEqual([]);
      expect(result.processedKeys).toEqual([{ pair_id: 'p0' }, { pair_id: 'p1' }]);
      f.host.prepare = vi.fn(async () => {
        throw new Error('must not prepare again');
      });
      f.host.executeAgent = vi.fn(async () => {
        throw new Error('must not execute again');
      });
      const resumed = await executeAgenticRun(f.host, f.context(), {
        ...options,
        run: { id: 'run', mode: 'resume' },
        accounting: 'reservation' as const,
      });
      expect(resumed.reusedCompletion).toBe(true);
      expect(resumed.chargedTokens).toBe(4);
      expect(f.host.prepare).not.toHaveBeenCalled();
      expect(f.host.executeAgent).not.toHaveBeenCalled();
      if (stateStore) expect(fs.existsSync(join(dir, '.bobsled/model-spec'))).toBe(false);
    }
  );

  it('does no local I/O when a supplied store is selected, even with a missing project path', async () => {
    const f = runFixture(0);
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/does/not/exist/agentic',
      stateStore: new MemoryStateStore(),
      run: { id: 'run', mode: 'start' },
      accounting: 'reservation' as const,
    });
    expect(result.processedKeys).toEqual([]);
  });

  it('keeps unknown interrupted usage and retry limits across restart', async () => {
    const dir = root();
    const f = runFixture(1);
    f.model.limits.tokens = 150;
    f.host.executeAgent = async () => {
      throw new Error('provider secret: not retained');
    };
    const options = {
      projectDirectory: dir,
      run: { id: 'run', mode: 'start' as const },
      accounting: 'reservation' as const,
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
      'Agentic executor failed'
    );
    f.host.executeAgent = vi.fn();
    await expect(
      executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } })
    ).rejects.toThrow('limit');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    const session = await createDefaultAgenticStateStore(dir).acquire(key);
    try {
      expect(JSON.stringify(await session.read())).not.toContain('provider secret');
    } finally {
      await session.release();
    }
  });

  it('refreshes the deadline but still enforces the original definition on resume', async () => {
    const dir = root();
    const f = runFixture(1);
    const execute = f.host.executeAgent;
    f.host.executeAgent = async () => {
      throw new Error('interrupted');
    };
    const options = {
      projectDirectory: dir,
      run: { id: 'run', mode: 'start' as const },
      accounting: 'reservation' as const,
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
    await expect(
      executeAgenticRun(
        f.host,
        { ...f.context(), publicationSchema: 'new_system' },
        {
          ...options,
          run: { id: 'run', mode: 'resume' },
          accounting: 'reservation' as const,
        }
      )
    ).rejects.toThrow('conflict');
    f.model.limits.tokens++;
    await expect(
      executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } })
    ).rejects.toThrow('conflict');
    f.model.limits.tokens--;
    f.host.executeAgent = execute;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 700000);
    await expect(
      executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } })
    ).resolves.toMatchObject({ status: 'execution_complete' });
  });

  it('rejects a concurrent owner and obsolete sessions', async () => {
    const dir = root();
    const store = createLocalAgenticStateStore(dir);
    const session = await store.acquire(key);
    // A live owner is a busy run (a documented conflict), not a storage failure.
    await expect(store.acquire(key)).rejects.toThrow(/conflict \(run_in_progress\).*still active/);
    await session.release();
    const next = await store.acquire(key);
    await expect(session.read()).rejects.toThrow('conflict');
    await next.release();
  });

  it('keeps unrelated regular entries and unknown fields without resurrecting stale updates', async () => {
    const dir = root();
    saveState(dir, { models: { 'lake.a': regular('a') }, future: { version: 9 } });
    const stale = loadState(dir);
    const fresh = loadState(dir);
    fresh.models['lake.a'] = regular('new');
    fresh.models['lake.b'] = regular('b');
    saveState(dir, fresh);
    stale.models['lake.c'] = regular('c');
    saveState(dir, stale);
    const f = runFixture(1);
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: dir,
      run: { id: 'run', mode: 'start' },
      accounting: 'reservation' as const,
    });
    const state = loadState(dir);
    expect(state.models).toEqual({
      'lake.a': regular('new'),
      'lake.b': regular('b'),
      'lake.c': regular('c'),
    });
    expect(state.future).toEqual({ version: 9 });
    saveState(dir, stale);
    expect(loadState(dir).agentic).toEqual(state.agentic);
    const removal = loadState(dir);
    delete removal.models['lake.a'];
    saveState(dir, removal);
    saveState(dir, stale);
    expect(loadState(dir).models['lake.a']).toBeUndefined();
  });

  it('rejects missing, corrupt and escaping artifact references', async () => {
    const dir = root();
    const f = runFixture(0);
    const options = {
      projectDirectory: dir,
      stateStore: createLocalAgenticStateStore(dir),
      run: { id: 'run', mode: 'resume' as const },
      accounting: 'reservation' as const,
    };
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow('missing');
    await executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'start' } });
    const file = join(dir, '.bobsled/model-spec/run-state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ref = state.agentic.runs[digestAgenticState(key)];
    fs.writeFileSync(join(dir, '.bobsled/model-spec', ref), '{}');
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow('corrupt');
    fs.unlinkSync(join(dir, '.bobsled/model-spec', ref));
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow('corrupt');
    state.agentic.runs[digestAgenticState(key)] = '../../outside.json';
    fs.writeFileSync(file, JSON.stringify(state));
    await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow('corrupt');
  });

  it('rejects a symlink state directory and symlink artifacts', async () => {
    const dir = root();
    const outside = root();
    fs.mkdirSync(join(dir, '.bobsled'));
    fs.symlinkSync(outside, join(dir, '.bobsled/model-spec'));
    await expect(createLocalAgenticStateStore(dir).acquire(key)).rejects.toThrow('unavailable');
  });

  it('rejects a symlinked parent before creating nested state outside the project', () => {
    const dir = root();
    const outside = fs.mkdtempSync(join(tmpdir(), 'bobsled-outside-'));
    try {
      fs.symlinkSync(outside, join(dir, '.bobsled'));
      expect(() => saveState(dir, { models: {} })).toThrow(/inside the project/);
      expect(fs.existsSync(join(outside, 'model-spec'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sanitizes supplied storage failures instead of starting an empty run', async () => {
    const f = runFixture();
    f.host.prepare = vi.fn();
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: root(),
        run: { id: 'run', mode: 'start' },
        accounting: 'reservation' as const,
        stateStore: {
          async acquire() {
            throw new Error('SECRET');
          },
        },
      })
    ).rejects.toThrow('Agentic state unavailable');
    expect(f.host.prepare).not.toHaveBeenCalled();
  });
});

describe('store transaction contract', () => {
  it('makes duplicate operations idempotent and rejects stale attempts and conflicting outcomes', async () => {
    const store = new MemoryStateStore();
    const f = runFixture(1);
    f.host.executeAgent = async () => {
      throw new Error('crash');
    };
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: root(),
        stateStore: store,
        run: { id: 'run', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toThrow();
    const original = [...store.runs.values()][0]!;
    const start = {
      type: 'start_attempt' as const,
      operation_id: 'start_attempt:new',
      expected_revision: original.revision,
      work: 0,
      attempt_id: 'new',
    };
    const started = applyAgenticCheckpoint(original, start);
    expect(applyAgenticCheckpoint(started, start)).toEqual(started);
    const outcome = {
      contract_version: 2 as const,
      attempt_id: 'new',
      status: 'succeeded' as const,
      usage: { status: 'unknown' as const, reason: 'unavailable' as const },
      rows: [],
    };
    const finish = {
      type: 'finish_attempt' as const,
      operation_id: 'finish_attempt:new',
      expected_revision: started.revision,
      work: 0,
      attempt_id: 'new',
      outcome,
      charge: 100,
    };
    const accepted = applyAgenticCheckpoint(started, finish);
    expect(applyAgenticCheckpoint(accepted, finish)).toEqual(accepted);
    expect(() => applyAgenticCheckpoint(accepted, { ...finish, charge: 101 })).toThrow('conflict');
    const old = original.work[0]!.attempts[0]!.id;
    expect(() =>
      applyAgenticCheckpoint(started, {
        ...finish,
        attempt_id: old,
        operation_id: `finish_attempt:${old}`,
        outcome: { ...outcome, attempt_id: old },
      })
    ).toThrow('conflict');
    expect(() =>
      applyAgenticCheckpoint(accepted, {
        ...start,
        expected_revision: accepted.revision,
        attempt_id: 'late',
        operation_id: 'start_attempt:late',
      })
    ).toThrow('conflict');
  });

  it('recovers the receipt when a supplied store commits but its response is lost', async () => {
    const base = new MemoryStateStore();
    const f = runFixture(1);
    let lost = false;
    const stateStore = {
      async acquire(runKey: typeof key) {
        const session = await base.acquire(runKey);
        return {
          ...session,
          async checkpoint(command: Parameters<typeof applyAgenticCheckpoint>[1]) {
            const result = await session.checkpoint(command);
            if (!lost && command.type === 'finish_attempt') {
              lost = true;
              throw new AgenticStateError('unavailable');
            }
            return result;
          },
        };
      },
    };
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: root(),
      stateStore,
      run: { id: 'run', mode: 'start' },
      accounting: 'reservation' as const,
    });
    expect(result.chargedTokens).toBe(2);
    expect([...base.runs.values()][0]?.work[0]?.attempts).toHaveLength(1);
  });
});

it('saves the deadline before preparation and keeps it after an interrupted preparation', async () => {
  const dir = root();
  const f = runFixture(1);
  const store = new MemoryStateStore();
  f.host.prepare = async () => {
    throw new Error('preparation interrupted');
  };
  const options = {
    projectDirectory: dir,
    stateStore: store,
    run: { id: 'run', mode: 'start' as const },
    accounting: 'reservation' as const,
  };
  await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow();
  const before = structuredClone([...store.runs.values()][0]!);
  expect(before.status).toBe('preparing');
  f.host.prepare = async () => [{ pair_id: 'p0' }];
  await executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } });
  const after = [...store.runs.values()][0]!;
  expect(after.deadline_at).toBe(before.deadline_at);
  expect(after.started_at).toBe(before.started_at);
  expect(after.status).toBe('execution_complete');
});

it('stops before writing when orphan files exhaust the local artifact budget', async () => {
  const dir = root();
  fs.mkdirSync(join(dir, '.bobsled/model-spec'), { recursive: true });
  const fd = fs.openSync(join(dir, '.bobsled/model-spec/orphan.tmp'), 'w');
  fs.ftruncateSync(fd, 256 * 1024 * 1024);
  fs.closeSync(fd);
  const f = runFixture(1);
  f.host.prepare = vi.fn();
  await expect(
    executeAgenticRun(f.host, f.context(), {
      projectDirectory: dir,
      stateStore: createLocalAgenticStateStore(dir),
      run: { id: 'run', mode: 'start' },
      accounting: 'reservation' as const,
    })
  ).rejects.toThrow('limit');
  expect(f.host.prepare).not.toHaveBeenCalled();
  expect(fs.existsSync(join(dir, '.bobsled/model-spec/run-state.json'))).toBe(false);
});

it('drops removed known optional model fields while preserving unknown fields', () => {
  const dir = root();
  saveState(dir, {
    models: {
      'lake.a': {
        ...regular('old'),
        strategy: 'merge',
        publishedSnapshotId: 'old',
        futureFlag: true,
      },
    },
  });
  const state = loadState(dir);
  state.models['lake.a'] = regular('new');
  saveState(dir, state);
  expect(loadState(dir).models['lake.a']).toEqual({ ...regular('new'), futureFlag: true });
});

it('rejects a conflicting same-model update from a stale local state', () => {
  const dir = root();
  saveState(dir, { models: { 'lake.a': regular('old') } });
  const stale = loadState(dir);
  const fresh = loadState(dir);
  fresh.models['lake.a'] = regular('fresh');
  stale.models['lake.a'] = regular('stale');
  saveState(dir, fresh);
  expect(() => saveState(dir, stale)).toThrow('same model');
  expect(loadState(dir).models['lake.a']).toEqual(regular('fresh'));
});

it('preserves unrelated entries from concurrent regular writers in new processes', async () => {
  const dir = root();
  saveState(dir, { models: {} });
  const worker = new URL('./regular-state-process.ts', import.meta.url);
  const children = ['lake.a', 'lake.b'].map((model) =>
    spawn(process.execPath, ['--import', 'tsx', worker.pathname, dir, model], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
  );
  try {
    await Promise.all(children.map((child) => once(child, 'message')));
    const diagnostics = children.map(() => '');
    children.forEach((child, index) =>
      child.stderr?.on('data', (chunk) => {
        diagnostics[index] += String(chunk);
      })
    );
    const exited = children.map((child) => once(child, 'exit'));
    for (const child of children) child.send('write');
    expect(await Promise.all(exited)).toEqual([
      [0, null],
      [0, null],
    ]);
    expect(Object.keys(loadState(dir).models).sort()).toEqual(['lake.a', 'lake.b']);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}, 30000);

it('does not reset exhausted retry counts when the host resumes', async () => {
  const dir = root();
  const f = runFixture(1);
  f.host.executeAgent = vi.fn(async ({ assignment }) => ({
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'failed',
    usage: { status: 'unknown', reason: 'unavailable' },
    error: { kind: 'internal', code: 'RETRY', retryable: true },
  }));
  const options = {
    projectDirectory: dir,
    maxAttempts: 2,
    run: { id: 'run', mode: 'start' as const },
    accounting: 'reservation' as const,
  };
  await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
    /assignment \d+ failed/
  );
  expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
  await expect(
    executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } })
  ).rejects.toThrow(/assignment \d+ failed/);
  expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
});

it.each(['create', 'checkpoint', 'readback'] as const)(
  'rejects a supplied store that returns an invalid %s effect before dispatch',
  async (failure) => {
    const base = new MemoryStateStore();
    const f = runFixture(1);
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    const stateStore = {
      async acquire(runKey: typeof key) {
        const session = await base.acquire(runKey);
        return {
          ...session,
          async create(snapshot: Parameters<typeof session.create>[0]) {
            const created = await session.create(snapshot);
            return failure === 'create'
              ? { ...created, key: { ...created.key, id: 'foreign' } }
              : created;
          },
          async checkpoint(command: Parameters<typeof session.checkpoint>[0]) {
            if (command.type === 'start_attempt') {
              if (failure === 'readback') throw new Error('lost response without commit');
              return (await session.read())!;
            }
            return session.checkpoint(command);
          },
        };
      },
    };
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: root(),
        stateStore,
        run: { id: 'run', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toThrow('Agentic state');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect([...base.runs.values()][0]?.charged).toBe(0);
  }
);

it.each([
  'tokens',
  'attempts',
  'deadline',
  'assignment',
  'attempt ID',
  'revision',
  'acceptance',
] as const)('rejects saved %s corruption before dispatch', async (field) => {
  const stateStore = new MemoryStateStore();
  const f = runFixture(1);
  const options = {
    projectDirectory: root(),
    stateStore,
    run: { id: 'run', mode: 'start' as const },
    accounting: 'reservation' as const,
  };
  await executeAgenticRun(f.host, f.context(), options);
  // Saved state is frozen, so the damage goes into a copy that replaces it.
  const [key, saved] = [...stateStore.runs.entries()][0]!;
  const snapshot = structuredClone(saved);
  stateStore.runs.set(key, snapshot);
  if (field === 'tokens') snapshot.token_limit *= 10;
  if (field === 'attempts') snapshot.max_attempts++;
  if (field === 'deadline') {
    snapshot.deadline_at = new Date(Date.parse(snapshot.deadline_at) + 1000).toISOString();
  }
  if (field === 'assignment') snapshot.work[0]!.assignment.instructions = 'Changed';
  if (field === 'attempt ID') snapshot.work[0]!.attempts[0]!.id = 'changed';
  if (field === 'revision') snapshot.work[0]!.attempts[0]!.start_revision = 0;
  if (field === 'acceptance') {
    delete snapshot.work[0]!.accepted;
    snapshot.status = 'running';
  }
  f.host.executeAgent = vi.fn();
  await expect(
    executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'run', mode: 'resume' } })
  ).rejects.toThrow('Agentic state');
  expect(f.host.executeAgent).not.toHaveBeenCalled();
});

it.each(['terminal', 'overcharge'] as const)(
  'atomically rejects a retry after %s usage or failure',
  async (failure) => {
    const base = new MemoryStateStore();
    const f = runFixture(1);
    f.host.executeAgent = async () => {
      throw new Error('interrupted');
    };
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: root(),
        stateStore: base,
        run: { id: 'run', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toThrow();
    const before = [...base.runs.values()][0]!;
    const attempt = before.work[0]!.attempts[0]!;
    const ended = applyAgenticCheckpoint(before, {
      type: 'finish_attempt',
      operation_id: `finish_attempt:${attempt.id}`,
      expected_revision: before.revision,
      work: 0,
      attempt_id: attempt.id,
      outcome: {
        contract_version: 2,
        attempt_id: attempt.id,
        status: 'failed',
        usage: { status: 'unknown', reason: 'unavailable' },
        error: { kind: 'internal', code: 'FAILED', retryable: failure !== 'terminal' },
      },
      charge: failure === 'overcharge' ? 101 : 100,
    });
    expect(() =>
      applyAgenticCheckpoint(ended, {
        type: 'start_attempt',
        operation_id: 'start_attempt:retry',
        expected_revision: ended.revision,
        work: 0,
        attempt_id: 'retry',
      })
    ).toThrow(failure === 'terminal' ? 'conflict' : 'limit');
    expect(ended.work[0]!.attempts).toHaveLength(1);
  }
);

it('allows successive saves after preserving unknown fields in a replaced model record', () => {
  const directory = root();
  saveState(directory, { models: { 'lake.a': { ...regular('original'), futureFlag: true } } });
  const state = loadState(directory);
  state.models['lake.a'] = regular('first');
  saveState(directory, state);
  state.models['lake.a']!.specChecksum = 'second';
  saveState(directory, state);
  expect(loadState(directory).models['lake.a']).toEqual({ ...regular('second'), futureFlag: true });
});

it.each(['tests', 'expect'] as const)(
  'rejects authored %s in the direct API before storage or preparation',
  async (field) => {
    const f = runFixture(1);
    const context = f.context();
    if (field === 'tests') context.resolved.model.tests = [{ type: 'not_null', column: 'pair_id' }];
    else context.resolved.model.expect = [{ kind: 'non_null', column: 'pair_id' }];
    const stateStore = new MemoryStateStore();
    const acquire = vi.spyOn(stateStore, 'acquire');
    f.host.prepare = vi.fn(f.host.prepare);
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    await expect(
      executeAgenticRun(f.host, context, {
        projectDirectory: root(),
        stateStore,
        run: { id: 'run', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toThrow('does not support authored tests or expectations');
    expect(acquire).not.toHaveBeenCalled();
    expect(f.host.prepare).not.toHaveBeenCalled();
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  }
);
