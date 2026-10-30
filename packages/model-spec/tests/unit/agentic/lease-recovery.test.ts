import { describe, expect, it, vi } from 'vitest';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { AgenticStateError, type AgenticStateStore } from '../../../src/agentic/state.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

describe('checkpoint lease recovery', () => {
  it.each([true, false])(
    'reloads after ownership loss with result saved: %s',
    async (committed) => {
      const memory = new MemoryStateStore();
      let acquisitions = 0;
      let lost = false;
      const store: AgenticStateStore = {
        async acquire(key) {
          const session = await memory.acquire(key);
          const first = ++acquisitions === 1;
          return {
            ...session,
            async read() {
              if (first && lost) throw new AgenticStateError('lease_lost');
              return session.read();
            },
            async checkpoint(command) {
              // The result was committed but the worker lost its lease before receiving it.
              if (first && command.type === 'finish_attempt' && !committed) {
                lost = true;
                throw new AgenticStateError('lease_lost');
              }
              const result = await session.checkpoint(command);
              if (first && command.type === 'finish_attempt') {
                lost = true;
                throw new AgenticStateError('lease_lost');
              }
              return result;
            },
          };
        },
      };
      const f = runFixture(2);
      const call = vi.spyOn(f.host, 'executeAgent');
      const result = await executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store,
        run: { id: 'recover', mode: 'start' },
        accounting: 'reservation' as const,
      });
      expect(result.status).toBe('execution_complete');
      expect(acquisitions).toBe(2);
      expect(call).toHaveBeenCalledTimes(committed ? 2 : 3);
      expect(result.chargedTokens).toBe(committed ? 4 : 104);
    }
  );

  it('aborts active calls before reopening and retains interrupted token reservations', async () => {
    const memory = new MemoryStateStore();
    const ownership = new AbortController();
    let acquisitions = 0;
    let stopped = false;
    const store: AgenticStateStore = {
      async acquire(key) {
        if (acquisitions) expect(stopped).toBe(true);
        const session = await memory.acquire(key);
        return ++acquisitions === 1 ? { ...session, ownershipLost: ownership.signal } : session;
      },
    };
    const f = runFixture(1);
    const realCall = f.host.executeAgent;
    f.host.executeAgent = vi
      .fn()
      .mockImplementationOnce(async ({ signal }) => {
        signal.addEventListener(
          'abort',
          () => {
            stopped = true;
          },
          { once: true }
        );
        ownership.abort();
        throw new Error('interrupted');
      })
      .mockImplementation(realCall);
    const result = await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'heartbeat', mode: 'start' },
      accounting: 'reservation' as const,
    });
    expect(acquisitions).toBe(2);
    expect(result.chargedTokens).toBe(102);
  });

  it('does not extend a deadline during recovery', async () => {
    const memory = new MemoryStateStore();
    let acquisitions = 0;
    const store: AgenticStateStore = {
      async acquire(key) {
        const session = await memory.acquire(key);
        const first = ++acquisitions === 1;
        return {
          ...session,
          async create(snapshot) {
            await session.create({
              ...snapshot,
              started_at: new Date(0).toISOString(),
              deadline_at: new Date(
                Date.parse(snapshot.deadline_at) - Date.parse(snapshot.started_at)
              ).toISOString(),
            });
            if (first) throw new AgenticStateError('lease_lost');
            return snapshot;
          },
        };
      },
    };
    const f = runFixture(1);
    const call = vi.spyOn(f.host, 'executeAgent');
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: store,
        run: { id: 'deadline', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toMatchObject({ code: 'expired' });
    expect(acquisitions).toBe(2);
    expect(call).not.toHaveBeenCalled();
  });

  it('stops recovery when another worker holds ownership', async () => {
    const release = vi.fn(async () => {});
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({
        read: async () => {
          throw new AgenticStateError('lease_lost');
        },
        release,
      })
      .mockRejectedValue(new AgenticStateError('conflict'));
    const f = runFixture(1);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: { acquire },
        run: { id: 'taken-over', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds repeated ownership loss', async () => {
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({
      read: async () => {
        throw new AgenticStateError('lease_lost');
      },
      create: vi.fn(),
      checkpoint: vi.fn(),
      release,
    }));
    const f = runFixture(1);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: { acquire },
        run: { id: 'bounded', mode: 'start' },
        accounting: 'reservation' as const,
      })
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('does not retry a conflicting owner or a corrupt checkpoint', async () => {
    const f = runFixture(1);
    for (const code of ['conflict', 'corrupt'] as const) {
      const acquire = vi.fn(async () => {
        throw new AgenticStateError(code);
      });
      await expect(
        executeAgenticRun(f.host, f.context(), {
          projectDirectory: '/unused',
          stateStore: { acquire },
          run: { id: code, mode: 'start' },
          accounting: 'reservation' as const,
        })
      ).rejects.toMatchObject({ code });
      expect(acquire).toHaveBeenCalledOnce();
    }
  });
});
