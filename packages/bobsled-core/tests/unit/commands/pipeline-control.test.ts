import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupPipelineSignalForwarding } from '../../../src/commands/pipeline-control.js';

import type { ChildProcess } from 'node:child_process';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pipeline signal forwarding', () => {
  it('escalates to SIGKILL when a child accepted SIGTERM but has not exited', () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') child.killed = true;
      return true;
    });
    const controller = new AbortController();
    const cleanup = setupPipelineSignalForwarding([child], controller.signal);

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    cleanup();
  });

  it('cancels pending SIGKILL escalation when signal forwarding is disposed', () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    const cleanup = setupPipelineSignalForwarding([child], controller.signal);

    controller.abort();
    cleanup();
    vi.advanceTimersByTime(2_000);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('escalates forwarded operating-system signals when a child does not exit', () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const existingListeners = new Set(process.listeners('SIGTERM'));
    const cleanup = setupPipelineSignalForwarding([child]);
    const handler = process
      .listeners('SIGTERM')
      .find((listener) => !existingListeners.has(listener));
    if (!handler) throw new Error('expected SIGTERM forwarding listener');

    handler();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    cleanup();
  });
});
