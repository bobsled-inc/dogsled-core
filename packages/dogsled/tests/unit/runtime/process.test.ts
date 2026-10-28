import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { spawnCommand, waitForProcess } from '../../../src/runtime/process.js';

import type { ChildProcess } from 'node:child_process';

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('spawnCommand', () => {
  it('calls the injected spawn function with the correct arguments', () => {
    const spawn = vi.fn().mockReturnValue(createMockChild());

    spawnCommand(
      { command: 'node', args: ['script.js', '--flag'] },
      { stdio: 'inherit' },
      { spawn }
    );

    expect(spawn).toHaveBeenCalledWith('node', ['script.js', '--flag'], { stdio: 'inherit' });
  });

  it('uses the real spawn when no dependency is injected', () => {
    // Verify the function signature works without dependencies
    expect(() => {
      spawnCommand({ command: 'echo', args: ['test'] }, { stdio: 'ignore' });
    }).not.toThrow();
  });
});

describe('waitForProcess', () => {
  it('resolves with exit code 0 on successful close', async () => {
    const child = createMockChild();
    const promise = waitForProcess(child, 'test CLI');

    child.emit('close', 0);

    await expect(promise).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it('resolves with non-zero exit code on failure', async () => {
    const child = createMockChild();
    const promise = waitForProcess(child, 'test CLI');

    child.emit('close', 5);

    await expect(promise).resolves.toEqual({ exitCode: 5, signal: null });
  });

  it('returns 1 when close event has no exit code', async () => {
    const child = createMockChild();
    const promise = waitForProcess(child, 'test CLI');

    child.emit('close', null);

    await expect(promise).resolves.toEqual({ exitCode: 1, signal: null });
  });

  it('normalizes signal exits while preserving the signal name', async () => {
    const child = createMockChild();
    const promise = waitForProcess(child, 'test CLI');

    child.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toEqual({ exitCode: 143, signal: 'SIGTERM' });
  });

  it('throws when the process emits an error event', async () => {
    const child = createMockChild();
    const promise = waitForProcess(child, 'extract CLI');

    child.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');
  });
});
