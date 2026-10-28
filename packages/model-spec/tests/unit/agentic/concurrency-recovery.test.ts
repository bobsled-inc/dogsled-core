import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalAgenticStateStore } from '../../../src/agentic/index.js';

it('recovers three in-flight reservations after process death without repeating the saved success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentic-concurrent-recovery-'));
  const worker = new URL('./concurrent-recovery-process.ts', import.meta.url);
  async function run(mode: string) {
    const marker = join(directory, mode + '.txt');
    const errorFile = marker + '.stderr';
    const fd = openSync(errorFile, 'w');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker.pathname, directory, mode, marker],
      { stdio: ['ignore', 'ignore', fd], timeout: 240000 }
    );
    try {
      const [status, signal] = await once(child, 'exit');
      return {
        status,
        signal,
        errors: readFileSync(errorFile, 'utf8'),
        calls: readFileSync(marker, 'utf8').trim().split('\n'),
      };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      closeSync(fd);
    }
  }
  try {
    const first = await run('start');
    expect(first.errors).toBe('');
    expect(first.signal).toBe('SIGKILL');
    expect(first.calls).toEqual(['0', '1', '2', '3']);
    const second = await run('resume');
    expect(second.errors).toBe('');
    expect(second.status).toBe(0);
    expect(second.calls).toEqual(['1', '2', '3', '4', '5']);
    const session = await createLocalAgenticStateStore(directory).acquire({
      scope: 'lake',
      model: 'pair_assessments',
      id: 'recovery',
    });
    try {
      const state = await session.read();
      expect(state?.work.filter((w) => w.accepted)).toHaveLength(6);
      expect(state?.charged).toBe(312);
      expect(state?.work.map((w) => w.attempts.length)).toEqual([1, 2, 2, 2, 1, 1]);
    } finally {
      await session.release();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 490000);
