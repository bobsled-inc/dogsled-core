import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeDurableFile, acquireFileOwnership } from '../../../src/compiler/durable-file.js';

import { executeAgenticRun, createLocalAgenticStateStore } from '../../../src/agentic/index.js';
import { runFixture } from './state-fixture.js';
const lockCalls = vi.hoisted(() => [] as string[]);
const fault = vi.hoisted(() => ({ armed: false, active: false }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    symlinkSync: vi.fn((target: string, path: string) => {
      lockCalls.push(path);
      actual.symlinkSync(target, path);
    }),
    fsyncSync: vi.fn((fd: number) => {
      if (fault.active && actual.fstatSync(fd).isDirectory()) {
        throw new Error('directory sync failed');
      }
      calls.push(actual.fstatSync(fd).isDirectory() ? 'sync directory' : 'sync file');
      actual.fsyncSync(fd);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      if (fault.armed && to.endsWith('run-state.json')) fault.active = true;
      calls.push('rename');
      actual.renameSync(from, to);
    }),
  };
});
const roots: string[] = [];
afterEach(() => {
  fault.armed = false;
  fault.active = false;
  lockCalls.length = 0;
  calls.length = 0;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = fs.mkdtempSync(join(tmpdir(), 'durable-file-'));
  roots.push(value);
  return value;
}

describe('local durable file replacement', () => {
  it('synchronizes the complete file before rename and the containing directory afterwards', () => {
    const file = join(root(), 'state.json');
    writeDurableFile(file, '{"version":1}');
    expect(calls).toEqual(['sync file', 'rename', 'sync directory']);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1}');
  });
  it('keeps the previous checkpoint when file synchronization fails', () => {
    const file = join(root(), 'state.json');
    fs.writeFileSync(file, 'old');
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error('disk');
    });
    expect(() => writeDurableFile(file, 'new')).toThrow('disk');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(calls).not.toContain('rename');
  });
  it('reports an uncertain directory sync and leaves a whole readable checkpoint', () => {
    const file = join(root(), 'state.json');
    vi.mocked(fs.fsyncSync)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('disk');
      });
    expect(() => writeDurableFile(file, 'new')).toThrow('disk');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });
  it('never reclaims a live writer, including a very old lock', () => {
    const file = join(root(), 'state.lock');
    const owner = acquireFileOwnership(file);
    fs.lutimesSync(file, new Date(0), new Date(0));
    expect(() => acquireFileOwnership(file)).toThrow('another writer');
    expect(lockCalls.filter((path) => path.endsWith('.recovery'))).toEqual([]);
    owner.assert();
    owner.release();
  });
});

it('does not dispatch from a visible reservation when directory durability is unconfirmed', async () => {
  const directory = root();
  const f = runFixture(1);
  f.host.executeAgent = vi.fn(f.host.executeAgent);
  const base = createLocalAgenticStateStore(directory);
  const stateStore = {
    async acquire(key: Parameters<typeof base.acquire>[0]) {
      const session = await base.acquire(key);
      return {
        ...session,
        async checkpoint(command: Parameters<typeof session.checkpoint>[0]) {
          if (command.type === 'start_attempt') fault.armed = true;
          return session.checkpoint(command);
        },
      };
    },
  };
  try {
    await expect(
      executeAgenticRun(f.host, f.context(), {
        projectDirectory: directory,
        stateStore,
        run: { id: 'run', mode: 'start' },
      })
    ).rejects.toThrow('unavailable');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(fs.existsSync(join(directory, '.dogsled/model-spec/run-state.json'))).toBe(true);
  } finally {
    fault.armed = false;
    fault.active = false;
  }
});
