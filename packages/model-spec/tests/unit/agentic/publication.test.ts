import { describe, expect, it, vi } from 'vitest';
import {
  executeAgenticRun,
  applyAgenticCheckpoint,
  createAgenticPublicationIdentity,
  AgenticStateError,
} from '../../../src/agentic/index.js';
import type {
  AgenticPublisher,
  AgenticStateStore,
  AgenticRunProgress,
} from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

describe('durable publication checkpoints', () => {
  it.each(['response', 'lease'])(
    'reconciles a committed publication after losing its %s',
    async (loss) => {
      const fixture = runFixture(1);
      const stateStore = new MemoryStateStore();
      const ownership = new AbortController();
      let acquired = 0;
      const recoveringStore: AgenticStateStore = {
        async acquire(key) {
          const session = await stateStore.acquire(key);
          if (++acquired > 1 || loss !== 'lease') return session;
          return {
            ...session,
            ownershipLost: ownership.signal,
            async read() {
              if (ownership.signal.aborted) throw new AgenticStateError('lease_lost');
              return session.read();
            },
          };
        },
      };
      let warehouse: Awaited<ReturnType<AgenticPublisher['commit']>> | null = null;
      const publisher: AgenticPublisher = {
        preflight: vi.fn(async () => {}),
        claim: vi.fn(async () => ({ version: 0, fence: 'owner' })),
        prepare: vi.fn(async (_context, identity, _rows, _keys, claim) => ({
          identity,
          expected_version: claim.version,
          stage: `stage_${identity.operation_id}`,
        })),
        inspect: vi.fn(async () => warehouse),
        commit: vi.fn(async (intent) => {
          expect(stateStore.owners.size).toBe(1);
          warehouse = { intent, committed_version: 1 };
          if (loss === 'lease') ownership.abort();
          throw new Error('commit response lost');
        }),
        close: vi.fn(async () => {}),
      };
      fixture.host.executeAgent = vi.fn(fixture.host.executeAgent);
      const progress: AgenticRunProgress[] = [];
      const options = {
        run: { id: 'recovery', mode: 'start' as const },
        stateStore: recoveringStore,
        publisher,
        projectDirectory: '/unused',
        onProgress: (value: AgenticRunProgress) => {
          progress.push(value);
        },
      };
      const first = await executeAgenticRun(fixture.host, fixture.context(), options);
      expect(first.publication).toBe('confirmed');
      expect(progress).toContainEqual(
        expect.objectContaining({ accepted: 1, publication: 'pending' })
      );
      expect(progress.at(-1)).toMatchObject({ accepted: 1, total: 1, publication: 'confirmed' });
      expect([...stateStore.runs.values()][0]!.publication).toBe('confirmed');
      const resumed = await executeAgenticRun(fixture.host, fixture.context(), {
        ...options,
        run: { id: 'recovery', mode: 'resume' },
      });
      expect(resumed.publication).toBe('confirmed');
      expect(fixture.host.executeAgent).toHaveBeenCalledTimes(1);
      expect(publisher.commit).toHaveBeenCalledTimes(1);
      expect(publisher.preflight).toHaveBeenCalledTimes(1);
      expect(stateStore.owners.size).toBe(0);
    }
  );
  it('binds a publication receipt to the complete immutable intent and preserves it on retry', async () => {
    const fixture = runFixture(1);
    const stateStore = new MemoryStateStore();
    await executeAgenticRun(fixture.host, fixture.context(), {
      run: { id: 'publication', mode: 'start' },
      stateStore,
      projectDirectory: '/unused',
    });
    const complete = [...stateStore.runs.values()][0]!;
    const identity = createAgenticPublicationIdentity(complete);
    const intent = { identity, expected_version: 0, stage: `stage_${identity.operation_id}` };
    const prepare = {
      type: 'prepare_publication' as const,
      operation_id: identity.operation_id,
      expected_revision: complete.revision,
      intent,
    };
    const prepared = applyAgenticCheckpoint(complete, prepare);
    expect(prepared.publication).toBe('prepared');
    expect(applyAgenticCheckpoint(prepared, prepare)).toEqual(prepared);
    const receipt = { intent, committed_version: 1 };
    const confirm = {
      type: 'confirm_publication' as const,
      operation_id: identity.operation_id,
      expected_revision: prepared.revision,
      receipt,
    };
    const confirmed = applyAgenticCheckpoint(prepared, confirm);
    expect(confirmed.publication).toBe('confirmed');
    expect(applyAgenticCheckpoint(confirmed, confirm)).toEqual(confirmed);
    expect(() =>
      applyAgenticCheckpoint(prepared, {
        ...confirm,
        receipt: {
          ...receipt,
          intent: { ...intent, identity: { ...identity, target: 'another' } },
        },
      })
    ).toThrow();
    expect(() =>
      applyAgenticCheckpoint(complete, {
        ...prepare,
        intent: {
          ...intent,
          identity: { ...identity, results_digest: '0'.repeat(64) },
        },
      })
    ).toThrow();
  });
  it('rejects a malformed receipt even when its operation ID matches', async () => {
    const fixture = runFixture(1);
    const store = new MemoryStateStore();
    const publisher: AgenticPublisher = {
      preflight: async () => {},
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => ({
        intent: { ...intent, expected_version: 1 },
        committed_version: 2,
      }),
      close: async () => {},
    };
    await expect(
      executeAgenticRun(fixture.host, fixture.context(), {
        run: { id: 'bad-receipt', mode: 'start' },
        projectDirectory: '/unused',
        stateStore: store,
        publisher,
      })
    ).rejects.toThrow('corrupt');
    expect([...store.runs.values()][0]!.publication).toBe('prepared');
  });

  it('gives publication retries a fresh deadline and still reconciles existing receipts', async () => {
    const fixture = runFixture(1);
    const store = new MemoryStateStore();
    let receipt: Awaited<ReturnType<AgenticPublisher['inspect']>> = null;
    const publisher: AgenticPublisher = {
      preflight: async () => {},
      claim: vi.fn(async () => ({ version: 0, fence: 'owner' })),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => receipt,
      commit: vi.fn(async () => {
        throw new Error('before commit');
      }),
      close: async () => {},
    };
    const options = {
      run: { id: 'deadline', mode: 'start' as const },
      projectDirectory: '/unused',
      stateStore: store,
      publisher,
    };
    await expect(executeAgenticRun(fixture.host, fixture.context(), options)).rejects.toThrow(
      'before commit'
    );
    const snapshot = [...store.runs.values()][0]!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(snapshot.deadline_at) + 1);
    try {
      const resume = { ...options, run: { id: 'deadline', mode: 'resume' as const } };
      await expect(executeAgenticRun(fixture.host, fixture.context(), resume)).rejects.toThrow(
        'before commit'
      );
      receipt = { intent: snapshot.publication_intent!, committed_version: 1 };
      expect((await executeAgenticRun(fixture.host, fixture.context(), resume)).publication).toBe(
        'confirmed'
      );
      expect(publisher.commit).toHaveBeenCalledTimes(2);
      expect(publisher.claim).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('charges preflight time to the saved deadline and never starts agents after expiry', async () => {
    const fixture = runFixture(1);
    fixture.model.limits.timeout_seconds = 1;
    fixture.host.prepare = vi.fn(fixture.host.prepare);
    fixture.host.executeAgent = vi.fn(fixture.host.executeAgent);
    const store = new MemoryStateStore();
    let owned = false;
    let signalPassed = false;
    const publisher: AgenticPublisher = {
      preflight: vi.fn(async (_context, signal) => {
        owned = store.owners.size === 1;
        signalPassed = signal instanceof AbortSignal;
        await Promise.resolve();
        vi.setSystemTime(Date.now() + 2000);
      }),
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => ({ intent, committed_version: 1 }),
      close: async () => {},
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const options = {
        run: { id: 'preflight-time', mode: 'start' as const },
        stateStore: store,
        publisher,
        projectDirectory: '/unused',
      };
      await expect(executeAgenticRun(fixture.host, fixture.context(), options)).rejects.toThrow(
        'expired'
      );
      expect(owned).toBe(true);
      expect(signalPassed).toBe(true);
      expect(fixture.host.prepare).not.toHaveBeenCalled();
      expect(fixture.host.executeAgent).not.toHaveBeenCalled();
      const saved = [...store.runs.values()][0]!;
      expect(saved.status).toBe('preparing');
      expect(Date.parse(saved.deadline_at) - Date.parse(saved.started_at)).toBe(1000);
      await expect(
        executeAgenticRun(fixture.host, fixture.context(), {
          ...options,
          run: { id: 'preflight-time', mode: 'resume' },
        })
      ).rejects.toThrow('expired');
      expect(publisher.preflight).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels in-flight preflight with the run deadline signal before any preparation', async () => {
    const fixture = runFixture(1);
    fixture.host.prepare = vi.fn(fixture.host.prepare);
    fixture.host.executeAgent = vi.fn(fixture.host.executeAgent);
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publisher: AgenticPublisher = {
      preflight: async (_context, signal) => {
        entered();
        if (!signal) throw new Error('Missing deadline signal');
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      },
      claim: async () => {
        throw new Error('Unexpected claim');
      },
      prepare: async () => {
        throw new Error('Unexpected stage');
      },
      inspect: async () => null,
      commit: async () => {
        throw new Error('Unexpected commit');
      },
      close: async () => {},
    };
    try {
      const result = executeAgenticRun(fixture.host, fixture.context(), {
        run: { id: 'preflight-cancel', mode: 'start' },
        stateStore: new MemoryStateStore(),
        publisher,
        projectDirectory: '/unused',
      });
      const rejected = expect(result).rejects.toMatchObject({ cancelled: true });
      await started;
      timeout.abort();
      await rejected;
      expect(fixture.host.prepare).not.toHaveBeenCalled();
      expect(fixture.host.executeAgent).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
  it('saves confirmation but surfaces an active deadline cancelled during commit', async () => {
    const fixture = runFixture(1);
    const store = new MemoryStateStore();
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const publisher: AgenticPublisher = {
      preflight: async () => {},
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => {
        deadline.abort();
        return { intent, committed_version: 1 };
      },
      close: async () => {},
    };
    try {
      await expect(
        executeAgenticRun(fixture.host, fixture.context(), {
          run: { id: 'deadline-commit', mode: 'start' },
          stateStore: store,
          publisher,
          projectDirectory: '/unused',
        })
      ).rejects.toMatchObject({ cancelled: true });
      expect([...store.runs.values()][0]!.publication).toBe('confirmed');
      expect(store.owners.size).toBe(0);
    } finally {
      timer.mockRestore();
    }
  });
});
