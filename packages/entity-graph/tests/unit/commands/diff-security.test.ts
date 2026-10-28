import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { registerDiffCommand } from '../../../src/commands/diff.js';
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => {
    throw new Error('invalid ref');
  }),
}));
vi.mock('../../../src/commands/scaffold-utils.js', () => ({
  resolveEntityGraphScaffoldPaths: () => ({
    cwd: '/tmp',
    entityGraphDir: '/tmp/entities',
    entityGraphDirName: 'entities',
  }),
}));
describe('git revision option boundary', () => {
  it('passes a hostile revision after end-of-options and keeps pathspec after the separator', async () => {
    const cli = new Command();
    registerDiffCommand(cli);
    await expect(
      cli.parseAsync(['diff', '--base=--output=/tmp/unwanted'], { from: 'user' })
    ).rejects.toThrow(/invalid ref/);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      [
        'diff',
        '--name-status',
        '-z',
        '--end-of-options',
        '--output=/tmp/unwanted',
        '--',
        'entities',
      ],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });
});
