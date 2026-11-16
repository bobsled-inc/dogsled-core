import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { collectOutput, CommandTimeoutError } from './bobsled-cli';

const spawnedChildren: ChildProcess[] = [];

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
}

function spawnChild(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedChildren.push(child);
  return child;
}

afterEach(async () => {
  await Promise.all(
    spawnedChildren.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGKILL');
      await waitForClose(child);
    })
  );
});

describe('collectOutput', () => {
  it('rejects with a timeout error when a child ignores SIGTERM', async () => {
    const child = spawnChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");

    await expect(collectOutput(child, { timeoutMs: 20, killGraceMs: 20 })).rejects.toBeInstanceOf(
      CommandTimeoutError
    );
  });
});
