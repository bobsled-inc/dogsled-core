import { spawn } from 'node:child_process';

import type { ClaudeFailureCode } from '@/lib/claude-failure';

interface StreamJsonEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  content_block?: { type?: string; text?: string };
  delta?: { type?: string; text?: string };
}

export interface ClaudeStreamJsonProcessOptions {
  systemPrompt: string;
  userPrompt: string;
  onText: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTurns?: number;
}

export interface ClaudeStreamJsonProcessResult {
  code: number | null;
  signalName: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

export function classifyClaudeFailure(
  message: string,
  options?: { timedOut?: boolean }
): { code: ClaudeFailureCode; message: string; hint?: string } {
  const trimmed = message.trim();

  if (options?.timedOut || /timed out/i.test(trimmed)) {
    return {
      code: 'timeout',
      message: 'Claude took too long to answer.',
      hint: 'Retry in a moment, or shorten the request if it keeps timing out.',
    };
  }

  if (
    /spawn claude ENOENT/i.test(trimmed) ||
    /\bclaude\b[^]*(?:command not found|not found|not recognized)/i.test(trimmed) ||
    /(?:command not found|not found|not recognized)[^]*\bclaude\b/i.test(trimmed)
  ) {
    return {
      code: 'unavailable',
      message: 'Claude CLI is unavailable on this machine.',
      hint: 'Install or expose the `claude` CLI, then retry the assistant.',
    };
  }

  if (
    /unauthori[sz]ed|authentication|authenticate|api key|not logged in|login required|permission denied|access denied/i.test(
      trimmed
    )
  ) {
    return {
      code: 'auth',
      message: 'Claude CLI needs authentication before it can answer here.',
      hint: 'Re-authenticate the CLI, then retry the assistant request.',
    };
  }

  return {
    code: 'runtime',
    message: 'Claude exited before completing the response.',
    hint: 'Retry once. If it keeps failing, inspect the local Claude CLI output.',
  };
}

function appendTextFromLine(line: string, chunks: string[]): void {
  if (!line.trim()) return;
  let event: StreamJsonEvent;
  try {
    event = JSON.parse(line) as StreamJsonEvent;
  } catch {
    return;
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        chunks.push(block.text);
      }
    }
  } else if (event.type === 'content_block_delta' && event.delta?.text) {
    chunks.push(event.delta.text);
  } else if (event.type === 'content_block_start' && event.content_block?.text) {
    chunks.push(event.content_block.text);
  }
}

/**
 * Spawn Claude in stream-json mode and expose only assistant text deltas. The
 * caller decides whether the text is streamed to SSE or parsed as one JSON
 * response.
 */
export function runClaudeStreamJson(
  options: ClaudeStreamJsonProcessOptions
): Promise<ClaudeStreamJsonProcessResult> {
  const { systemPrompt, userPrompt, onText, signal, timeoutMs = 120_000, maxTurns = 1 } = options;
  const safePrompt = userPrompt.replace(/^-/, ' -');

  return new Promise<ClaudeStreamJsonProcessResult>((resolvePromise) => {
    const child = spawn(
      'claude',
      [
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--allowed-tools',
        '',
        '--max-turns',
        String(maxTurns),
        '--system-prompt',
        systemPrompt,
        '-p',
        safePrompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let settled = false;
    const STDERR_MAX = 16_384;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const settle = (result: Omit<ClaudeStreamJsonProcessResult, 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (stdoutBuffer.trim()) {
        const chunks: string[] = [];
        appendTextFromLine(stdoutBuffer, chunks);
        for (const chunk of chunks) onText(chunk);
      }
      signal?.removeEventListener('abort', abortHandler);
      resolvePromise({
        ...result,
        stderr: stderrBuffer.trim(),
        timedOut,
      });
    };

    const abortHandler = () => child.kill();
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const chunks: string[] = [];
        appendTextFromLine(line, chunks);
        for (const text of chunks) onText(text);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuffer.length < STDERR_MAX) {
        stderrBuffer += chunk.toString();
        if (stderrBuffer.length > STDERR_MAX) {
          stderrBuffer = stderrBuffer.slice(0, STDERR_MAX);
        }
      }
    });

    child.on('close', (code, signalName) => {
      settle({ code, signalName });
    });

    child.on('error', (error) => {
      settle({ code: 1, signalName: null, error });
    });
  });
}
