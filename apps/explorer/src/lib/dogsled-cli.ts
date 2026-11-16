import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB

export class OutputLimitExceededError extends Error {
  readonly stream: 'stdout' | 'stderr';
  readonly limit: number;

  constructor(stream: 'stdout' | 'stderr', limit: number) {
    super(`Command ${stream} exceeded ${limit} bytes`);
    this.stream = stream;
    this.limit = limit;
  }
}

export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface CollectOutputOptions {
  timeoutMs?: number;
  maxBytes?: number;
  killGraceMs?: number;
}

export async function collectOutput(
  child: ChildProcess,
  options: CollectOutputOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitError: OutputLimitExceededError | null = null;
  let timeoutError: CommandTimeoutError | null = null;
  let timer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const scheduleTermination = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    if (forceKillTimer !== null) {
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, killGraceMs);
  };

  const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[]) => (c: Buffer) => {
    if (outputLimitError) return;
    const size = stream === 'stdout' ? (stdoutBytes += c.length) : (stderrBytes += c.length);
    if (size > maxBytes) {
      outputLimitError = new OutputLimitExceededError(stream, maxBytes);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      scheduleTermination();
      return;
    }
    chunks.push(c);
  };

  timer = setTimeout(() => {
    timeoutError = new CommandTimeoutError(timeoutMs);
    scheduleTermination();
  }, timeoutMs);

  try {
    child.stdout?.on('data', collect('stdout', stdoutChunks));
    child.stderr?.on('data', collect('stderr', stderrChunks));

    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (c) => {
        if (timeoutError) {
          reject(timeoutError);
          return;
        }
        if (outputLimitError) {
          reject(outputLimitError);
          return;
        }
        resolve(c ?? 1);
      });
    });

    if (stdoutBytes > maxBytes) throw new OutputLimitExceededError('stdout', maxBytes);
    if (stderrBytes > maxBytes) throw new OutputLimitExceededError('stderr', maxBytes);

    return {
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
      code,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

const MAX_TRAVERSAL_DEPTH = 20;

function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < MAX_TRAVERSAL_DEPTH; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find workspace root (pnpm-workspace.yaml)');
}

function resolveBobsledCli(): { command: string; baseArgs: string[]; root: string } {
  const root = findWorkspaceRoot();

  // Try compiled dist first (preferred — no tsx needed)
  const distPath = path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js');
  if (fs.existsSync(distPath)) {
    return { command: process.execPath, baseArgs: [distPath], root };
  }

  // Fall back to src via npx tsx (avoids static import of tsx)
  const srcPath = path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts');
  if (fs.existsSync(srcPath)) {
    return { command: 'npx', baseArgs: ['tsx', srcPath], root };
  }

  throw new Error('Could not resolve dogsled CLI (neither dist nor src found)');
}

const ALLOWED_COMMANDS = new Set([
  'integrations',
  'extract',
  'load',
  'model',
  'entity-graph',
  'pipeline',
  'setup',
  'runner',
  'learn',
  'examples',
  'init',
  'sdk',
]);

export function validateCommand(command: string): boolean {
  return ALLOWED_COMMANDS.has(command);
}

export interface SpawnBobsledCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function spawnBobsledCommand(
  command: string,
  args: string[],
  options?: SpawnBobsledCommandOptions
): ChildProcess {
  if (!validateCommand(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }

  const { command: bin, baseArgs, root } = resolveBobsledCli();
  const integrationsDir = path.join(root, 'packages', 'integrations', 'integrations');

  return spawn(bin, [...baseArgs, command, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: options?.cwd ?? root,
    env: {
      ...process.env,
      ...options?.env,
      DOGSLED_BUNDLED_INTEGRATIONS_DIR: integrationsDir,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

export function getWorkspaceRoot(): string {
  return findWorkspaceRoot();
}
