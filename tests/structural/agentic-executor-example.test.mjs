import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('runs the separate executor tests through Dogsled public exports', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dogsled-executor-test-'));
  try {
    mkdirSync(path.join(directory, 'node_modules/@bobsled-inc'), { recursive: true });
    symlinkSync(
      path.join(root, 'packages/dogsled'),
      path.join(directory, 'node_modules/@bobsled-inc/dogsled'),
      'dir'
    );
    symlinkSync(
      path.join(root, 'packages/dogsled/node_modules/zod'),
      path.join(directory, 'node_modules/zod'),
      'dir'
    );
    for (const file of ['executor.mjs', 'executor.test.mjs']) {
      copyFileSync(path.join(root, 'examples/agentic-pairs', file), path.join(directory, file));
    }
    const output = execFileSync(process.execPath, ['--test', 'executor.test.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(output).toMatch(/(?:fail 0|fail\s+0)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
