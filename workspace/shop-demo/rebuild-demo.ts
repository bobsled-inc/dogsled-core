import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function getWorkspaceRoot(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getRepoRoot(): string {
  return path.resolve(getWorkspaceRoot(), '../..');
}

async function runTrack(args: string[]): Promise<void> {
  const repoRoot = getRepoRoot();
  const entrypoint = path.join(repoRoot, 'packages/bobsled-core/src/index.ts');
  const child = spawn('pnpm', ['exec', 'tsx', entrypoint, 'model', ...args], {
    cwd: getWorkspaceRoot(),
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Command failed: bobsled model ${args.join(' ')}`);
  }
}

async function main(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const runner = path.join(workspaceRoot, 'runner.duckdb.js');
  if (!existsSync(runner)) throw new Error(`Missing runner at ${runner}`);
  await rm(path.join(workspaceRoot, 'demo.db'), { force: true });
  process.stdout.write(`Rebuilding Shop MODEL_SPEC demo in ${workspaceRoot}\n`);
  await runTrack(['seed', 'load', '--dialect', 'duckdb', '--runner', runner, '--json']);
  await runTrack(['run', '--integration', 'duckdb', '--full-refresh']);
  process.stdout.write('Shop demo rebuild complete\n');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
