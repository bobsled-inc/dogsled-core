'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useState, useCallback, useRef } from 'react';
import { parseStdoutMessage, parseStderrMessage } from '@bobsled-inc/protocol';
import type { StdoutMessage, StderrMessage } from '@bobsled-inc/protocol';
import type { ExplorerBobsledCommand } from './command-links.js';

export interface CommandOutput {
  id: number;
  timestamp: number;
  stream: 'stdout' | 'stderr' | 'exit' | 'error';
  raw: string;
  parsed?: StdoutMessage | StderrMessage;
}

function safeParseProtocol(
  line: string,
  stream: 'stdout' | 'stderr'
): StdoutMessage | StderrMessage | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    const result = stream === 'stdout' ? parseStdoutMessage(value) : parseStderrMessage(value);
    return result ?? undefined;
  } catch {
    return undefined;
  }
}

export interface CommandState {
  running: boolean;
  outputs: CommandOutput[];
  exitCode: number | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

type CommandRequestPayload =
  { command: string; args: string[] } | { sequence: ExplorerBobsledCommand[] };

export function useCommand() {
  const [state, setState] = useState<CommandState>({
    running: false,
    outputs: [],
    exitCode: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
  const idRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const cancelPendingFlushRef = useRef<() => void>(() => {});
  const MAX_OUTPUTS = 1_000;

  const runPayload = useCallback(async (payload: CommandRequestPayload) => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const startedAt = Date.now();
    abortRef.current?.abort();
    cancelPendingFlushRef.current();
    const controller = new AbortController();
    abortRef.current = controller;
    let pendingOutputs: CommandOutput[] = [];
    let flushHandle: number | null = null;

    setState({
      running: true,
      outputs: [],
      exitCode: null,
      error: null,
      startedAt,
      completedAt: null,
    });

    const setStateIfCurrent = (updater: (current: CommandState) => CommandState) => {
      setState((current) => (runId === runIdRef.current ? updater(current) : current));
    };

    const cancelPendingFlush = () => {
      if (flushHandle !== null) {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(flushHandle);
        }
        clearTimeout(flushHandle as unknown as NodeJS.Timeout);
        flushHandle = null;
      }
      pendingOutputs = [];
    };
    cancelPendingFlushRef.current = cancelPendingFlush;

    const flushPendingOutputs = () => {
      flushHandle = null;
      if (pendingOutputs.length === 0) return;
      if (runId !== runIdRef.current) {
        pendingOutputs = [];
        return;
      }
      const batch = pendingOutputs;
      pendingOutputs = [];
      setStateIfCurrent((s) => {
        const next = s.outputs.concat(batch);
        return {
          ...s,
          outputs: next.length > MAX_OUTPUTS ? next.slice(-MAX_OUTPUTS) : next,
        };
      });
    };

    const enqueueOutput = (output: CommandOutput) => {
      if (runId !== runIdRef.current) {
        return;
      }
      pendingOutputs.push(output);
      if (flushHandle === null && typeof requestAnimationFrame !== 'undefined') {
        flushHandle = requestAnimationFrame(flushPendingOutputs);
      } else if (flushHandle === null) {
        flushHandle = setTimeout(flushPendingOutputs, 16) as unknown as number;
      }
    };

    try {
      const response = await explorerFetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = (await response.json()) as { error?: string };
        setStateIfCurrent((s) => ({
          ...s,
          running: false,
          error: err.error ?? 'Request failed',
          completedAt: Date.now(),
        }));
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setStateIfCurrent((s) => ({
          ...s,
          running: false,
          error: 'No response body',
          completedAt: Date.now(),
        }));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const raw = JSON.parse(line.slice(6));
            if (!raw || typeof raw !== 'object' || typeof raw.stream !== 'string') continue;
            const event = raw as {
              stream: string;
              data?: string;
            };

            if (event.stream === 'exit') {
              flushPendingOutputs();
              const parsedExit = Number(event.data ?? '0');
              setStateIfCurrent((s) => ({
                ...s,
                running: false,
                exitCode: Number.isFinite(parsedExit) ? parsedExit : 0,
                completedAt: Date.now(),
              }));
              continue;
            }

            if (event.stream === 'error') {
              flushPendingOutputs();
              setStateIfCurrent((s) => ({
                ...s,
                running: false,
                error: event.data ?? 'Unknown error',
                completedAt: Date.now(),
              }));
              continue;
            }

            const outputStream = event.stream as 'stdout' | 'stderr';
            enqueueOutput({
              id: ++idRef.current,
              timestamp: Date.now(),
              stream: outputStream,
              raw: event.data ?? '',
              parsed: safeParseProtocol(event.data ?? '', outputStream),
            });
          } catch {
            // skip malformed SSE
          }
        }
      }
      flushPendingOutputs();
      // Ensure running is reset if the stream ends without an explicit exit event
      setStateIfCurrent((s) => (s.running ? { ...s, running: false, completedAt: Date.now() } : s));
    } catch (err) {
      flushPendingOutputs();
      if ((err as Error).name !== 'AbortError') {
        setStateIfCurrent((s) => ({
          ...s,
          running: false,
          error: String(err),
          completedAt: Date.now(),
        }));
      } else {
        setStateIfCurrent((s) =>
          s.running ? { ...s, running: false, completedAt: Date.now() } : s
        );
      }
    }
  }, []);

  const run = useCallback(
    async (command: string, args: string[]) => runPayload({ command, args }),
    [runPayload]
  );

  const runSequence = useCallback(
    async (sequence: ExplorerBobsledCommand[]) => runPayload({ sequence }),
    [runPayload]
  );

  const cancelPendingFlush = useCallback(() => {
    cancelPendingFlushRef.current();
  }, []);

  const stop = useCallback(() => {
    cancelPendingFlush();
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current += 1;
    setState((s) => ({ ...s, running: false, completedAt: Date.now() }));
  }, [cancelPendingFlush]);

  const clear = useCallback(() => {
    cancelPendingFlush();
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current += 1;
    setState({
      running: false,
      outputs: [],
      exitCode: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
  }, [cancelPendingFlush]);

  return { ...state, run, runSequence, stop, clear };
}
