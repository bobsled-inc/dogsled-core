import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommand, type CommandOutput, type CommandState } from './use-command';

interface CommandHarnessValue extends CommandState {
  run: (command: string, args: string[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

interface Snapshot {
  running: boolean;
  outputs: string[];
  exitCode: number | null;
  error: string | null;
  completedAt: number | null;
}

function Harness(props: {
  commandRef: { current: CommandHarnessValue | null };
  snapshots: Snapshot[];
}) {
  const command = useCommand();
  props.commandRef.current = command;
  props.snapshots.push({
    running: command.running,
    outputs: command.outputs.map((output: CommandOutput) => output.raw),
    exitCode: command.exitCode,
    error: command.error,
    completedAt: command.completedAt,
  });
  return null;
}

function createSseController() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });

  return {
    response: new Response(stream),
    pushEvent(event: { stream: string; data?: string }) {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller?.close();
    },
  };
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useCommand', () => {
  const originalFetch = globalThis.fetch;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalConsoleError = console.error;
  const originalActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    vi.useRealTimers();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0)) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return;
      }

      originalConsoleError(...args);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    vi.restoreAllMocks();
  });

  it('ignores stale output after a newer run starts and only finalizes once', async () => {
    let tick = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++tick);
    const controllers: ReturnType<typeof createSseController>[] = [];

    globalThis.fetch = vi.fn(async () => {
      const next = createSseController();
      controllers.push(next);
      return next.response;
    }) as typeof fetch;

    const commandRef = { current: null as CommandHarnessValue | null };
    const snapshots: Snapshot[] = [];
    let renderer: { unmount: () => void };

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness, { commandRef, snapshots }));
    });

    let firstRun!: Promise<void>;
    await act(async () => {
      firstRun = commandRef.current!.run('extract', ['github']);
    });
    await flushTimers();

    let secondRun!: Promise<void>;
    await act(async () => {
      secondRun = commandRef.current!.run('extract', ['stripe']);
    });
    await flushTimers();

    controllers[0]?.pushEvent({ stream: 'stdout', data: 'stale output' });
    controllers[0]?.pushEvent({ stream: 'exit', data: '1' });
    controllers[0]?.close();

    controllers[1]?.pushEvent({ stream: 'stdout', data: 'current output' });
    await flushTimers();
    controllers[1]?.pushEvent({ stream: 'exit', data: '0' });
    controllers[1]?.close();

    await act(async () => {
      await Promise.all([firstRun, secondRun]);
    });
    await flushTimers();

    expect(commandRef.current).not.toBeNull();
    expect(commandRef.current?.outputs.map((output) => output.raw)).toEqual(['current output']);
    expect(commandRef.current?.exitCode).toBe(0);
    expect(commandRef.current?.error).toBeNull();
    expect(commandRef.current?.running).toBe(false);
    expect(commandRef.current?.completedAt).not.toBeNull();

    const completionTransitions = snapshots.reduce((count, snapshot, index) => {
      if (index === 0) {
        return snapshot.completedAt === null ? count : count + 1;
      }

      const previous = snapshots[index - 1];
      if (!previous) {
        return count;
      }

      return previous.completedAt !== snapshot.completedAt && snapshot.completedAt !== null
        ? count + 1
        : count;
    }, 0);

    expect(snapshots.some((snapshot) => snapshot.outputs.includes('stale output'))).toBe(false);
    expect(completionTransitions).toBe(1);

    await act(async () => {
      renderer!.unmount();
    });
    clock.mockRestore();
  });
});
