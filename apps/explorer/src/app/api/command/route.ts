import { NextResponse } from 'next/server';
import { spawnBobsledCommand, validateCommand } from '../../../lib/bobsled-cli.js';
import { isPlainObject } from '../../../lib/guards.js';
import { shellQuote } from '../../../lib/pipeline-export-content.js';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_PERIOD_MS = 5_000;
const MAX_ARGS = 20;
const MAX_ARG_LENGTH = 500;
const MAX_SEQUENCE_LENGTH = 12;

interface BobsledInvocation {
  command: string;
  args: string[];
}

function extractDbPathValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--db-path') {
      const next = args[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) values.push(next);
      continue;
    }
    if (arg.startsWith('--db-path=')) {
      values.push(arg.slice('--db-path='.length));
    }
  }
  return values;
}

function isSafeDbPath(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) return false;
  return true;
}

function matchesBlockedPrefix(arg: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`));
}

function isBobsledInvocation(value: unknown): value is BobsledInvocation {
  return (
    isPlainObject(value) &&
    typeof value.command === 'string' &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === 'string') &&
    !('sequence' in value)
  );
}

function validateBobsledInvocation(invocation: BobsledInvocation): string | null {
  if (!validateCommand(invocation.command)) {
    return `Invalid or disallowed command: ${invocation.command}`;
  }

  if (
    invocation.args.length > MAX_ARGS ||
    invocation.args.some((arg) => arg.length > MAX_ARG_LENGTH)
  ) {
    return 'Invalid args';
  }

  const BLOCKED_FLAG_PREFIXES = [
    '--output',
    '--env',
    '--force',
    '--api-url',
    '--api-key',
    '--config',
    '--profile',
    '--cwd',
  ] as const;
  if (invocation.args.some((arg) => matchesBlockedPrefix(arg, BLOCKED_FLAG_PREFIXES))) {
    return 'Disallowed flag in args';
  }

  const dbPathValues = extractDbPathValues(invocation.args);
  if (dbPathValues.some((value) => !isSafeDbPath(value))) {
    return 'Invalid --db-path value';
  }

  return null;
}

function formatBobsledInvocation(invocation: BobsledInvocation): string {
  return ['dogsled', invocation.command, ...invocation.args.map(shellQuote)].join(' ');
}

async function streamBobsledInvocation(
  child: ReturnType<typeof spawnBobsledCommand>,
  invocation: BobsledInvocation,
  send: (eventData: Record<string, unknown>) => void,
  showCommandPreamble: boolean
): Promise<number> {
  if (showCommandPreamble) {
    send({ stream: 'stderr', data: `$ ${formatBobsledInvocation(invocation)}` });
  }

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line) send({ stream: 'stdout', data: line });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line) send({ stream: 'stderr', data: line });
    }
  });

  return new Promise<number>((resolve, reject) => {
    child.on('close', (code) => {
      if (stdoutBuf) send({ stream: 'stdout', data: stdoutBuf });
      if (stderrBuf) send({ stream: 'stderr', data: stderrBuf });
      resolve(code ?? 1);
    });

    child.on('error', reject);
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isPlainObject(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  let invocations: BobsledInvocation[];
  if (Array.isArray(body.sequence)) {
    if (body.sequence.length === 0 || body.sequence.length > MAX_SEQUENCE_LENGTH) {
      return NextResponse.json({ error: 'Invalid sequence payload' }, { status: 400 });
    }
    if (!body.sequence.every((entry) => isBobsledInvocation(entry))) {
      return NextResponse.json({ error: 'Invalid sequence payload' }, { status: 400 });
    }
    invocations = body.sequence;
  } else {
    if (
      typeof body.command !== 'string' ||
      (body.args !== undefined && !Array.isArray(body.args))
    ) {
      return NextResponse.json({ error: 'Invalid command payload' }, { status: 400 });
    }
    const args = body.args === undefined ? [] : body.args;
    if (!args.every((arg) => typeof arg === 'string')) {
      return NextResponse.json({ error: 'Invalid command payload' }, { status: 400 });
    }
    const candidate = { command: body.command, args };
    if (!isBobsledInvocation(candidate)) {
      return NextResponse.json({ error: 'Invalid command payload' }, { status: 400 });
    }
    invocations = [candidate];
  }

  for (const invocation of invocations) {
    const validationError = validateBobsledInvocation(invocation);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }

  try {
    const encoder = new TextEncoder();
    let closed = false;
    let activeChild: ReturnType<typeof spawnBobsledCommand> | null = null;
    let stepTimeoutHandle: NodeJS.Timeout | null = null;
    let killGraceHandle: NodeJS.Timeout | null = null;

    const isChildAlive = () =>
      Boolean(activeChild?.killed === false && activeChild?.exitCode === null);

    const clearTimers = () => {
      if (stepTimeoutHandle) {
        clearTimeout(stepTimeoutHandle);
        stepTimeoutHandle = null;
      }
      if (killGraceHandle) {
        clearTimeout(killGraceHandle);
        killGraceHandle = null;
      }
    };

    const terminate = () => {
      if (!isChildAlive()) return;
      const child = activeChild!;
      child.kill('SIGTERM');
      killGraceHandle = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_PERIOD_MS);
    };

    const stream = new ReadableStream({
      async start(controller) {
        const send = (eventData: Record<string, unknown>) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventData)}\n\n`));
        };

        const finish = () => {
          if (closed) return;
          closed = true;
          clearTimers();
          controller.close();
        };

        try {
          const showCommandPreamble = invocations.length > 1;
          for (const invocation of invocations) {
            let timedOut = false;
            if (closed) {
              finish();
              return;
            }

            activeChild = spawnBobsledCommand(invocation.command, invocation.args);
            stepTimeoutHandle = setTimeout(() => {
              timedOut = true;
              send({
                stream: 'error',
                data: `Command timed out after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s`,
              });
              terminate();
            }, COMMAND_TIMEOUT_MS);

            const code = await streamBobsledInvocation(
              activeChild,
              invocation,
              send,
              showCommandPreamble
            ).finally(() => {
              if (stepTimeoutHandle) {
                clearTimeout(stepTimeoutHandle);
                stepTimeoutHandle = null;
              }
              activeChild = null;
            });

            if (timedOut) {
              send({ stream: 'exit', data: '1' });
              finish();
              return;
            }

            if (closed) {
              finish();
              return;
            }

            if (code !== 0) {
              send({ stream: 'exit', data: String(code) });
              finish();
              return;
            }
          }

          send({ stream: 'exit', data: '0' });
          finish();
        } catch (err) {
          send({ stream: 'error', data: String(err) });
          finish();
        }
      },
      cancel() {
        closed = true;
        clearTimers();
        terminate();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
