#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const packageName = '@bobsled-inc/bobsled-core';
const distEntrypoint = path.join(packageRoot, 'dist', 'index.js');

if (!existsSync(distEntrypoint)) {
  const buildResult = spawnSync(
    'pnpm',
    ['--dir', repoRoot, '--filter', `${packageName}...`, 'build'],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );

  if (buildResult.error) {
    throw buildResult.error;
  }

  if (buildResult.status !== 0) {
    process.exitCode = buildResult.status ?? (buildResult.signal ? 1 : 0);
  }
}

if (process.exitCode) {
  // Preserve the build failure exit code and skip executing a partial artifact.
} else if (!existsSync(distEntrypoint)) {
  process.stderr.write(
    `Unable to find a built CLI entrypoint for ${packageName} at ${distEntrypoint}.\n`
  );
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [distEntrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  // Forward stop signals so a signal sent only to this launcher (kill, CI cancel,
  // container stop) still reaches the CLI, which cancels and saves its work.
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward);
  const [status, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, closeSignal) => resolve([code, closeSignal]));
  });

  process.exitCode = status ?? (signal ? 1 : 0);
}
